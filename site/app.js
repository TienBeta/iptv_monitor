// Dashboard: reads results.json (written by GitHub Actions) and renders
// summary tiles + a filterable table. All data goes through textContent.

(function () {
  'use strict';

  const STATUS = {
    OFFLINE: { label: 'Không hoạt động', icon: '✕', cls: 'critical', rank: 0 },
    FAILING: { label: 'Đang lỗi', icon: '▲', cls: 'serious', rank: 1 },
    SLOW: { label: 'Chậm', icon: '!', cls: 'warning', rank: 2 },
    UNSUPPORTED: { label: 'Không kiểm tra được', icon: '–', cls: 'neutral', rank: 3 },
    PENDING: { label: 'Chờ kiểm tra', icon: '…', cls: 'neutral', rank: 4 },
    ONLINE: { label: 'Hoạt động', icon: '✓', cls: 'good', rank: 5 },
  };
  const TILES = [
    { key: 'ALL', label: 'Tổng số link' },
    { key: 'ONLINE', label: 'Hoạt động' },
    { key: 'SLOW', label: 'Chậm' },
    { key: 'FAILING', label: 'Đang lỗi' },
    { key: 'OFFLINE', label: 'Không hoạt động' },
    { key: 'OTHER', label: 'Khác', statuses: ['UNSUPPORTED', 'PENDING'] },
  ];
  const LABEL_NAMES = { 'Geo-blocked': 'Giới hạn quốc gia', 'Not 24/7': 'Không phát 24/7' };
  const PAGE = 200;
  const REFRESH_MS = 10 * 60 * 1000;

  const $ = (id) => document.getElementById(id);
  const collator = new Intl.Collator('vi', { sensitivity: 'base' });
  const timeFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const numFmt = new Intl.NumberFormat('vi-VN');

  const state = { data: null, q: '', status: 'ALL', country: 'ALL', sort: 'status', dir: 1, shown: PAGE };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function formatTime(ms) {
    return ms ? timeFmt.format(new Date(ms)).replace(',', '') : '—';
  }

  function ago(ms) {
    const min = Math.round((Date.now() - ms) / 60000);
    if (min < 1) return 'vừa xong';
    if (min < 60) return `${min} phút trước`;
    const h = Math.round(min / 60);
    return h < 48 ? `${h} giờ trước` : `${Math.round(h / 24)} ngày trước`;
  }

  function badge(status) {
    const s = STATUS[status] || STATUS.PENDING;
    const wrap = el('span', 'badge');
    const icon = el('span', `ico ${s.cls}`, s.icon);
    icon.setAttribute('aria-hidden', 'true');
    wrap.append(icon, el('span', null, s.label));
    return wrap;
  }

  function matchesStatus(row) {
    if (state.status === 'ALL') return true;
    if (state.status === 'OTHER') return row.status === 'UNSUPPORTED' || row.status === 'PENDING';
    return row.status === state.status;
  }

  function filtered() {
    const q = state.q.trim().toLowerCase();
    const rows = state.data.streams.filter((r) =>
      matchesStatus(r) &&
      (state.country === 'ALL' || r.country === state.country) &&
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
    $('meta').textContent = `Cập nhật lúc ${formatTime(data.generatedAt)} (${ago(data.generatedAt)}) · Mức kiểm tra: ${data.levelLabel}`;
    $('scope').textContent = data.scope || '';
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

  function renderTiles(data) {
    const box = $('tiles');
    box.replaceChildren();
    for (const t of TILES) {
      const value = t.key === 'ALL' ? data.total
        : t.statuses ? t.statuses.reduce((n, s) => n + (data.counts[s] || 0), 0)
          : data.counts[t.key] || 0;
      const btn = el('button', `tile${state.status === t.key ? ' active' : ''}`);
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(state.status === t.key));
      const head = el('span', 'tile-label');
      const cls = t.key === 'ALL' ? null : t.statuses ? 'neutral' : STATUS[t.key].cls;
      if (cls) head.append(el('span', `dot ${cls}`));
      head.append(document.createTextNode(t.label));
      btn.append(head, el('span', 'tile-value', numFmt.format(value)));
      if (t.key !== 'ALL' && data.total) {
        btn.append(el('span', 'tile-share', `${Math.round((value / data.total) * 100)}%`));
      }
      btn.addEventListener('click', () => {
        state.status = state.status === t.key && t.key !== 'ALL' ? 'ALL' : t.key;
        $('status').value = state.status;
        state.shown = PAGE;
        render();
      });
      box.append(btn);
    }
  }

  function fillSelects(data) {
    const status = $('status');
    status.replaceChildren(new Option('Tất cả trạng thái', 'ALL'));
    for (const key of ['ONLINE', 'SLOW', 'FAILING', 'OFFLINE']) status.append(new Option(STATUS[key].label, key));
    status.append(new Option('Khác (không kiểm tra được / chờ)', 'OTHER'));
    status.value = state.status;

    const countries = new Map();
    for (const r of data.streams) if (r.country) countries.set(r.country, [r.flag, r.countryName].filter(Boolean).join(' '));
    const country = $('country');
    country.replaceChildren(new Option('Tất cả quốc gia', 'ALL'));
    [...countries.entries()].sort((a, b) => collator.compare(a[1].replace(/^\S+\s/, ''), b[1].replace(/^\S+\s/, '')))
      .forEach(([code, name]) => country.append(new Option(name, code)));
    if (!countries.has(state.country)) state.country = 'ALL';
    country.value = state.country;
    country.hidden = countries.size < 2;
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
    toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
  }

  function row(r) {
    const tr = el('tr');

    const name = el('td', 'c-name');
    name.dataset.label = 'Tên kênh';
    name.append(el('div', 'title', r.title));
    if (r.channel) name.append(el('div', 'sub', r.channel));
    if (r.labels?.length) {
      const chips = el('div', 'chips');
      for (const l of r.labels) chips.append(el('span', 'chip', LABEL_NAMES[l] || l));
      name.append(chips);
    }

    const country = el('td', 'c-country', [r.flag, r.countryName].filter(Boolean).join(' ') || '—');
    country.dataset.label = 'Quốc gia';

    const status = el('td', 'c-status');
    status.dataset.label = 'Trạng thái';
    status.append(badge(r.status));
    if (r.reason) status.append(el('div', 'reason', r.reason));

    const time = el('td', 'c-time', formatTime(r.lastChecked));
    time.dataset.label = 'Kiểm tra lúc';

    const link = el('td', 'c-link');
    link.dataset.label = 'Link';
    const url = el('span', 'url', r.url);
    url.title = r.url;
    const btn = el('button', 'copy', 'Sao chép');
    btn.type = 'button';
    btn.setAttribute('aria-label', `Sao chép link ${r.title}`);
    btn.addEventListener('click', () => copy(r.url));
    const box = el('div', 'linkbox');
    box.append(url, btn);
    link.append(box);

    tr.append(name, country, status, time, link);
    return tr;
  }

  function render() {
    const data = state.data;
    renderTiles(data);
    const rows = filtered();
    const body = $('rows');
    body.replaceChildren(...rows.slice(0, state.shown).map(row));
    $('count').textContent = `${numFmt.format(rows.length)} kênh`;
    $('empty').hidden = rows.length > 0;
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

  async function load() {
    try {
      const res = await fetch(`results.json?v=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      data.streams = data.streams || [];
      state.data = data;
      renderHeader(data);
      fillSelects(data);
      render();
    } catch {
      if (!state.data) {
        $('meta').textContent = 'Chưa có dữ liệu. Nếu vừa cài đặt, hãy đợi lần kiểm tra đầu tiên chạy xong rồi tải lại trang.';
      }
    }
  }

  $('q').addEventListener('input', (e) => { state.q = e.target.value; state.shown = PAGE; render(); });
  $('status').addEventListener('change', (e) => { state.status = e.target.value; state.shown = PAGE; render(); });
  $('country').addEventListener('change', (e) => { state.country = e.target.value; state.shown = PAGE; render(); });
  $('more').addEventListener('click', () => { state.shown += PAGE; render(); });
  document.querySelectorAll('th button[data-sort]').forEach((b) => b.addEventListener('click', () => {
    const key = b.dataset.sort;
    state.dir = state.sort === key ? -state.dir : 1;
    state.sort = key;
    render();
  }));
  setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  load();
})();
