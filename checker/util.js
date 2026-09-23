// Small shared helpers: URL masking for logs, time formatting, and the
// host-aware concurrency pool used to run stream checks.

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Logs must never show query strings: they often carry tokens.
export function maskUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}${u.search ? '?…' : ''}`;
  } catch {
    return '(link không hợp lệ)';
  }
}

export function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

const VN_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ho_Chi_Minh',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

// 1727061420000 → "23/09/2026 10:17" (giờ Việt Nam)
export function formatVnTime(ms) {
  return ms ? VN_TIME.format(new Date(ms)).replace(',', '') : '';
}

export function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m} phút ${s} giây` : `${s} giây`;
}

/**
 * Runs `worker(item)` for every item with two limits: at most `concurrency`
 * in flight overall, and at most `hostLimit(host, count)` in flight per host.
 * Hosts with the most items start first so a big host does not become a long
 * tail at the end. Items keep their given order inside each host.
 * Once `shouldStop()` returns true no new work starts; running work finishes.
 */
export function runPool(items, { concurrency, keyOf, hostLimit, shouldStop = () => false, worker }) {
  const queues = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(item);
  }
  let hosts = [...queues.keys()].sort((a, b) => queues.get(b).length - queues.get(a).length);
  const state = new Map(hosts.map((h) => [h, { next: 0, running: 0, limit: hostLimit(h, queues.get(h).length) }]));
  let active = 0;
  let stopped = false;

  return new Promise((resolve) => {
    const pump = () => {
      if (!stopped && shouldStop()) stopped = true;
      if (!stopped) {
        for (const h of hosts) {
          if (active >= concurrency) break;
          const q = queues.get(h);
          const st = state.get(h);
          while (st.next < q.length && st.running < st.limit && active < concurrency) {
            const item = q[st.next++];
            st.running++;
            active++;
            Promise.resolve()
              .then(() => worker(item))
              .catch(() => {})
              .finally(() => {
                st.running--;
                active--;
                pump();
              });
          }
        }
        hosts = hosts.filter((h) => state.get(h).next < queues.get(h).length);
      }
      if (active === 0) resolve();
    };
    pump();
  });
}
