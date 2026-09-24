// Entry point: load config + previous state from the Sheet, build the stream
// list from iptv-org, check every stream, then save to the Sheet and write
// results.json for the dashboard.
//
//   node checker/index.js                      (GitHub Actions, with secrets)
//   COUNTRIES=VN LEVEL=3 node checker/index.js (local run, no Sheet;
//                                               LOCAL_MODE=1 inside Actions)

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { callBridge, fromDataTable, toDataTable, toStreamsTable } from './bridge.js';
import { checkStream } from './check.js';
import { API_BASE, buildList, configHash, fetchSource, normalizeConfig } from './source.js';
import { LEVEL_LABELS, STATUS_LABELS, STATUS_ORDER, countByStatus, nextState, reasonFor } from './status.js';
import { formatDuration, hostOf, maskUrl, runPool } from './util.js';

const BUDGET_MS = 150 * 60_000;
const BIG_HOST = 100; // hosts with more links than this get more connections
const BREAKER_AFTER = 3; // connection failures in a row before a host is skipped
const SOURCE_DROP_LIMIT = 0.5;

const log = (...args) => console.log('[IPTV]', ...args);

function isConnectionFailure(res) {
  if (res.ok) return false;
  if (res.code === 'DNS_ERROR' || res.code === 'TLS_ERROR') return true;
  if (res.code === 'CONNECTION_ERROR') return res.phase !== 'response';
  return res.code === 'TIMEOUT' && res.phase === 'connect';
}

export async function runChecks(items, level, { budgetEndsAt = Infinity, checkOptions = {}, concurrency } = {}) {
  const heavy = level === '4a' || level === '4b';
  const breaker = new Map();
  const results = new Map();
  await runPool(items, {
    concurrency: concurrency ?? (heavy ? 60 : 150),
    keyOf: (it) => it.host,
    hostLimit: (_host, count) => (count > BIG_HOST ? 9 : 3),
    shouldStop: () => Date.now() >= budgetEndsAt,
    worker: async (it) => {
      const b = breaker.get(it.host);
      if (b && b.count >= BREAKER_AFTER) {
        results.set(it.url, { ...b.last, ms: 0, retried: false, skipped: true, at: Date.now() });
        return;
      }
      const res = await checkStream(it, level, { ...checkOptions, allowRetry: it.prev?.status !== 'OFFLINE' });
      res.at = Date.now();
      results.set(it.url, res);
      if (isConnectionFailure(res)) {
        const s = breaker.get(it.host) || { count: 0 };
        s.count++;
        s.last = res;
        breaker.set(it.host, s);
      } else {
        breaker.delete(it.host);
      }
    },
  });
  return results;
}

// ---- Local mode (no Sheet): config from env, state in OUT_DIR/state.json ----

async function loadLocal(env, outDir) {
  let previous = { data: null, lastRun: {} };
  try {
    previous = JSON.parse(await readFile(path.join(outDir, 'state.json'), 'utf8'));
  } catch {
    // first local run
  }
  return {
    config: { countries: env.COUNTRIES, languages: env.LANGUAGES, categories: env.CATEGORIES, level: env.LEVEL },
    exclude: String(env.EXCLUDE || '').split(/[\s,]+/).filter(Boolean),
    data: previous.data,
    lastRun: previous.lastRun || {},
  };
}

async function saveLocal(outDir, payload) {
  await writeFile(path.join(outDir, 'state.json'), JSON.stringify({
    data: payload.data,
    lastRun: { sourceCount: payload.summary.sourceCount, configHash: payload.summary.configHash },
  }));
}

function dashboardUrl(env) {
  const [owner, repo] = String(env.GITHUB_REPOSITORY || '').split('/');
  return owner && repo ? `https://${owner.toLowerCase()}.github.io/${repo}/` : '';
}

function scopeText(config) {
  const part = (label, list) => `${label}: ${list.length ? list.join(', ') : 'tất cả'}`;
  return [part('Quốc gia', config.countries), part('Ngôn ngữ', config.languages), part('Thể loại', config.categories)].join(' · ');
}

