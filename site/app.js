// Dashboard: reads results.json (written by GitHub Actions) and renders
// summary metrics + a filterable table. All data goes through textContent.

(function () {
  'use strict';

  // tone: the only place status colours come from (ok / warn / err / neutral)
  const STATUS = {
    OFFLINE: { label: 'Không hoạt động', tone: 'err', rank: 0 },
    FAILING: { label: 'Đang lỗi', tone: 'warn', rank: 1 },
    SLOW: { label: 'Chậm', tone: 'warn', rank: 2 },
    UNSUPPORTED: { label: 'Không kiểm tra được', tone: 'neutral', rank: 3 },
    PENDING: { label: 'Chờ kiểm tra', tone: 'neutral', rank: 4 },
    ONLINE: { label: 'Hoạt động', tone: 'ok', rank: 5 },
  };
  // Summary metrics. "Cảnh báo" groups Chậm + Đang lỗi (both shown in its sub-line);
  // Không kiểm tra được / Chờ kiểm tra stay available as the "Khác" filter.
  const METRICS = [
    { key: 'ALL', label: 'Tổng số link' },
    { key: 'ONLINE', label: 'Hoạt động', tone: 'ok', statuses: ['ONLINE'] },
    { key: 'WARNING', label: 'Cảnh báo', tone: 'warn', statuses: ['SLOW', 'FAILING'] },
    { key: 'OFFLINE', label: 'Không hoạt động', tone: 'err', statuses: ['OFFLINE'] },
  ];
  const GROUPS = { WARNING: ['SLOW', 'FAILING'], OTHER: ['UNSUPPORTED', 'PENDING'] };
  const LABEL_NAMES = { 'Geo-blocked': 'Giới hạn quốc gia', 'Not 24/7': 'Không phát 24/7' };
  const PAGE = 200;
  const NO_COUNTRY = 'NONE';
  const STATUS_FILTERS = ['ALL', 'ONLINE', 'WARNING', 'SLOW', 'FAILING', 'OFFLINE', 'OTHER'];
  const REFRESH_MS = 10 * 60 * 1000;

  const $ = (id) => document.getElementById(id);
  const collator = new Intl.Collator('vi', { sensitivity: 'base' });
  const timeFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const numFmt = new Intl.NumberFormat('vi-VN');

  const state = { data: null, q: '', status: 'ALL', country: 'ALL', sort: 'status', dir: 1, shown: PAGE, loading: false };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const COPY_ICON = 'M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z';

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function formatTime(ms) {
    return ms ? timeFmt.format(new Date(ms)).replace(',', '') : '—';
  }

  function formatDuration(sec) {
    const total = Math.round(sec);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m ? `${m} phút ${s} giây` : `${s} giây`;
  }

  function icon(path) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', path);
    svg.append(p);
    return svg;
  }

  function ago(ms) {
    const min = Math.round((Date.now() - ms) / 60000);
    if (min < 1) return 'vừa xong';
    if (min < 60) return `${min} phút trước`;
    const h = Math.round(min / 60);
    return h < 48 ? `${h} giờ trước` : `${Math.round(h / 24)} ngày trước`;
  }

  function pill(status) {
    const s = STATUS[status] || STATUS.PENDING;
    const wrap = el('span', `pill tone-${s.tone}`);
    const dot = el('span', 'dot');
    dot.setAttribute('aria-hidden', 'true');
    wrap.append(dot, el('span', null, s.label));
    return wrap;
  }

  function matchesStatus(row) {
    if (state.status === 'ALL') return true;
    if (GROUPS[state.status]) return GROUPS[state.status].includes(row.status);
    return row.status === state.status;
  }

  const filtersActive = () => state.status !== 'ALL' || state.country !== 'ALL' || state.q.trim() !== '';

  function clearFilters() {
    state.q = '';
    state.status = 'ALL';
    state.country = 'ALL';
    state.shown = PAGE;
    $('q').value = '';
    $('status').value = 'ALL';
    $('country').value = 'ALL';
    render();
  }

  function matchesCountry(row) {
    if (state.country === 'ALL') return true;
    if (state.country === NO_COUNTRY) return !row.country;
    return row.country === state.country;
  }

  function filtered() {
    const q = state.q.trim().toLowerCase();
    const rows = state.data.streams.filter((r) =>
      matchesStatus(r) &&
      matchesCountry(r) &&
      (!q || r.title.toLowerCase().includes(q) || r.channel.toLowerCase().includes(q) || r.url.toLowerCase().includes(q)));
    const key = state.sort;
    const dir = state.dir;
    rows.sort((a, b) => {
      let d;
      if (key === 'status') d = (STATUS[a.status]?.rank ?? 9) - (STATUS[b.status]?.rank ?? 9);
      else if (key === 'lastChecked') d = (a.lastChecked || 0) - (b.lastChecked || 0);
      else d = collator.compare(a[key] || '', b[key] || '');
      return d * dir || collator.compare(a.title, b.title);
    });
    return rows;
  }

  function renderHeader(data) {
    const updated = $('updated');
    updated.classList.remove('is-error');
    updated.textContent = `Cập nhật lúc ${formatTime(data.generatedAt)} · ${ago(data.generatedAt)}`;
    const context = $('context');
    context.replaceChildren();
    const parts = [`Mức kiểm tra: ${data.levelLabel}`, ...(data.scope ? String(data.scope).split(' · ') : [])];
    if (data.durationSec) parts.push(`Thời gian chạy: ${formatDuration(data.durationSec)}`);
    for (const part of parts) context.append(el('span', 'context-item', part));
    const banner = $('banner');
    if (data.sourceStatus === 'SOURCE_ERROR') {
      banner.textContent = 'Không tải được danh sách kênh mới từ iptv-org, đang kiểm tra theo danh sách cũ.';
      banner.hidden = false;
    } else if (data.unchecked > 0) {
      banner.textContent = `${numFmt.format(data.unchecked)} link chưa kịp kiểm tra trong lần chạy này, sẽ được kiểm tra ở lần sau.`;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  // Metrics follow the country filter, so "Việt Nam" shows Việt Nam's numbers.
  function renderMetrics(data) {
    const box = $('metrics');
    box.replaceChildren();
    const scope = data.streams.filter(matchesCountry);
    const counts = {};
    for (const r of scope) counts[r.status] = (counts[r.status] || 0) + 1;
    const total = scope.length;
    const sum = (list) => list.reduce((n, st) => n + (counts[st] || 0), 0);
    const pct = (n) => (total ? `${Math.round((n / total) * 100)}%` : '0%');
    const countryLabel = state.country === 'ALL' ? 'Tất cả quốc gia'
      : state.country === NO_COUNTRY ? 'Không rõ quốc gia' : ($('country').selectedOptions[0]?.textContent || '').replace(/\s*\([\d.,]+\)$/, '');
    for (const m of METRICS) {
      const value = m.statuses ? sum(m.statuses) : total;
      let sub;
      if (m.key === 'ALL') {
        const other = sum(GROUPS.OTHER);
        sub = other ? `${countryLabel} · Khác ${numFmt.format(other)}` : countryLabel;
      } else if (m.key === 'WARNING') {
        sub = `Chậm ${numFmt.format(counts.SLOW || 0)} · Đang lỗi ${numFmt.format(counts.FAILING || 0)}`;
      } else {
        sub = `${pct(value)} tổng số`;
      }
      const active = state.status === m.key;
      const btn = el('button', `metric${active ? ' is-active' : ''}`);
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(active));
      const head = el('span', 'metric-label');
      if (m.tone) {
        const dot = el('span', `dot tone-${m.tone}`);
        dot.setAttribute('aria-hidden', 'true');
        head.append(dot);
      }
      head.append(document.createTextNode(m.label));
      btn.append(head, el('span', 'metric-value', numFmt.format(value)), el('span', 'metric-sub', sub));
      btn.addEventListener('click', () => {
        state.status = state.status === m.key && m.key !== 'ALL' ? 'ALL' : m.key;
        $('status').value = state.status;
        state.shown = PAGE;
        render();
      });
      box.append(btn);
    }
  }

  function renderMetricSkeleton() {
    const box = $('metrics');
    box.replaceChildren(...METRICS.map((m) => {
      const card = el('div', 'metric is-loading');
      card.append(el('span', 'metric-label', m.label), el('span', 'skeleton skeleton-value'), el('span', 'skeleton skeleton-sub'));
      return card;
    }));
  }

  function fillSelects(data) {
    const status = $('status');
    status.replaceChildren(
      new Option('Tất cả trạng thái', 'ALL'),
      new Option(STATUS.ONLINE.label, 'ONLINE'),
      new Option('Cảnh báo (chậm + đang lỗi)', 'WARNING'),
      new Option(STATUS.SLOW.label, 'SLOW'),
      new Option(STATUS.FAILING.label, 'FAILING'),
      new Option(STATUS.OFFLINE.label, 'OFFLINE'),
      new Option('Khác (không kiểm tra được / chờ)', 'OTHER'),
    );
    status.value = state.status;

    const countries = new Map();
    let unknown = 0;
    for (const r of data.streams) {
      if (!r.country) {
        unknown++;
        continue;
      }
      const c = countries.get(r.country)
        || { label: [r.flag, r.countryName].filter(Boolean).join(' ') || r.country, name: r.countryName || r.country, n: 0 };
      c.n++;
      countries.set(r.country, c);
    }
    const country = $('country');
    country.replaceChildren(new Option(`Tất cả quốc gia (${numFmt.format(data.streams.length)})`, 'ALL'));
    [...countries.entries()].sort((a, b) => collator.compare(a[1].name, b[1].name))
      .forEach(([code, c]) => country.append(new Option(`${c.label} (${numFmt.format(c.n)})`, code)));
    if (unknown) country.append(new Option(`Không rõ quốc gia (${numFmt.format(unknown)})`, NO_COUNTRY));
    const known = state.country === 'ALL' || countries.has(state.country) || (state.country === NO_COUNTRY && unknown > 0);
    if (!known) state.country = 'ALL';
    country.value = state.country;
  }

  // Filters live in the page link (#country=VN&status=OFFLINE) so a filtered
  // view can be shared and survives the automatic refresh.
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    state.country = (p.get('country') || 'ALL').toUpperCase();
    const status = (p.get('status') || 'ALL').toUpperCase();
    state.status = STATUS_FILTERS.includes(status) ? status : 'ALL';
    state.q = p.get('q') || '';
    $('q').value = state.q;
  }

  function writeHash() {
    const p = new URLSearchParams();
    if (state.country !== 'ALL') p.set('country', state.country);
    if (state.status !== 'ALL') p.set('status', state.status);
    if (state.q.trim()) p.set('q', state.q.trim());
    const hash = p.toString();
    if (hash !== location.hash.slice(1)) history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
  }

  function copy(text) {
    const done = () => toast('Đã sao chép link');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }
  function fallbackCopy(text, done) {
    const ta = el('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch { toast('Không sao chép được, hãy chọn và copy thủ công'); }
    ta.remove();
  }
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
  }

  function row(r) {
    const tr = el('tr');

    const name = el('td', 'c-name');
    name.dataset.label = 'Tên kênh';
    name.append(el('div', 'title', r.title));
    const sub = el('div', 'sub');
    if (r.channel) sub.append(el('span', 'channel', r.channel));
    for (const l of r.labels || []) sub.append(el('span', 'chip', LABEL_NAMES[l] || l));
    if (sub.childNodes.length) name.append(sub);

    const country = el('td', 'c-country', [r.flag, r.countryName].filter(Boolean).join(' ') || '—');
    country.dataset.label = 'Quốc gia';

    const status = el('td', 'c-status');
    status.dataset.label = 'Trạng thái';
    status.append(pill(r.status));
    if (r.reason) status.append(el('div', 'reason', r.reason));

    const time = el('td', 'c-time', formatTime(r.lastChecked));
    time.dataset.label = 'Kiểm tra lúc';

    const link = el('td', 'c-link');
    link.dataset.label = 'Link';
    const url = el('span', 'url', r.url);
    url.title = r.url;
    const btn = el('button', 'icon-btn icon-btn-sm copy');
    btn.type = 'button';
    btn.title = 'Sao chép link';
    btn.setAttribute('aria-label', `Sao chép link ${r.title}`);
    btn.append(icon(COPY_ICON));
    btn.addEventListener('click', () => copy(r.url));
    const box = el('div', 'linkbox');
    box.append(url, btn);
    link.append(box);

    tr.append(name, country, status, time, link);
    return tr;
  }

  function skeletonRows(n) {
    return Array.from({ length: n }, () => {
      const tr = el('tr', 'is-loading');
      for (let i = 0; i < 5; i++) {
        const td = el('td');
        td.append(el('span', `skeleton skeleton-cell${i === 0 ? ' wide' : ''}`));
        tr.append(td);
      }
      return tr;
    });
  }

  // One place decides which block of the table card is visible. Filters stay
  // disabled until there is data to filter (render() needs state.data).
  function showView(view) {
    const ready = view === 'table' || view === 'empty';
    for (const id of ['q', 'status', 'country']) $(id).disabled = !ready;
    $('rows').closest('.table-card').dataset.view = view;
    $('rows').closest('.table-scroll').hidden = view === 'error';
    $('empty').hidden = view !== 'empty';
    $('error').hidden = view !== 'error';
    $('table-foot').hidden = view !== 'table';
  }

  function render() {
    const data = state.data;
    writeHash();
    renderMetrics(data);
    const rows = filtered();
    const body = $('rows');
    const visible = rows.slice(0, state.shown);
    body.replaceChildren(...visible.map(row));
    $('count').textContent = `${numFmt.format(rows.length)} kênh`;
    $('clear').hidden = !filtersActive();
    showView(rows.length ? 'table' : 'empty');
    $('shown').textContent = `Hiển thị ${numFmt.format(visible.length)} / ${numFmt.format(rows.length)} kênh`;
    const more = $('more');
    const rest = rows.length - state.shown;
    more.hidden = rest <= 0;
    more.textContent = `Hiện thêm ${numFmt.format(Math.min(PAGE, rest))} kênh`;
    document.querySelectorAll('th button[data-sort]').forEach((b) => {
      const th = b.parentElement;
      if (b.dataset.sort === state.sort) th.setAttribute('aria-sort', state.dir > 0 ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
    });
  }

  function showError(notPublished) {
    renderMetricSkeleton();
    $('metrics').classList.add('is-empty');
    $('updated').textContent = notPublished ? 'Chưa có dữ liệu' : 'Không tải được dữ liệu';
    $('updated').classList.add('is-error');
    $('error-title').textContent = notPublished ? 'Chưa có dữ liệu.' : 'Không tải được dữ liệu.';
    $('error-text').textContent = notPublished
      ? 'Nếu vừa cài đặt, hãy đợi lần kiểm tra đầu tiên chạy xong rồi tải lại trang.'
      : 'Kiểm tra kết nối mạng rồi thử lại.';
    $('count').textContent = '';
    showView('error');
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    $('refresh').disabled = true;
    $('refresh').classList.add('is-spinning');
    if (!state.data) {
      renderMetricSkeleton();
      $('rows').replaceChildren(...skeletonRows(8));
      showView('loading');
    }
    try {
      const res = await fetch(`results.json?v=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw Object.assign(new Error(String(res.status)), { status: res.status });
      const data = await res.json();
      data.streams = data.streams || [];
      state.data = data;
      $('metrics').classList.remove('is-empty');
      renderHeader(data);
      fillSelects(data);
      render();
    } catch (err) {
      if (!state.data) {
        showError(err.status === 404);
      } else {
        // Keep showing the last data; say the refresh failed.
        const updated = $('updated');
        updated.textContent = `Cập nhật lúc ${formatTime(state.data.generatedAt)} · không làm mới được, thử lại sau`;
        updated.classList.add('is-error');
      }
    } finally {
      state.loading = false;
      $('refresh').disabled = false;
      $('refresh').classList.remove('is-spinning');
    }
  }

  $('q').addEventListener('input', (e) => { state.q = e.target.value; state.shown = PAGE; render(); });
  $('status').addEventListener('change', (e) => { state.status = e.target.value; state.shown = PAGE; render(); });
  $('country').addEventListener('change', (e) => { state.country = e.target.value; state.shown = PAGE; render(); });
  $('more').addEventListener('click', () => { state.shown += PAGE; render(); });
  $('clear').addEventListener('click', clearFilters);
  $('empty-clear').addEventListener('click', clearFilters);
  $('retry').addEventListener('click', load);
  $('refresh').addEventListener('click', load);
  document.querySelectorAll('th button[data-sort]').forEach((b) => b.addEventListener('click', () => {
    const key = b.dataset.sort;
    state.dir = state.sort === key ? -state.dir : 1;
    state.sort = key;
    render();
  }));
  window.addEventListener('hashchange', () => {
    readHash();
    if (!state.data) return;
    fillSelects(state.data);
    state.shown = PAGE;
    render();
  });
  setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  readHash();
  load();
})();
