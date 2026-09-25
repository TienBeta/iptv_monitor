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
  // Changes since the previous run, from each row's `prev` (present only when
  // the status changed; '' = new in the list). Only working ↔ failing counts.
  const WORKING = ['ONLINE', 'SLOW'];
  const FAILED = ['FAILING', 'OFFLINE'];
  const CHANGES = {
    DOWN: { label: 'mới lỗi', tag: 'Mới lỗi', tone: 'err', arrow: '↓' },
    UP: { label: 'hoạt động lại', tag: 'Hoạt động lại', tone: 'ok', arrow: '↑' },
    NEW: { label: 'link mới', tag: 'Mới thêm', tone: 'neutral', arrow: '' },
  };
  const CHANGE_FILTERS = ['ALL', ...Object.keys(CHANGES)];
  const REFRESH_MS = 10 * 60 * 1000;

  const $ = (id) => document.getElementById(id);
  // "?v=…" the publish step adds to app.js; reused for match.js so both come from the same deploy.
  const ASSET_QUERY = (document.currentScript && new URL(document.currentScript.src).search) || '';
  const collator = new Intl.Collator('vi', { sensitivity: 'base' });
  const timeFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const numFmt = new Intl.NumberFormat('vi-VN');

  const state = { data: null, q: '', status: 'ALL', country: 'ALL', reason: 'ALL', change: 'ALL', sort: 'status', dir: 1, shown: PAGE, loading: false };
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

  const filtersActive = () => state.status !== 'ALL' || state.country !== 'ALL' || state.reason !== 'ALL'
    || state.change !== 'ALL' || state.q.trim() !== '';

  function clearFilters() {
    state.q = '';
    state.status = 'ALL';
    state.country = 'ALL';
    state.reason = 'ALL';
    state.change = 'ALL';
    state.shown = PAGE;
    $('q').value = '';
    $('status').value = 'ALL';
    $('country').value = 'ALL';
    $('reason').value = 'ALL';
    render();
  }

  function changeOf(r) {
    if (!('prev' in r)) return null;
    if (r.prev === '') return 'NEW';
    if (WORKING.includes(r.prev) && FAILED.includes(r.status)) return 'DOWN';
    if (FAILED.includes(r.prev) && WORKING.includes(r.status)) return 'UP';
    return null;
  }
  const prevStatus = (r) => ('prev' in r ? r.prev : r.status);
  const matchesReason = (r) => state.reason === 'ALL' || r.reason === state.reason;
  const matchesChange = (r) => state.change === 'ALL' || changeOf(r) === state.change;

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
      matchesReason(r) &&
      matchesChange(r) &&
      (!q || r.title.toLowerCase().includes(q) || r.channel.toLowerCase().includes(q) || r.url.toLowerCase().includes(q)));
    const key = state.sort;
    const dir = state.dir;
    rows.sort((a, b) => {
      let d;
      if (key === 'status') d = (STATUS[a.status]?.rank ?? 9) - (STATUS[b.status]?.rank ?? 9);
      else if (key === 'lastOnline') d = (a.lastOnline || 0) - (b.lastOnline || 0);
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
    // vs the previous run, over links present in both runs (new links are listed separately)
    const both = data.previousAt ? scope.filter((r) => r.prev !== '') : [];
    const delta = (list) => both.filter((r) => list.includes(r.status)).length - both.filter((r) => list.includes(prevStatus(r))).length;
    const blocked = scope.filter((r) => r.blocked && r.status === 'OFFLINE').length;
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
        if (m.key === 'OFFLINE' && blocked) sub += ` · ${numFmt.format(blocked)} bị chặn truy cập`;
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
      const valueRow = el('span', 'metric-value-row');
      valueRow.append(el('span', 'metric-value', numFmt.format(value)));
      const d = m.statuses && both.length ? delta(m.statuses) : 0;
      if (d) {
        // more online is good; more warnings / offline is bad
        const good = (d > 0) === (m.key === 'ONLINE');
        const chip = el('span', `metric-delta tone-${good ? 'ok' : 'err'}`, `${d > 0 ? '▲' : '▼'} ${numFmt.format(Math.abs(d))}`);
        chip.title = `${d > 0 ? 'Tăng' : 'Giảm'} ${numFmt.format(Math.abs(d))} so với lần chạy trước (${formatTime(data.previousAt)})`;
        valueRow.append(chip);
      }
      btn.append(head, valueRow, el('span', 'metric-sub', sub));
      btn.addEventListener('click', () => {
        state.status = state.status === m.key && m.key !== 'ALL' ? 'ALL' : m.key;
        $('status').value = state.status;
        state.shown = PAGE;
        render();
      });
      box.append(btn);
    }
  }

  // "So với lần chạy trước": counts that work as filters. Follows the country filter.
  function renderChanges(data) {
    const box = $('changes');
    box.replaceChildren();
    box.hidden = !data.previousAt;
    if (!data.previousAt) return;
    const counts = { DOWN: 0, UP: 0, NEW: 0 };
    for (const r of data.streams) {
      const c = matchesCountry(r) && changeOf(r);
      if (c) counts[c]++;
    }
    box.append(el('span', 'changes-label', `So với lần chạy trước (${formatTime(data.previousAt)}):`));
    const keys = Object.keys(CHANGES).filter((k) => counts[k] || state.change === k);
    for (const k of keys) {
      const c = CHANGES[k];
      const active = state.change === k;
      const chip = el('button', `change-chip${active ? ' is-active' : ''}`);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(active));
      const dot = el('span', `dot tone-${c.tone}`);
      dot.setAttribute('aria-hidden', 'true');
      chip.append(dot, `${numFmt.format(counts[k])} ${c.label}`);
      chip.addEventListener('click', () => {
        state.change = active ? 'ALL' : k;
        state.shown = PAGE;
        render();
      });
      box.append(chip);
    }
    const removed = state.country === 'ALL' ? data.removed || 0 : 0;
    if (removed) box.append(el('span', 'changes-note', `${numFmt.format(removed)} link đã bị bỏ khỏi danh sách`));
    if (!keys.length && !removed) box.append(el('span', 'changes-note', 'không có kênh nào đổi trạng thái.'));
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

    // Reasons of the links that are not working, most common first.
    const reasons = new Map();
    for (const r of data.streams) if (r.reason) reasons.set(r.reason, (reasons.get(r.reason) || 0) + 1);
    const reason = $('reason');
    reason.replaceChildren(new Option('Tất cả lý do', 'ALL'), ...[...reasons.entries()]
      .sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]))
      .map(([text, n]) => new Option(`${text} (${numFmt.format(n)})`, text)));
    if (state.reason !== 'ALL' && !reasons.has(state.reason)) state.reason = 'ALL';
    reason.value = state.reason;
    if (!data.previousAt) state.change = 'ALL';
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
    state.reason = p.get('reason') || 'ALL';
    const change = (p.get('change') || 'ALL').toUpperCase();
    state.change = CHANGE_FILTERS.includes(change) ? change : 'ALL';
  }

  function writeHash() {
    const p = new URLSearchParams();
    if (state.country !== 'ALL') p.set('country', state.country);
    if (state.status !== 'ALL') p.set('status', state.status);
    if (state.reason !== 'ALL') p.set('reason', state.reason);
    if (state.change !== 'ALL') p.set('change', state.change);
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
    const change = changeOf(r);
    if (change) {
      const c = CHANGES[change];
      const tag = el('span', `change-tag tone-${c.tone}`, `${c.arrow ? `${c.arrow} ` : ''}${c.tag}`);
      tag.title = change === 'NEW' ? 'Lần đầu có trong danh sách' : `Lần chạy trước: ${STATUS[r.prev]?.label || r.prev}`;
      status.append(tag);
    }
    if (r.reason) status.append(el('div', 'reason', r.reason));

    const time = el('td', 'c-time');
    time.dataset.label = 'Hoạt động lần cuối';
    time.append(...lastOnlineCell(r));

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

  // "Hoạt động lần cuối": when the link last worked. The check time is shown
  // only when this link was not checked in the latest run (time budget ran out).
  function lastOnlineCell(r) {
    const out = [];
    if (r.status === 'PENDING' || r.lastOnline === undefined) out.push(el('span', 'seen-muted', '—'));
    else if (WORKING.includes(r.status)) out.push(el('span', 'seen-muted', 'Lần kiểm tra này'));
    else if (r.lastOnline) out.push(el('div', null, formatTime(r.lastOnline)), el('div', 'seen-sub', ago(r.lastOnline)));
    else out.push(el('div', null, 'Chưa ghi nhận'), el('div', 'seen-sub', r.firstSeen ? `từ ${formatTime(r.firstSeen).slice(0, 10)}` : ''));
    const data = state.data;
    if (r.lastChecked && data && data.startedAt && r.lastChecked < data.startedAt) {
      out.push(el('div', 'seen-sub seen-stale', `Kiểm tra lúc ${formatTime(r.lastChecked)}`));
    }
    return out;
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
    for (const id of ['q', 'status', 'country', 'reason']) $(id).disabled = !ready;
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
    renderChanges(data);
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
      setupControl(data);
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

  // ---------- Run controls: "Chạy ngay", run status, schedule ----------
  // They talk to the Sheet's Apps Script web app (URL comes with results.json).
  // Status is public; running and changing the schedule need the operator code.

  const CONTROL_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;
  const CODE_KEY = 'iptv-monitor:code';
  const BUSY_PHASES = ['queued', 'running'];
  const POLL_BUSY_MS = 10 * 1000;
  const POLL_IDLE_MS = 60 * 1000;
  const ctl = { url: null, status: null, timer: null, sending: false, memCode: '', codeResolve: null, waiting: false, skew: 0 };
  const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit' });
  const clockFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hour12: false });
  const pad2 = (n) => String(n).padStart(2, '0');
  const serverNow = () => Date.now() + ctl.skew;

  // "14:05" today, "14:05 25/09" on another day (giờ Việt Nam)
  function when(ms) {
    const day = dayFmt.format(new Date(ms));
    return day === dayFmt.format(new Date(serverNow())) ? clockFmt.format(new Date(ms)) : `${clockFmt.format(new Date(ms))} ${day}`;
  }
  function minutesText(ms) {
    const min = Math.round(ms / 60000);
    return min < 1 ? 'dưới 1 phút' : `${min} phút`;
  }

  const RUN_VIEW = {
    idle: { tone: 'neutral', title: 'Sẵn sàng', detail: () => '' },
    queued: { busy: true, title: 'Đang chờ chạy', detail: (r) => (r.since ? `gửi yêu cầu lúc ${when(r.since)}` : '') },
    running: { busy: true, title: 'Đang chạy kiểm tra', detail: (r) => (r.startedAt ? `bắt đầu ${when(r.startedAt)} · đã chạy ${minutesText(serverNow() - r.startedAt)}` : '') },
    success: { tone: 'ok', title: 'Đã chạy xong', detail: (r) => (r.finishedAt ? `lúc ${when(r.finishedAt)}${r.startedAt ? ` · chạy ${minutesText(r.finishedAt - r.startedAt)}` : ''}` : '') },
    failure: { tone: 'err', title: 'Lần chạy bị lỗi', detail: (r) => `${r.finishedAt ? `lúc ${when(r.finishedAt)} · ` : ''}thử Chạy ngay lại; nếu vẫn lỗi, báo người quản lý` },
    cancelled: { tone: 'neutral', title: 'Lần chạy bị huỷ', detail: (r) => (r.finishedAt ? `lúc ${when(r.finishedAt)}` : '') },
    error: { tone: 'err', title: 'Có lỗi', detail: (r) => `${r.message ? `${r.message} · ` : ''}báo người quản lý hệ thống` },
  };

  function getCode() {
    if (ctl.memCode) return ctl.memCode;
    try { return localStorage.getItem(CODE_KEY) || ''; } catch { return ''; }
  }
  function keepCode(code, remember) {
    ctl.memCode = code;
    try { if (remember) localStorage.setItem(CODE_KEY, code); else localStorage.removeItem(CODE_KEY); } catch { /* private mode */ }
  }
  function forgetCode() { keepCode('', false); }

  function setupControl(data) {
    const url = CONTROL_URL_RE.test(data.controlUrl || '') ? data.controlUrl : null;
    if (url === ctl.url) return;
    ctl.url = url;
    $('runbar').hidden = !url;
    if (url) fetchStatus();
  }

  async function fetchStatus() {
    clearTimeout(ctl.timer);
    if (!ctl.url) return;
    try {
      const res = await fetch(`${ctl.url}?action=status&t=${Date.now()}`, { cache: 'no-store' });
      const s = await res.json();
      if (!s.ok || !s.run || !s.schedule) throw Object.assign(new Error('old'), { old: true });
      applyStatus(s);
    } catch (err) {
      renderRunProblem(err.old
        ? 'Apps Script trong Sheet chưa được cập nhật bản mới nên chưa dùng được Chạy ngay ở đây.'
        : 'Không lấy được trạng thái lần chạy — sẽ thử lại sau.');
    }
    pollLater();
  }

  function pollLater() {
    clearTimeout(ctl.timer);
    const busy = ctl.status && BUSY_PHASES.includes(ctl.status.run.phase);
    ctl.timer = setTimeout(() => (document.hidden ? pollLater() : fetchStatus()), busy ? POLL_BUSY_MS : POLL_IDLE_MS);
  }

  function applyStatus(s) {
    ctl.status = s;
    if (s.now) ctl.skew = s.now - Date.now();
    renderRunbar();
    if (resultsBehind()) awaitResults();
  }

  // The run finished but the published results are older than it: GitHub Pages
  // takes about a minute to serve the new file.
  function resultsBehind() {
    const r = ctl.status && ctl.status.run;
    return !!(r && r.phase === 'success' && r.startedAt && state.data && state.data.generatedAt < r.startedAt);
  }
  async function awaitResults() {
    if (ctl.waiting) return;
    ctl.waiting = true;
    for (let i = 0; i < 20 && resultsBehind(); i++) {
      await new Promise((resolve) => { setTimeout(resolve, 15000); });
      await load();
      if (!resultsBehind()) toast('Đã có kết quả mới');
    }
    ctl.waiting = false;
  }

  function renderRunProblem(text) {
    $('run-icon').className = 'run-icon dot tone-neutral';
    $('run-title').textContent = 'Chạy ngay chưa sẵn sàng';
    $('run-detail').textContent = text;
    $('schedule-text').textContent = '';
    $('run-now').disabled = true;
    $('schedule-open').disabled = true;
  }

  function renderRunbar() {
    const s = ctl.status;
    if (!s) return;
    const run = s.run;
    const view = RUN_VIEW[run.phase] || RUN_VIEW.idle;
    const busy = BUSY_PHASES.includes(run.phase);
    $('run-icon').className = view.busy ? 'run-icon is-busy' : `run-icon dot tone-${view.tone}`;
    $('run-title').textContent = view.title;
    const detail = $('run-detail');
    detail.replaceChildren();
    const parts = [view.detail(run)].filter(Boolean);
    if (!s.ready.github) parts.push('chưa chạy được — báo người quản lý (Sheet thiếu GitHub token)');
    else if (!s.ready.code) parts.push('chưa chạy được — báo người quản lý (Sheet chưa có mã thao tác)');
    detail.append(parts.join(' · '));
    const sch = s.schedule;
    $('schedule-text').textContent = sch.enabled
      ? `Tự chạy mỗi ${sch.everyHours} giờ${sch.next ? ` · lần tới ${when(sch.next)}` : ''}`
      : 'Tự chạy: đang tắt';
    const btn = $('run-now');
    btn.disabled = busy || ctl.sending || !s.ready.github || !s.ready.code;
    btn.classList.toggle('is-sending', ctl.sending);
    $('run-now-label').textContent = busy ? 'Đang chạy…' : ctl.sending ? 'Đang gửi…' : 'Chạy ngay';
    $('schedule-open').disabled = !s.ready.code;
  }

  async function post(body) {
    try {
      const res = await fetch(ctl.url, { method: 'POST', body: JSON.stringify(body) }); // text/plain: no CORS preflight
      return await res.json();
    } catch {
      return { ok: false, error: 'network', message: 'Không kết nối được tới Google Sheet, thử lại sau.' };
    }
  }

  // Sends an action that needs the operator code; asks for it when missing or wrong.
  async function control(body) {
    let code = getCode();
    let problem = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!code) {
        code = await askCode(problem);
        if (!code) return null;
      }
      ctl.sending = true;
      renderRunbar();
      const res = await post({ ...body, code });
      ctl.sending = false;
      if (res.error === 'bad_code') {
        forgetCode();
        code = '';
        problem = res.message;
        renderRunbar();
        continue;
      }
      if (res.status) applyStatus(res.status);
      else renderRunbar();
      pollLater();
      return res;
    }
    return null;
  }

  function showFormError(id, text) {
    $(id).textContent = text || '';
    $(id).hidden = !text;
  }

  function askCode(problem) {
    $('code-input').value = '';
    showFormError('code-error', problem);
    $('code-dialog').showModal();
    return new Promise((resolve) => { ctl.codeResolve = resolve; });
  }
  function finishCode(code) {
    const resolve = ctl.codeResolve;
    ctl.codeResolve = null;
    if ($('code-dialog').open) $('code-dialog').close();
    if (resolve) resolve(code);
  }

  async function runNow() {
    const res = await control({ action: 'run' });
    if (res) toast(res.message || (res.ok ? 'Đã gửi yêu cầu chạy.' : 'Không gửi được yêu cầu chạy.'));
  }

  // ---------- Settings page: scope, level, schedule, exclude list ----------
  // Everything is edited in a draft and saved in one request; Apps Script
  // checks it all and refuses a stale revision (someone else saved meanwhile).

  // Short, plain explanation of each level (keys: the part before " - ").
  const LEVEL_HINTS = {
    1: 'Chỉ xem link có trả lời. Nhanh nhất, nhưng dễ báo "hoạt động" dù không xem được.',
    2: 'Kiểm tra thêm danh sách phát (m3u8) có hợp lệ.',
    3: 'Tải thử một đoạn video. Nên dùng: cân bằng giữa tốc độ và độ chắc chắn.',
    '4a': 'Đọc được luồng hình hoặc tiếng. Chắc hơn, chạy lâu hơn.',
    '4b': 'Giải mã được khung hình. Chắc chắn nhất, chạy lâu nhất.',
  };
  const levelKey = (label) => String(label || '').split(' - ')[0];
  const BIG_SCOPE = 3000; // links: above this one run may not check everything
  const SCOPE_KINDS = [
    { key: 'countries', picker: 'pick-countries', fix: (v) => (v.toUpperCase() === 'GB' ? 'UK' : v.toUpperCase()) },
    { key: 'languages', picker: 'pick-languages', fix: (v) => v.toLowerCase() },
    { key: 'categories', picker: 'pick-categories', fix: (v) => v.toLowerCase() },
  ];
  const set = { options: null, triedOptions: false, match: null, base: null, draft: null, pickers: {}, rows: [] };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  function slotHours(every, start) {
    const hours = [];
    for (let h = start % every; h < 24; h += every) hours.push(h);
    return hours;
  }

  // options.json (the iptv-org catalog, written by the checker) and the matcher shared with it.
  async function loadCatalog() {
    if (!set.match) {
      try { set.match = await import(`./match.js${ASSET_QUERY}`); } catch { set.match = null; }
    }
    if (set.triedOptions) return;
    set.triedOptions = true;
    try {
      const res = await fetch(`options.json?v=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) set.options = await res.json();
    } catch { set.options = null; }
    if (!set.options) return;
    const o = set.options;
    for (const [kind, key] of [['countries', 'code'], ['languages', 'code'], ['categories', 'id']]) {
      o[`${kind}Index`] = new Map(o[kind].map((x, i) => [x[key], i]));
    }
    // matcher fields per link; the words are computed on first use
    set.rows = o.links.map(([, , , title, channel, name, host, altNames]) => ({
      fields: { url: host ? `https://${host}/` : '', title, channel, name, altNames }, words: null,
    }));
  }

  function pickerItems(kind) {
    const o = set.options;
    if (!o) return [];
    const list = o[kind].map((x) => (kind === 'countries'
      ? { value: x.code, label: `${x.flag ? `${x.flag} ` : ''}${x.name}`, n: x.n }
      : kind === 'languages' ? { value: x.code, label: x.name, hint: x.code, n: x.n }
        : { value: x.id, label: x.name, hint: x.id, n: x.n }));
    return list.sort((a, b) => b.n - a.n || collator.compare(a.label, b.label));
  }

  // Multi-select with search, for the three scope lists.
  function makePicker(root, kind, items, fix, onChange) {
    const fold = (v) => (set.match ? set.match.foldText(v) : String(v).toLowerCase());
    const byValue = new Map(items.map((i) => [i.value, { ...i, search: fold(`${i.label} ${i.value}`) }]));
    const codeRe = new RegExp(root.dataset.code);
    let selected = [];
    let shown = [];
    let active = -1;
    root.replaceChildren();
    const id = `${root.id}-input`;
    const label = el('label', 'field-label', root.dataset.label);
    label.htmlFor = id;
    const box = el('div', 'picker-box');
    const chips = el('span', 'picker-chips');
    const input = el('input', 'picker-input');
    Object.assign(input, { id, type: 'text', autocomplete: 'off', spellcheck: false, placeholder: root.dataset.placeholder });
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    const list = el('ul', 'picker-list');
    list.id = `${root.id}-list`;
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    input.setAttribute('aria-controls', list.id);
    box.append(chips, input);
    root.append(label, box, list);
    box.addEventListener('mousedown', (e) => { if (e.target === box || e.target === chips) { e.preventDefault(); input.focus(); } });

    const itemOf = (v) => byValue.get(v) || { value: v, label: v, n: 0, search: fold(v) };
    function renderChips() {
      chips.replaceChildren(...selected.map((v) => {
        const it = itemOf(v);
        const chip = el('span', 'chip-sel', it.label);
        const x = el('button', 'chip-x');
        x.type = 'button';
        x.setAttribute('aria-label', `Bỏ ${it.label}`);
        x.textContent = '×';
        x.addEventListener('click', () => toggle(v));
        chip.append(x);
        return chip;
      }));
      if (!selected.length) chips.append(el('span', 'picker-empty', root.dataset.empty));
    }
    function renderList() {
      const q = fold(input.value);
      shown = [...byValue.values()].filter((i) => !q || i.search.includes(q)).slice(0, 60);
      if (active >= shown.length) active = shown.length - 1;
      list.replaceChildren(...shown.map((it, i) => {
        const li = el('li', `picker-option${i === active ? ' is-active' : ''}`);
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(selected.includes(it.value)));
        li.append(el('span', 'picker-check', selected.includes(it.value) ? '✓' : ''), el('span', 'picker-label', it.label));
        if (it.hint) li.append(el('span', 'picker-hint', it.hint));
        li.append(el('span', 'picker-n', `${numFmt.format(it.n)} link`));
        li.addEventListener('mousedown', (e) => { e.preventDefault(); toggle(it.value); });
        return li;
      }));
      const typed = input.value.trim();
      if (!shown.length) {
        list.append(el('li', 'picker-none', codeRe.test(typed) ? `Nhấn Enter để thêm mã “${fix(typed)}”` : 'Không tìm thấy'));
      }
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }
    function close() {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      active = -1;
    }
    function toggle(v) {
      selected = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
      renderChips();
      if (!list.hidden) renderList();
      onChange(selected.slice());
    }
    input.addEventListener('focus', renderList);
    input.addEventListener('input', () => { active = 0; renderList(); });
    input.addEventListener('blur', () => setTimeout(close, 120));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) renderList();
        active = Math.max(0, Math.min(shown.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
        renderList();
      } else if (e.key === 'Enter') {
        e.preventDefault(); // never submits the settings form
        const typed = input.value.trim();
        if (shown[active]) toggle(shown[active].value);
        else if (!shown.length && codeRe.test(typed)) toggle(fix(typed));
        input.value = '';
        renderList();
      } else if (e.key === 'Escape' && !list.hidden) {
        e.preventDefault();
        e.stopPropagation(); // close the list, not the dialog
        close();
      } else if (e.key === 'Backspace' && !input.value && selected.length) {
        toggle(selected[selected.length - 1]);
      }
    });
    return {
      set(values) { selected = values.slice(); renderChips(); },
    };
  }

  // Links of the catalog inside a scope, as indexes into set.rows.
  function scopeRows(draft) {
    const o = set.options;
    if (!o) return null;
    const sets = SCOPE_KINDS.map(({ key }) => new Set(draft[key].map((v) => o[`${key}Index`].get(v)).filter((i) => i !== undefined)));
    const wanted = SCOPE_KINDS.map(({ key }) => draft[key].length > 0);
    const noFilter = !wanted.some(Boolean);
    const out = [];
    o.links.forEach(([c, l, k, , channel], i) => {
      if (!channel) {
        if (noFilter) out.push(i); // links without a channel are only kept when nothing is filtered
        return;
      }
      if (wanted[0] && !sets[0].has(c)) return;
      if (wanted[1] && !l.some((x) => sets[1].has(x))) return;
      if (wanted[2] && !k.some((x) => sets[2].has(x))) return;
      out.push(i);
    });
    return out;
  }

  const rowMatches = (rule, i) => {
    const row = set.rows[i];
    if (!rule.link) row.words ||= set.match.nameWords(row.fields);
    return set.match.ruleMatches(rule, row.fields, row.words);
  };

  // What one exclude line removes: in the catalog for names / domains, in the
  // current results for full links (the catalog has no full links).
  function previewRule(entry, rows) {
    const m = set.match;
    if (!m) return null;
    const rule = m.makeRule(entry);
    const hit = { tooShort: rule.tooShort, link: rule.link, count: 0, names: [] };
    if (rule.tooShort) return hit;
    const note = (fields) => {
      hit.count++;
      const name = m.matchName(fields);
      if (hit.names.length < 4 && !hit.names.includes(name)) hit.names.push(name);
    };
    if (rule.link || !rows) {
      for (const r of state.data?.streams || []) {
        const fields = { url: r.url, title: r.title, channel: r.channel };
        if (m.ruleMatches(rule, fields)) note(fields);
      }
    } else {
      for (const i of rows) if (rowMatches(rule, i)) note(set.rows[i].fields);
    }
    return hit;
  }

  function renderEstimate() {
    const box = $('scope-estimate');
    const rows = scopeRows(set.draft);
    box.classList.remove('is-warn');
    if (!rows || !set.match) {
      box.textContent = '';
      return;
    }
    const rules = set.draft.exclude.map((e) => set.match.makeRule(e.entry)).filter((r) => !r.tooShort && !r.link);
    const kept = rows.filter((i) => !rules.some((r) => rowMatches(r, i))).length;
    const baseRows = scopeRows(set.base);
    const now = state.data ? state.data.total : null;
    let text = `Phạm vi này: khoảng ${numFmt.format(kept)} link`;
    if (rows.length !== kept) text += ` (đã trừ ${numFmt.format(rows.length - kept)} link bỏ qua)`;
    if (now !== null && baseRows && !sameScope(set.base, set.draft)) text += ` · hiện tại ${numFmt.format(now)} link`;
    if (kept > BIG_SCOPE) {
      text += '. Phạm vi lớn: một lần chạy có thể không kiểm hết, phần còn lại sẽ được kiểm ở các lần sau.';
      box.classList.add('is-warn');
    }
    box.textContent = text;
  }
  const sameScope = (a, b) => SCOPE_KINDS.every(({ key }) => sameList(a[key], b[key]));

  function renderExcludeList() {
    const ul = $('ex-list');
    const rows = scopeRows(set.draft);
    ul.replaceChildren(...set.draft.exclude.map((e, i) => {
      const li = el('li', 'exclude-item');
      const main = el('div', 'exclude-main');
      main.append(el('span', 'exclude-entry', e.entry));
      const note = el('input', 'exclude-note');
      Object.assign(note, { type: 'text', value: e.note || '', maxLength: 200, placeholder: 'Ghi chú' });
      note.setAttribute('aria-label', `Ghi chú cho ${e.entry}`);
      note.addEventListener('input', () => { set.draft.exclude[i].note = note.value; renderSettingsChanges(); });
      main.append(note);
      let status;
      if (e.isNew) {
        const hit = previewRule(e.entry, rows);
        status = `Mới — ${hit ? `sẽ bỏ: ${set.match.reportText(hit)}` : 'áp dụng khi lưu'}`;
      } else {
        status = e.report ? `Đang bỏ: ${e.report}` : 'Chưa có kết quả (có sau lần chạy tới)';
      }
      const del = el('button', 'icon-btn icon-btn-sm');
      del.type = 'button';
      del.title = 'Xoá khỏi danh sách';
      del.setAttribute('aria-label', `Xoá ${e.entry}`);
      del.append(icon('M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z'));
      del.addEventListener('click', () => { set.draft.exclude.splice(i, 1); refreshSettings(); });
      li.append(main, el('p', `exclude-status${e.isNew ? ' is-new' : ''}`, status), del);
      return li;
    }));
    if (!set.draft.exclude.length) ul.append(el('li', 'exclude-none', 'Chưa bỏ qua kênh nào.'));
  }

  function renderExcludePreview() {
    const entry = $('ex-entry').value.trim();
    const out = $('ex-preview');
    $('ex-add').disabled = !entry;
    out.classList.remove('is-warn');
    if (!entry) {
      out.textContent = '';
      return;
    }
    if (set.draft.exclude.some((e) => e.entry === entry)) {
      out.textContent = 'Đã có trong danh sách.';
      $('ex-add').disabled = true;
      return;
    }
    const hit = previewRule(entry, scopeRows(set.draft));
    if (!hit) {
      out.textContent = '';
      return;
    }
    out.textContent = hit.tooShort || !hit.count ? set.match.reportText(hit) : `Sẽ bỏ ${set.match.reportText(hit)}`;
    if (hit.tooShort || !hit.count) out.classList.add('is-warn');
  }

  function addExclude() {
    const entry = $('ex-entry').value.trim();
    if (!entry || set.draft.exclude.some((e) => e.entry === entry)) return;
    set.draft.exclude.push({ entry, note: $('ex-note').value.trim(), isNew: true });
    $('ex-entry').value = '';
    $('ex-note').value = '';
    refreshSettings();
    $('ex-entry').focus();
  }

  function describeChanges() {
    const b = set.base;
    const d = set.draft;
    const parts = [];
    const text = (v, all) => (v.length ? v.join(', ') : all);
    const names = { countries: ['Quốc gia', 'tất cả'], languages: ['Ngôn ngữ', 'mọi ngôn ngữ'], categories: ['Thể loại', 'mọi thể loại'] };
    for (const { key } of SCOPE_KINDS) {
      if (!sameList(b[key], d[key])) parts.push(`${names[key][0]}: ${text(b[key], names[key][1])} → ${text(d[key], names[key][1])}`);
    }
    if (b.level !== d.level) parts.push(`Mức kiểm tra: ${levelKey(b.level)} → ${levelKey(d.level)}`);
    const before = b.exclude.map((e) => e.entry);
    const after = d.exclude.map((e) => e.entry);
    const added = after.filter((x) => !before.includes(x)).length;
    const removed = before.filter((x) => !after.includes(x)).length;
    const notes = d.exclude.some((e) => { const o = b.exclude.find((x) => x.entry === e.entry); return o && (o.note || '') !== (e.note || ''); });
    if (added || removed) parts.push(`Bỏ qua: ${[added && `thêm ${added}`, removed && `xoá ${removed}`].filter(Boolean).join(', ')}`);
    else if (notes) parts.push('Ghi chú bỏ qua');
    if (JSON.stringify(b.schedule) !== JSON.stringify(d.schedule)) parts.push('Lịch tự chạy');
    const rerun = !sameScope(b, d) || b.level !== d.level || !sameList(before, after);
    return { parts, rerun };
  }

  function renderSettingsChanges() {
    const { parts, rerun } = describeChanges();
    $('settings-changes').textContent = parts.length
      ? `Sẽ lưu: ${parts.join(' · ')}.${rerun ? ' Lưu xong, hệ thống tự chạy lại sau khoảng 1–2 phút.' : ''}`
      : 'Chưa có thay đổi.';
    $('sch-save').disabled = !parts.length;
  }

  function refreshSettings() {
    renderEstimate();
    renderExcludeList();
    renderExcludePreview();
    renderSettingsChanges();
  }

  function readScheduleForm() {
    return { enabled: $('sch-enabled').checked, everyHours: Number($('sch-every').value), startHour: Number($('sch-start').value) };
  }

  // Draft from the status the page has (config + schedule).
  function fillSettings(s) {
    const c = s.config || {};
    set.base = {
      countries: c.countries || [], languages: c.languages || [], categories: c.categories || [],
      level: c.level || '', exclude: (c.exclude || []).map((e) => ({ entry: e.entry, note: e.note || '', report: e.report || '' })),
      schedule: { enabled: s.schedule.enabled, everyHours: s.schedule.everyHours, startHour: s.schedule.startHour },
      rev: c.rev,
    };
    set.draft = clone(set.base);
    for (const { key, picker, fix } of SCOPE_KINDS) {
      set.pickers[key] = makePicker($(picker), key, pickerItems(key), fix, (values) => { set.draft[key] = values; refreshSettings(); });
      set.pickers[key].set(set.draft[key]);
    }
    // Older Apps Script (no revision in the status): only level and schedule can be saved here.
    const full = c.rev !== undefined;
    $('scope-section').hidden = !full;
    $('exclude-section').hidden = !full;
    $('scope-missing').hidden = !full || !!set.options;
    const levels = s.levelOptions || [];
    $('level-section').hidden = !levels.length;
    $('set-level').replaceChildren(...levels.map((l) => new Option(l, l)));
    if (levels.length) $('set-level').value = set.draft.level || levels[2];
    set.draft.level = $('set-level').value;
    set.base.level ||= set.draft.level;
    const every = $('sch-every');
    every.replaceChildren(...(s.everyHoursOptions || [1, 2, 3, 4, 6, 8, 12, 24])
      .map((n) => new Option(n === 24 ? '24 giờ (mỗi ngày 1 lần)' : `${n} giờ`, String(n))));
    $('sch-start').replaceChildren(...Array.from({ length: 24 }, (_, h) => new Option(`${pad2(h)}:00`, String(h))));
    $('sch-enabled').checked = set.draft.schedule.enabled;
    every.value = String(set.draft.schedule.everyHours);
    $('sch-start').value = String(set.draft.schedule.startHour);
    $('ex-entry').value = '';
    $('ex-note').value = '';
    updateSchedulePreview();
    updateLevelHint();
    refreshSettings();
  }

  async function openSettings() {
    const s = ctl.status;
    if (!s) return;
    const btn = $('schedule-open');
    btn.disabled = true;
    await loadCatalog();
    btn.disabled = false;
    showFormError('sch-error', '');
    fillSettings(ctl.status);
    $('schedule-dialog').showModal();
  }

  function updateLevelHint() {
    const level = $('set-level').value;
    $('level-hint').textContent = LEVEL_HINTS[levelKey(level)] || '';
    if (set.draft) {
      set.draft.level = level;
      renderSettingsChanges();
    }
  }

  function updateSchedulePreview() {
    const enabled = $('sch-enabled').checked;
    const every = Number($('sch-every').value);
    $('sch-every').disabled = !enabled;
    $('sch-start').disabled = !enabled || every === 1;
    $('sch-preview').textContent = enabled
      ? `Các giờ chạy mỗi ngày: ${slotHours(every, Number($('sch-start').value)).map((h) => `${pad2(h)}:00`).join(', ')}`
      : 'Tự chạy đang tắt — chỉ chạy khi bấm Chạy ngay hoặc khi đổi cấu hình.';
    if (set.draft) {
      set.draft.schedule = readScheduleForm();
      renderSettingsChanges();
    }
  }

  async function saveSettings(e) {
    e.preventDefault();
    if (e.submitter && e.submitter.id !== 'sch-save') return; // Enter in a text box
    if (!describeChanges().parts.length) return;
    const save = $('sch-save');
    save.disabled = true;
    save.textContent = 'Đang lưu…';
    showFormError('sch-error', '');
    const d = set.draft;
    const full = !$('scope-section').hidden;
    const res = await control({
      action: 'settings',
      rev: set.base.rev,
      level: d.level,
      schedule: d.schedule,
      ...(full ? {
        scope: { countries: d.countries, languages: d.languages, categories: d.categories },
        exclude: d.exclude.map(({ entry, note }) => ({ entry, note })),
      } : {}),
    });
    save.textContent = 'Lưu';
    if (!res) {
      renderSettingsChanges();
      return;
    }
    if (res.ok) {
      $('schedule-dialog').close();
      toast(res.message || 'Đã lưu');
    } else if (res.error === 'conflict' && res.status) {
      fillSettings(res.status); // start again from what is saved now
      showFormError('sch-error', res.message);
    } else {
      renderSettingsChanges();
      showFormError('sch-error', res.message || 'Không lưu được, thử lại sau.');
    }
  }

  $('run-now').addEventListener('click', runNow);
  $('schedule-open').addEventListener('click', openSettings);
  $('schedule-form').addEventListener('submit', saveSettings);
  ['sch-enabled', 'sch-every', 'sch-start'].forEach((id) => $(id).addEventListener('change', updateSchedulePreview));
  $('set-level').addEventListener('change', updateLevelHint);
  $('ex-entry').addEventListener('input', renderExcludePreview);
  $('ex-add').addEventListener('click', addExclude);
  ['ex-entry', 'ex-note'].forEach((id) => $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addExclude(); }
  }));
  $('code-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('code-input').value.trim();
    if (!code) {
      showFormError('code-error', 'Nhập mã thao tác.');
      return;
    }
    keepCode(code, $('code-remember').checked);
    finishCode(code);
  });
  $('code-dialog').addEventListener('close', () => finishCode(null));
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ctl.url) fetchStatus(); });

  $('q').addEventListener('input', (e) => { state.q = e.target.value; state.shown = PAGE; render(); });
  $('status').addEventListener('change', (e) => { state.status = e.target.value; state.shown = PAGE; render(); });
  $('country').addEventListener('change', (e) => { state.country = e.target.value; state.shown = PAGE; render(); });
  $('reason').addEventListener('change', (e) => { state.reason = e.target.value; state.shown = PAGE; render(); });
  $('more').addEventListener('click', () => { state.shown += PAGE; render(); });
  $('clear').addEventListener('click', clearFilters);
  $('empty-clear').addEventListener('click', clearFilters);
  $('retry').addEventListener('click', load);
  $('refresh').addEventListener('click', () => { load(); fetchStatus(); });
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