/**
 * The whole run. `io` lets tests replace the Sheet and the clock-sensitive bits.
 * Returns { rows, summary, saveError }.
 */
export async function runMonitor({ env = process.env, checkOptions = {}, io = {} } = {}) {
  const startedAt = Date.now();
  const outDir = env.OUT_DIR || 'dist';
  await mkdir(outDir, { recursive: true });

  const bridgeUrl = env.SHEET_BRIDGE_URL;
  if (!bridgeUrl && env.GITHUB_ACTIONS === 'true' && env.LOCAL_MODE !== '1') {
    throw new Error('Thiếu secret SHEET_BRIDGE_URL / SHEET_BRIDGE_TOKEN (xem docs/setup.md)');
  }
  const bridgeToken = String(env.SHEET_BRIDGE_TOKEN || '').trim(); // pasted secrets often carry a newline
  const load = io.load || (bridgeUrl
    ? () => callBridge(bridgeUrl.trim(), bridgeToken, 'load')
    : () => loadLocal(env, outDir));
  const save = io.save || (bridgeUrl
    ? (payload) => callBridge(bridgeUrl.trim(), bridgeToken, 'save', payload)
    : (payload) => saveLocal(outDir, payload));

  // 1. Config + previous state
  const loaded = await load();
  const config = normalizeConfig(loaded.config);
  const exclude = new Set((loaded.exclude || []).map((u) => String(u).trim()).filter(Boolean));
  const previousRows = fromDataTable(loaded.data);
  const previousByUrl = new Map(previousRows.map((r) => [r.url, r]));
  const lastRun = loaded.lastRun || {};
  const hash = configHash(config, exclude);
  log(`Mức kiểm tra: ${config.level} | ${scopeText(config)} | Trạng thái cũ: ${previousRows.length} link`);

  // 2–3. Source → filtered list, or the previous list if the source looks broken
  let list;
  let sourceStatus = 'OK';
  let sourceMessage = '';
  let sourceCount = lastRun.sourceCount || 0;
  try {
    const source = await (io.fetchSource || fetchSource)(env.SOURCE_BASE || API_BASE);
    list = buildList(source, config, exclude);
    if (lastRun.configHash === hash && lastRun.sourceCount > 0 && list.length < lastRun.sourceCount * SOURCE_DROP_LIMIT) {
      throw new Error(`số link giảm bất thường: ${list.length} so với ${lastRun.sourceCount} lần trước`);
    }
    sourceCount = list.length;
  } catch (err) {
    sourceStatus = 'SOURCE_ERROR';
    sourceMessage = err.message;
    log(`SOURCE_ERROR: ${sourceMessage} → dùng lại danh sách cũ`);
    list = previousRows.filter((r) => !exclude.has(r.url));
  }

  // 4. Merge with previous state; least recently checked first
  const items = list.map((s) => ({ ...s, host: hostOf(s.url) || s.url, prev: previousByUrl.get(s.url) }));
  items.sort((a, b) => (a.prev?.lastChecked || 0) - (b.prev?.lastChecked || 0));
  log(`Nguồn: ${sourceStatus} | ${items.length} link cần kiểm tra`);

  // 5. Check
  const budgetMs = Number(env.BUDGET_MIN) > 0 ? Number(env.BUDGET_MIN) * 60_000 : BUDGET_MS;
  const results = await runChecks(items, config.level, { budgetEndsAt: startedAt + budgetMs, checkOptions });

  // 6. New state
  const rows = items.map((it) => {
    const { prev, host, ...meta } = it;
    return { ...meta, ...nextState(prev, results.get(it.url)) };
  });
  const counts = countByStatus(rows);
  const unchecked = items.length - results.size;
  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  const dashboard = dashboardUrl(env);

  const summary = {
    runAt: startedAt,
    sourceStatus,
    sourceMessage,
    sourceCount,
    configHash: hash,
    level: config.level,
    total: rows.length,
    counts,
    unchecked,
    durationSec,
    lines: [
      ['Nguồn dữ liệu', sourceStatus === 'OK' ? 'Bình thường' : `Lỗi nguồn, đang dùng danh sách cũ (${sourceMessage})`],
      ['Mức kiểm tra', LEVEL_LABELS[config.level]],
      ['Phạm vi', scopeText(config)],
      ['Tổng số link', rows.length],
      ...STATUS_ORDER.map((s) => [STATUS_LABELS[s], counts[s]]),
      ['Thời gian chạy', formatDuration(durationSec)],
      ['Chưa kịp kiểm tra', unchecked],
      ['Dashboard', dashboard],
    ],
  };

  // 7. Save to the Sheet (failure is reported after publishing)
  let saveError = null;
  try {
    await save({ data: toDataTable(rows), streams: toStreamsTable(rows), summary });
  } catch (err) {
    saveError = err;
  }

  // 8. results.json for the dashboard (public: no referrer / user agent)
  const publicData = {
    generatedAt: Date.now(),
    startedAt,
    sourceStatus,
    sourceMessage,
    level: config.level,
    levelLabel: LEVEL_LABELS[config.level],
    scope: scopeText(config),
    total: rows.length,
    counts,
    unchecked,
    durationSec,
    // The dashboard calls this Apps Script web app for "Chạy ngay", run status and the
    // schedule. Knowing the URL is not enough to read the Sheet (load/save need the
    // bridge token; run/schedule need the operator code).
    ...(bridgeUrl ? { controlUrl: bridgeUrl.trim() } : {}),
    streams: rows.map((r) => ({
      title: r.title,
      channel: r.channel,
      country: r.country,
      countryName: r.countryName,
      flag: r.flag,
      url: r.url,
      status: r.status,
      reason: reasonFor(r.status, r.error),
      lastChecked: r.lastChecked || 0,
      labels: r.labels,
    })),
  };
  await writeFile(path.join(outDir, 'results.json'), JSON.stringify(publicData));

  // 9. Logs (masked URLs only)
  log(`Xong trong ${formatDuration(durationSec)} | ${STATUS_ORDER.map((s) => `${STATUS_LABELS[s]} ${counts[s]}`).join(' · ')}`);
  const errors = {};
  for (const r of rows) if (r.error && r.lastChecked >= startedAt) errors[r.error] = (errors[r.error] || 0) + 1;
  const topErrors = Object.entries(errors).sort((a, b) => b[1] - a[1]);
  if (topErrors.length) log(`Lỗi: ${topErrors.map(([k, v]) => `${k} ×${v}`).join(', ')}`);
  for (const r of rows.filter((x) => x.error).slice(0, 10)) log(`  ${r.error.padEnd(18)} ${maskUrl(r.url)}`);
  if (env.GITHUB_STEP_SUMMARY) {
    const md = [
      `### IPTV Monitor — ${sourceStatus === 'OK' ? 'nguồn bình thường' : '⚠️ SOURCE_ERROR'}`,
      '',
      `Mức kiểm tra **${LEVEL_LABELS[config.level]}** · ${scopeText(config)} · ${formatDuration(durationSec)}`,
      '',
      '| Trạng thái | Số link |', '|---|---|',
      ...STATUS_ORDER.map((s) => `| ${STATUS_LABELS[s]} | ${counts[s]} |`),
      `| **Tổng** | **${rows.length}** |`,
      '',
      topErrors.length ? `Lỗi: ${topErrors.map(([k, v]) => `\`${k}\` ×${v}`).join(', ')}` : '',
      saveError ? `\n❌ Không ghi được Google Sheet: ${saveError.message}` : '',
    ].join('\n');
    await appendFile(env.GITHUB_STEP_SUMMARY, `${md}\n`);
  }

  return { rows, summary, saveError };
}

async function main() {
  try {
    const { saveError } = await runMonitor();
    if (saveError) {
      console.error(`[IPTV] Không ghi được Google Sheet: ${saveError.message}`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`[IPTV] Lỗi: ${err.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
