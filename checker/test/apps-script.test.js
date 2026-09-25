// Runs the real apps-script/Code.gs against an in-memory Sheet.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DATA_COLUMNS, STREAMS_HEADER, toDataTable, toStreamsTable, tokenCode } from '../bridge.js';
import { loadAppsScript } from './fake-apps-script.js';

const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]';

function ready() {
  const gas = loadAppsScript();
  gas.ctx.setup();
  return { gas, token: gas.props.get('BRIDGE_TOKEN') };
}

// Settings are changed from the dashboard (doPost "settings" with the operator code).
function saveSettings(gas, body) {
  return gas.post({ action: 'settings', code: gas.props.get('DASHBOARD_CODE'), ...body });
}

// A Sheet set up by an older version: inputs in Config!B3:B6, an "Exclude" sheet,
// no settings in Script Properties yet.
function oldSheet({ countries = 'VN, TH', languages = 'vie', categories = '', level = '4a - Có hình hoặc tiếng', exclude = [] } = {}) {
  const gas = loadAppsScript();
  const ss = gas.ss;
  const cfg = ss.insertSheet('Config', 0);
  cfg.getRange('A1:C10').setValues([
    ['IPTV MONITOR — CẤU HÌNH', '', ''], ['Mục', 'Giá trị', 'Hướng dẫn'],
    ['Quốc gia', countries, ''], ['Ngôn ngữ', languages, ''], ['Thể loại', categories, ''], ['Mức kiểm tra', level, ''],
    ['Lịch tự chạy', 'Mỗi 3 giờ', ''], ['Trạng thái', '✓ Xong lúc 10:02', 'Xem chi tiết trên GitHub'], ['Thông báo', 'x', ''],
    ['LẦN CHẠY GẦN NHẤT', '', ''],
  ]);
  cfg.getRange('A11:B12').setValues([['Thời điểm', new gas.ctx.Date()], ['Nguồn dữ liệu', 'Bình thường']]);
  cfg.getRange('A1:A30').protect().setDescription('Nhãn cấu hình');
  const ex = ss.insertSheet('Exclude');
  ex.getRange('A1:C1').setValues([['Bỏ qua', 'Ghi chú', 'Đang bỏ']]);
  if (exclude.length) ex.getRange(2, 1, exclude.length, 3).setValues(exclude);
  return gas;
}

const savePayload = (runAt = Date.UTC(2026, 8, 23, 3, 17)) => ({
  data: {
    header: ['url', 'title', 'status', 'failStreak', 'lastChecked'],
    rows: [
      ['https://a/1.m3u8', '=HYPERLINK("http://evil")', 'ONLINE', 0, runAt],
      ['https://a/2.m3u8', 'VTV3', 'OFFLINE', 2, runAt],
    ],
  },
  streams: {
    header: ['Tên kênh', 'Kênh', 'Quốc gia', 'Link', 'Trạng thái', 'Lý do', 'Kiểm tra lúc'],
    dateColumn: 6,
    rows: [
      ['=HYPERLINK("http://evil")', 'VTV1.vn', '🇻🇳 Việt Nam', 'https://a/1.m3u8', 'Hoạt động', '', runAt],
      ['VTV3', 'VTV3.vn', '🇻🇳 Việt Nam', 'https://a/2.m3u8', 'Không hoạt động', 'Link không còn tồn tại', runAt],
    ],
  },
  summary: { runAt, sourceCount: 2, configHash: 'abc123', lines: [['Nguồn dữ liệu', 'Bình thường'], ['Tổng số link', 2]] },
});

describe('Code.gs — cài đặt', () => {
  test('setup tạo Config (chỉ xem) + Streams + _data, token, lịch; không còn sheet Exclude / trigger sửa', () => {
    const { gas, token } = ready();
    assert.deepEqual(gas.ss.getSheets().map((s) => s.getName()), ['Config', 'Streams', '_data']);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(gas.sheet('_data').hidden, true);
    const cfg = gas.sheet('Config');
    assert.deepEqual(cfg.getRange('A1:A5').getValues().map((r) => r[0]), ['IPTV MONITOR', 'Cấu hình', 'Lịch tự chạy', 'Trạng thái', 'Thông báo']);
    assert.equal(cfg.getRange('B2').getValue(),
      'Quốc gia: VN · Ngôn ngữ: tất cả · Thể loại: tất cả · Mức 3 - Tải được dữ liệu video · Bỏ qua: không');
    assert.equal(cfg.getRange('C2').getValue(), 'Sửa trên dashboard: nút "Cài đặt"');
    assert.equal(cfg.getRange('B3').getValue(), 'Mỗi 3 giờ (01:00, 04:00, 07:00, 10:00, 13:00, 16:00, 19:00, 22:00)');
    assert.equal(cfg.getRange('A7').getValue(), 'LẦN CHẠY GẦN NHẤT');
    assert.ok(cfg.getProtections('SHEET').some((p) => /Chỉ để xem/.test(p.getDescription())));
    assert.equal(gas.triggers.filter((t) => t.handler === 'onConfigEdit').length, 0);
    assert.equal(gas.ss.tz, 'Asia/Ho_Chi_Minh');
  });
  test('Sheet cũ (B3:B6 + sheet Exclude) → chuyển cấu hình vào Apps Script, xoá Exclude, Config chỉ còn phần xem', () => {
    const gas = oldSheet({ exclude: [['An Ninh', 'kênh an ninh', '2 link: An Ninh TV'], ['', '', 'cũ'], [' vtvprime.vn ', '', '']] });
    gas.triggers.push({ handler: 'onConfigEdit', kind: 'edit', getHandlerFunction: () => 'onConfigEdit' });
    gas.ctx.setup();
    assert.deepEqual(gas.ss.getSheets().map((s) => s.getName()), ['Config', 'Streams', '_data']);
    const c = gas.get({ action: 'status' }).config;
    assert.deepEqual([c.countries, c.languages, c.categories, c.level], [['VN', 'TH'], ['vie'], [], '4a - Có hình hoặc tiếng']);
    assert.deepEqual(c.exclude, [
      { entry: 'An Ninh', note: 'kênh an ninh', report: '2 link: An Ninh TV' },
      { entry: 'vtvprime.vn', note: '', report: '' },
    ]);
    const cfg = gas.sheet('Config');
    assert.equal(cfg.getRange('A3').getValue(), 'Lịch tự chạy');
    assert.equal(cfg.getRange('B4').getValue(), '✓ Xong lúc 10:02'); // status kept
    assert.equal(cfg.getRange('C4').getValue(), ''); // old GitHub link gone
    assert.match(cfg.getRange('B2').getValue(), /^Quốc gia: VN, TH · Ngôn ngữ: vie · Thể loại: tất cả · Mức 4a - Có hình hoặc tiếng · Bỏ qua: 2 mục$/);
    assert.deepEqual(cfg.getRange('A8:B9').getValues(), [['', ''], ['', '']]); // old summary gone until the next run
    assert.equal(cfg.getProtections('RANGE').length, 0); // old range warnings removed
    assert.equal(gas.triggers.filter((t) => t.handler === 'onConfigEdit').length, 0);
    gas.ctx.setup(); // again: nothing moves twice
    assert.deepEqual(gas.get({ action: 'status' }).config.countries, ['VN', 'TH']);
  });
  test('cập nhật code mà chưa chạy Cài đặt ban đầu → lần load đầu tiên tự chuyển cấu hình', () => {
    const gas = oldSheet({ countries: 'TH', exclude: [['https://x/bad.m3u8', '', '']] });
    gas.ss.insertSheet('_data');
    gas.props.set('BRIDGE_TOKEN', 't'.repeat(64));
    const res = gas.post({ token: 't'.repeat(64), action: 'load' });
    assert.equal(res.config.countries, 'TH');
    assert.deepEqual(res.exclude, ['https://x/bad.m3u8']);
    assert.equal(gas.sheet('Exclude'), null);
  });
  test('chạy setup lần 2 không đổi cấu hình, không tạo trigger/token mới', () => {
    const { gas, token } = ready();
    assert.equal(saveSettings(gas, { scope: { countries: ['TH'] } }).ok, true);
    gas.ctx.setup();
    assert.deepEqual(gas.get({ action: 'status' }).config.countries, ['TH']);
    assert.equal(gas.props.get('BRIDGE_TOKEN'), token);
    assert.equal(gas.triggers.filter((t) => t.handler === 'autoRun').length, 1);
  });
});

describe('Code.gs — web app (load / save)', () => {
  test('sai token → unauthorized, kèm mã kiểm tra hai phía (giống mã tính ở Node)', () => {
    const { gas, token } = ready();
    const wrong = gas.post({ token: 'wrong', action: 'load' });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error,
      `unauthorized: Sheet ở link này chờ token mã ${tokenCode(token)}, nhưng nhận được token mã ${tokenCode('wrong')} dài 5 ký tự`);
    assert.match(gas.post({ action: 'load' }).error, /nhận được token rỗng$/);
  });
  test('Apps Script chưa có token (link thuộc Sheet khác) → nói rõ', () => {
    const { gas } = ready();
    gas.props.delete('BRIDGE_TOKEN');
    assert.match(gas.post({ token: 'x', action: 'load' }).error, /^unauthorized: Apps Script ở link này chưa có bridge token/);
  });
  test('menu Xem bridge token: hộp copy token + URL /exec + mã kiểm tra', () => {
    const { gas, token } = ready();
    gas.withUi();
    gas.ctx.showBridgeToken();
    const { title, html } = gas.dialogs.at(-1);
    assert.equal(title, 'Bridge token');
    assert.ok(html.includes(`value="${token}"`));
    assert.ok(html.includes('value="https://script.google.com/macros/s/FAKE_ID/exec"'));
    assert.ok(html.includes(`Mã kiểm tra: <b>${tokenCode(token)}</b>`));
  });
  test('token dán kèm dấu cách / xuống dòng vẫn được chấp nhận', () => {
    const { gas, token } = ready();
    assert.equal(gas.post({ token: ` ${token}\n`, action: 'load' }).ok, true);
  });
  test('load trả cấu hình + danh sách loại trừ (lưu trong Apps Script)', () => {
    const { gas, token } = ready();
    saveSettings(gas, {
      scope: { countries: ['VN'], languages: ['vie'], categories: [] },
      exclude: [{ entry: 'https://x/bad.m3u8', note: 'hỏng' }, { entry: '  https://x/b2.m3u8 ', note: '' }],
    });
    const res = gas.post({ token, action: 'load' });
    assert.equal(res.ok, true);
    assert.deepEqual(res.config, { countries: 'VN', languages: 'vie', categories: '', level: '3 - Tải được dữ liệu video' });
    assert.deepEqual(res.exclude, ['https://x/bad.m3u8', 'https://x/b2.m3u8']);
    assert.equal(res.data, null);
    assert.deepEqual(res.lastRun, {});
  });
  test('save ghi Streams / _data / tóm tắt; load đọc lại được', () => {
    const { gas, token } = ready();
    const out = gas.post({ token, action: 'save', ...savePayload() });
    assert.deepEqual(out, { ok: true, rows: 2 });

    const streams = gas.sheet('Streams').rows();
    assert.equal(streams.length, 3);
    assert.equal(streams[0][4], 'Trạng thái');
    assert.equal(streams[1][0], '=HYPERLINK("http://evil")'); // stored as text, not a formula
    assert.ok(isDate(streams[1][6]));
    assert.ok(gas.sheet('Streams').getFilter(), 'filter kept');

    const config = gas.sheet('Config');
    assert.ok(isDate(config.getRange('B8').getValue()));
    assert.equal(config.getRange('A9').getValue(), 'Nguồn dữ liệu');
    assert.equal(config.getRange('B10').getValue(), 2);
    assert.deepEqual(JSON.parse(gas.props.get('LAST_RUN')), { sourceCount: 2, configHash: 'abc123' });

    const loaded = gas.post({ token, action: 'load' });
    assert.deepEqual(loaded.data.header, ['url', 'title', 'status', 'failStreak', 'lastChecked']);
    assert.equal(loaded.data.rows.length, 2);
    assert.equal(loaded.data.rows[1][3], 2);
    assert.deepEqual(loaded.lastRun, { sourceCount: 2, configHash: 'abc123' });
  });
  test('save lần sau ít dòng hơn: không còn dòng cũ; giữ tiêu chí lọc của MKT', () => {
    const { gas, token } = ready();
    gas.post({ token, action: 'save', ...savePayload() });
    gas.sheet('Streams').getFilter().setColumnFilterCriteria(5, { status: 'Không hoạt động' });
    const one = savePayload();
    one.data.rows = one.data.rows.slice(0, 1);
    one.streams.rows = one.streams.rows.slice(0, 1);
    gas.post({ token, action: 'save', ...one });
    assert.equal(gas.sheet('Streams').rows().length, 2);
    assert.equal(gas.sheet('_data').rows().length, 2);
    assert.deepEqual(gas.sheet('Streams').getFilter().getColumnFilterCriteria(5), { status: 'Không hoạt động' });
  });
  test('save lưu "đang bỏ" của từng mục bỏ qua → dashboard đọc được', () => {
    const { gas, token } = ready();
    saveSettings(gas, { exclude: [{ entry: 'An Ninh', note: 'kênh an ninh' }, { entry: 'vtv', note: '' }] });
    gas.post({ token, action: 'save', ...savePayload(), exclude: [{ entry: 'An Ninh', text: '2 link: ANTV' }, { entry: 'vtv', text: '55 link: VTV1, …' }] });
    assert.deepEqual(gas.get({ action: 'status' }).config.exclude, [
      { entry: 'An Ninh', note: 'kênh an ninh', report: '2 link: ANTV' },
      { entry: 'vtv', note: '', report: '55 link: VTV1, …' },
    ]);
  });
  test('danh sách bỏ qua dài (300 mục, có dấu) vẫn lưu được dù mỗi giá trị Script Properties chỉ 9 kB', () => {
    const { gas } = ready();
    const lines = Array.from({ length: 300 }, (_, i) => ({ entry: `Kênh truyền hình địa phương số ${i}`, note: 'Ghi chú tiếng Việt có dấu '.repeat(4) }));
    assert.equal(saveSettings(gas, { exclude: lines }).ok, true);
    assert.equal(gas.get({ action: 'status' }).config.exclude.length, 300);
    assert.ok(Number(gas.props.get('EXCLUDE_N')) > 1);
    saveSettings(gas, { exclude: lines.slice(0, 2) }); // shorter: old chunks removed
    assert.equal(gas.props.get('EXCLUDE_N'), '1');
    assert.equal(gas.props.has('EXCLUDE_1'), false);
  });
  describe('sheet Streams bản mới (22 cột cho MKT)', () => {
    const row = {
      url: 'https://a/1.m3u8', channel: 'VTV1.vn', feed: 'HD', title: '24/7 VTV1', country: 'VN', countryName: 'Việt Nam', flag: '🇻🇳',
      quality: '1080p', status: 'ONLINE', error: '', lastChecked: Date.UTC(2026, 8, 23, 3, 17), categories: ['news', 'general'],
      logo: 'https://img.example/vtv1.png', region: 'Đông Nam Á', subdivision: '', city: '', languageNames: 'Tiếng Việt',
      format: '1080i', network: '', owners: 'Vietnam Television', website: 'https://vtv.vn/', launched: '1970-09-07', closed: '', guide: 'vtv.vn',
    };
    const evil = { ...row, url: 'https://a/2.m3u8', title: 'VTV2', status: 'OFFLINE', error: 'HTTP_404', logo: 'https://x/a.png") & HYPERLINK("http://evil', launched: '2019-01-01' };
    const payload = () => ({
      ...savePayload(),
      streams: toStreamsTable([row, evil], { categoryNames: { news: 'Tin tức', general: 'Tổng hợp' } }),
    });
    const col = (gas, name) => gas.sheet('Streams').rows()[0].indexOf(name) + 1;
    const value = (gas, r, name) => gas.sheet('Streams').get(r, col(gas, name));

    test('logo hiện bằng IMAGE(); link logo lạ (có dấu ") bị bỏ, không thành công thức', () => {
      const { gas, token } = ready();
      assert.equal(gas.post({ token, action: 'save', ...payload() }).ok, true);
      const rows = gas.sheet('Streams').rows();
      assert.deepEqual(rows[0], STREAMS_HEADER);
      assert.equal(value(gas, 2, 'Logo'), '=IMAGE("https://img.example/vtv1.png")');
      assert.equal(value(gas, 3, 'Logo'), '');
      assert.equal(value(gas, 3, 'Link logo'), evil.logo); // as plain text
      assert.equal(value(gas, 2, 'Thể loại'), 'Tin tức, Tổng hợp');
      assert.deepEqual(gas.sheet('Streams').rowHeights, { start: 2, n: 2, h: 30 });
    });
    test('ngày ra mắt / kiểm tra lúc là ô ngày; chữ dễ bị Sheets hiểu nhầm ("24/7", "2019-01-01", "1080p") giữ nguyên dạng chữ', () => {
      const { gas, token } = ready();
      gas.post({ token, action: 'save', ...payload() });
      const launched = value(gas, 2, 'Ngày ra mắt');
      assert.ok(isDate(launched));
      assert.equal(launched.toISOString(), '1970-09-07T12:00:00.000Z'); // same day in any Sheet time zone
      assert.equal(value(gas, 2, 'Ngày đóng'), '');
      assert.ok(isDate(value(gas, 2, 'Kiểm tra lúc')));
      const formats = gas.sheet('Streams').formats.map((f) => [f.col, f.format]);
      assert.deepEqual(formats.filter(([c]) => [7, 19, 20].includes(c)), [[7, 'dd/MM/yyyy HH:mm'], [19, 'dd/MM/yyyy'], [20, 'dd/MM/yyyy']]);
      const text = gas.sheet('Streams').plainText;
      assert.ok(text.has(`2,${col(gas, 'Tên kênh')}`) && text.has(`2,${col(gas, 'Độ phân giải')}`));
      // _data keeps the date as text, so it reads back unchanged
      gas.post({ token, action: 'save', ...payload(), data: toDataTable([row]) });
      assert.equal(gas.post({ token, action: 'load' }).data.rows[0][DATA_COLUMNS.indexOf('launched')], '1970-09-07');
    });
    test('Sheet cũ 7 cột → cột mới, bộ lọc MKT đi theo tên cột, đặt lại độ rộng / màu trạng thái', () => {
      const { gas, token } = ready();
      gas.post({ token, action: 'save', ...savePayload() }); // old layout: Quốc gia = C, Trạng thái = E
      const sh = gas.sheet('Streams');
      sh.getFilter().setColumnFilterCriteria(3, { country: 'Việt Nam' }).setColumnFilterCriteria(5, { status: 'Không hoạt động' })
        .setColumnFilterCriteria(2, { channel: 'x' });
      gas.post({ token, action: 'save', ...payload() });
      const f = sh.getFilter();
      assert.deepEqual(f.getColumnFilterCriteria(col(gas, 'Quốc gia')), { country: 'Việt Nam' });
      assert.deepEqual(f.getColumnFilterCriteria(col(gas, 'Trạng thái')), { status: 'Không hoạt động' });
      assert.equal(f.getColumnFilterCriteria(col(gas, 'Mã kênh')), null); // "Kênh" is now "Mã kênh": its filter is dropped
      assert.equal(f.range.getLastColumn(), 22);
      assert.equal(sh.frozenColumns, 1);
      assert.equal(sh.widths[col(gas, 'Link')], 360);
      // MKT resizes a column: a save with the same columns keeps it
      sh.setColumnWidth(col(gas, 'Link'), 500);
      gas.post({ token, action: 'save', ...payload() });
      assert.equal(sh.widths[col(gas, 'Link')], 500);
    });
    test('checker bản cũ (7 cột, dateColumn) vẫn ghi được', () => {
      const { gas, token } = ready();
      gas.post({ token, action: 'save', ...payload() });
      assert.equal(gas.post({ token, action: 'save', ...savePayload() }).ok, true);
      assert.equal(gas.sheet('Streams').rows()[0].length, 7);
      assert.ok(isDate(gas.sheet('Streams').get(2, 7)));
    });
    test('Cài đặt ban đầu: sheet Streams mới có sẵn 22 cột', () => {
      const { gas } = ready();
      assert.deepEqual(gas.sheet('Streams').rows()[0], STREAMS_HEADER);
      assert.equal(gas.sheet('Streams').getFilter().range.getLastColumn(), 22);
    });
  });
  test('save 12,000 dòng (vượt 1,000 dòng mặc định của sheet)', () => {
    const { gas, token } = ready();
    const p = savePayload();
    p.data.rows = Array.from({ length: 12000 }, (_, i) => [`https://a/${i}.m3u8`, `Kênh ${i}`, 'ONLINE', 0, 1]);
    p.streams.rows = Array.from({ length: 12000 }, (_, i) => [`Kênh ${i}`, 'X.vn', 'VN', `https://a/${i}.m3u8`, 'Hoạt động', '', 1]);
    assert.equal(gas.post({ token, action: 'save', ...p }).ok, true);
    assert.equal(gas.sheet('_data').rows().length, 12001);
  });
});

describe('Code.gs — Chạy ngay và tự chạy khi sửa cấu hình', () => {
  test('menu Chạy ngay → gọi GitHub API, ghi thông báo', () => {
    const { gas } = ready();
    gas.props.set('GITHUB_TOKEN', 'github_pat_test');
    gas.ctx.runNow();
    const posts = gas.fetches.filter((f) => f.opts.method === 'post');
    assert.equal(posts.length, 1);
    const { url, opts } = posts[0];
    assert.equal(url, 'https://api.github.com/repos/TienBeta/iptv_monitor/actions/workflows/check.yml/dispatches');
    assert.equal(opts.method, 'post');
    assert.equal(opts.headers.Authorization, 'Bearer github_pat_test');
    assert.deepEqual(JSON.parse(opts.payload), { ref: 'main' });
    assert.match(gas.sheet('Config').getRange('B5').getValue(), /^Đã gửi yêu cầu chạy/);
    assert.equal(gas.sheet('Config').getRange('B4').getValue(), '⏳ Đang chờ GitHub bắt đầu chạy…');
  });
  test('chưa có GitHub token / token sai → thông báo rõ ràng', () => {
    const { gas } = ready();
    gas.ctx.runNow();
    assert.match(gas.sheet('Config').getRange('B5').getValue(), /chưa nhập GitHub token/);
    gas.props.set('GITHUB_TOKEN', 'expired');
    gas.setFetchCode(401);
    gas.ctx.runNow();
    assert.match(gas.sheet('Config').getRange('B5').getValue(), /sai hoặc đã hết hạn/);
  });
  test('lưu cấu hình nhiều lần liền nhau trên dashboard → chỉ 1 lần chạy, hẹn sau ~1 phút', () => {
    const { gas } = ready();
    gas.props.set('GITHUB_TOKEN', 't');
    saveSettings(gas, { scope: { countries: ['TH'] } });
    saveSettings(gas, { level: '1 - Link có phản hồi' });
    saveSettings(gas, { exclude: [{ entry: 'An Ninh', note: '' }] });
    assert.equal(gas.triggers.filter((t) => t.handler === 'scheduledRun').length, 1);
    assert.equal(gas.fetches.length, 0);
    gas.ctx.scheduledRun();
    assert.equal(gas.fetches.filter((f) => f.opts.method === 'post').length, 1);
    assert.equal(gas.triggers.filter((t) => t.handler === 'scheduledRun').length, 0);
  });
  test('trigger sửa Sheet của bản cũ (nếu còn) chỉ tự gỡ, không chạy lại', () => {
    const { gas } = ready();
    gas.triggers.push({ handler: 'onConfigEdit', kind: 'edit', getHandlerFunction: () => 'onConfigEdit' });
    gas.edit('Config', 'B2');
    assert.equal(gas.triggers.filter((t) => t.handler === 'onConfigEdit').length, 0);
    assert.equal(gas.triggers.filter((t) => t.handler === 'scheduledRun').length, 0);
  });
});

describe('Code.gs — ô "Trạng thái" và khoá nút Chạy ngay', () => {
  const tick = (gas) => gas.ctx.runNow();
  const watchers = (gas) => gas.triggers.filter((t) => t.handler === 'watchRun').length;
  const progress = (gas) => gas.sheet('Config').getRange('B4').getValue();
  const link = (gas) => gas.sheet('Config').links['4,3'];
  const color = (gas) => gas.sheet('Config').backgrounds['4,2'];
  const posts = (gas) => gas.fetches.filter((f) => f.opts.method === 'post').length;
  function started() {
    const { gas } = ready();
    gas.props.set('GITHUB_TOKEN', 't');
    tick(gas);
    return gas;
  }
  const run = (extra) => ({ id: 1, created_at: new Date().toISOString(), html_url: 'https://github.com/TienBeta/iptv_monitor/actions/runs/1', ...extra });

  test('setup: ô Trạng thái = "Sẵn sàng"', () => {
    const { gas } = ready();
    assert.equal(gas.sheet('Config').getRange('A4').getValue(), 'Trạng thái');
    assert.equal(progress(gas), 'Sẵn sàng');
  });
  test('sau khi gửi: "⏳ Đang chờ" (nền vàng), không có link GitHub, 1 trigger theo dõi', () => {
    const gas = started();
    assert.equal(progress(gas), '⏳ Đang chờ GitHub bắt đầu chạy…');
    assert.equal(color(gas), '#fff4cc');
    assert.equal(link(gas), undefined);
    assert.equal(gas.sheet('Config').getRange('C8').getValue(), '');
    assert.equal(watchers(gas), 1);
  });
  test('bấm lại ngay khi GitHub chưa kịp hiện lần chạy → bị chặn, không gửi thêm', () => {
    const gas = started();
    tick(gas);
    tick(gas);
    assert.equal(posts(gas), 1);
    assert.match(gas.sheet('Config').getRange('B5').getValue(), /^Đang có một lần chạy/);
    assert.equal(watchers(gas), 1);
  });
  test('đang có lần chạy (kể cả chạy theo lịch) → bị chặn, hiện "Đang chạy" và theo dõi lần đó', () => {
    const { gas } = ready();
    gas.props.set('GITHUB_TOKEN', 't');
    gas.setRuns([run({ id: 77, event: 'schedule', status: 'in_progress', run_started_at: new Date(Date.now() - 60000).toISOString() })]);
    tick(gas);
    assert.equal(posts(gas), 0);
    assert.match(gas.sheet('Config').getRange('B5').getValue(), /^Đang có một lần chạy/);
    assert.match(progress(gas), /^⏳ Đang chạy… \(bắt đầu \d\d:\d\d, đã 1 phút\)$/);
    assert.equal(JSON.parse(gas.props.get('RUN_WATCH')).runId, 77);
    gas.setRuns([run({ id: 77, status: 'completed', conclusion: 'success', updated_at: new Date().toISOString() })]);
    gas.ctx.watchRun();
    assert.match(progress(gas), /^✓ Xong lúc/);
    tick(gas); // now allowed
    assert.equal(posts(gas), 1);
  });
  test('sửa cấu hình khi đang chạy → vẫn xếp hàng 1 lần chạy để áp dụng cấu hình mới', () => {
    const { gas } = ready();
    gas.props.set('GITHUB_TOKEN', 't');
    gas.setRuns([run({ status: 'in_progress', run_started_at: new Date().toISOString() })]);
    saveSettings(gas, { scope: { countries: ['TH'] } });
    gas.ctx.scheduledRun();
    assert.equal(posts(gas), 1);
    assert.equal(gas.sheet('Config').getRange('B5').getValue(), 'Cấu hình đã đổi — sẽ chạy lại ngay sau lần chạy hiện tại.');
  });
  test('đang chạy → "Đang chạy… (bắt đầu hh:mm, đã N phút)"', () => {
    const gas = started();
    gas.setRuns([run({ status: 'in_progress', run_started_at: new Date(Date.now() - 2 * 60000).toISOString() })]);
    gas.ctx.watchRun();
    assert.match(progress(gas), /^⏳ Đang chạy… \(bắt đầu \d\d:\d\d, đã 2 phút\)$/);
    assert.equal(link(gas), undefined);
    assert.equal(watchers(gas), 1);
  });
  test('checker báo số link ("progress", cần bridge token) → "đã N phút với M link"; dashboard nhận run.links của đúng lần chạy', () => {
    const gas = started();
    const token = gas.props.get('BRIDGE_TOKEN');
    const startedAt = Date.now() - 2 * 60000;
    gas.setRuns([run({ status: 'in_progress', run_started_at: new Date(startedAt).toISOString() })]);
    assert.match(gas.post({ action: 'progress', links: 84 }).error, /^unauthorized/);
    assert.deepEqual(gas.post({ token, action: 'progress', links: 84 }), { ok: true });
    gas.ctx.watchRun();
    assert.match(progress(gas), /^⏳ Đang chạy… \(bắt đầu \d\d:\d\d, đã 2 phút với 84 link\)$/);
    assert.equal(gas.get({ action: 'status' }).run.links, 84);
    gas.setRuns([run({ status: 'completed', conclusion: 'success', run_started_at: new Date(startedAt).toISOString(), updated_at: new Date().toISOString() })]);
    gas.ctx.watchRun();
    const done = gas.get({ action: 'status' }).run;
    assert.deepEqual([done.phase, done.links], ['success', 84]);
    // the next run has not reported yet: no count from the previous one
    gas.props.set('RUN_STATE', JSON.stringify({ phase: 'running', startedAt: Date.now() + 1000 }));
    assert.equal('links' in gas.get({ action: 'status' }).run, false);
  });
  test('xong → "✓ Xong lúc …", dừng theo dõi', () => {
    const gas = started();
    gas.setRuns([run({ status: 'completed', conclusion: 'success', updated_at: new Date().toISOString() })]);
    gas.ctx.watchRun();
    assert.match(progress(gas), /^✓ Xong lúc \d\d:\d\d — có thể bấm Chạy ngay lại$/);
    assert.equal(color(gas), '#d9f2e3');
    assert.equal(watchers(gas), 0);
    assert.equal(gas.props.has('RUN_WATCH'), false);
  });
  test('lỗi → "✗ Lỗi lúc … thử Chạy ngay lại; nếu vẫn lỗi, báo người quản lý", dừng theo dõi', () => {
    const gas = started();
    gas.setRuns([run({ status: 'completed', conclusion: 'failure', updated_at: new Date().toISOString() })]);
    gas.ctx.watchRun();
    assert.match(progress(gas), /^✗ Lỗi lúc \d\d:\d\d — thử Chạy ngay lại; nếu vẫn lỗi, báo người quản lý$/);
    assert.equal(color(gas), '#f8d4d4');
    assert.equal(link(gas), undefined);
    assert.equal(watchers(gas), 0);
  });
  test('chỉ có lần chạy cũ (trước khi bấm) → bỏ qua, tiếp tục chờ', () => {
    const gas = started();
    gas.setRuns([run({ status: 'completed', conclusion: 'failure', created_at: new Date(Date.now() - 3600000).toISOString() })]);
    gas.ctx.watchRun();
    assert.equal(progress(gas), '⏳ Đang chờ GitHub bắt đầu chạy…');
    assert.equal(watchers(gas), 1);
  });
  test('gửi yêu cầu thất bại → không bật theo dõi', () => {
    const { gas } = ready();
    tick(gas); // no GitHub token
    assert.equal(watchers(gas), 0);
    assert.equal(progress(gas), 'Sẵn sàng');
  });
});

describe('Code.gs — lịch tự chạy', () => {
  // Việt Nam = UTC+7: vn(4, 3) = 04:03 giờ Việt Nam ngày 24/09/2026
  const vn = (h, m = 0) => Date.UTC(2026, 8, 24, h - 7, m);
  const at = (gas, ms) => { gas.ctx.Date.now = () => ms; };
  const posts = (gas) => gas.fetches.filter((f) => f.opts.method === 'post').length;
  function scheduled() {
    const { gas } = ready();
    gas.props.set('GITHUB_TOKEN', 't');
    return gas;
  }

  test('setup: trigger autoRun mỗi 10 phút; mặc định mỗi 3 giờ từ 01:00 (giống cron cũ)', () => {
    const { gas } = ready();
    const auto = gas.triggers.filter((t) => t.handler === 'autoRun');
    assert.equal(auto.length, 1);
    assert.equal(auto[0].minutes, 10);
    gas.ctx.setup();
    assert.equal(gas.triggers.filter((t) => t.handler === 'autoRun').length, 1);
    const { schedule } = gas.get({ action: 'status' });
    assert.deepEqual(schedule.hours, [1, 4, 7, 10, 13, 16, 19, 22]);
    assert.equal(schedule.enabled, true);
  });
  test('đến giờ → chạy đúng 1 lần cho lượt đó', () => {
    const gas = scheduled();
    at(gas, vn(4, 3));
    gas.ctx.autoRun();
    assert.equal(posts(gas), 1);
    assert.equal(gas.sheet('Config').getRange('B5').getValue(), 'Tự chạy theo lịch (lượt 04:00).');
    assert.equal(gas.get({ action: 'status' }).run.phase, 'queued');
    at(gas, vn(4, 13));
    gas.ctx.autoRun();
    at(gas, vn(5, 50));
    gas.ctx.autoRun();
    assert.equal(posts(gas), 1);
    at(gas, vn(7, 1));
    gas.setRuns([]);
    gas.props.delete('RUN_WATCH');
    gas.ctx.autoRun();
    assert.equal(posts(gas), 2);
  });
  test('trigger tắt lâu (quá 1 giờ sau lượt) → không chạy bù, đợi lượt sau', () => {
    const gas = scheduled();
    at(gas, vn(5, 30));
    gas.ctx.autoRun();
    assert.equal(posts(gas), 0);
    assert.equal(gas.get({ action: 'status' }).schedule.next, vn(7));
  });
  test('lần trước chưa xong → bỏ qua lượt này, không xếp hàng', () => {
    const gas = scheduled();
    gas.setRuns([{ id: 5, status: 'in_progress', created_at: new Date(vn(3, 50)).toISOString(), run_started_at: new Date(vn(3, 50)).toISOString() }]);
    at(gas, vn(4, 5));
    gas.ctx.autoRun();
    assert.equal(posts(gas), 0);
    assert.equal(gas.sheet('Config').getRange('B5').getValue(), 'Bỏ qua lượt tự chạy 04:00 vì lần chạy trước chưa xong.');
  });
  test('GitHub token hết hạn → báo lỗi ở ô Trạng thái và trên dashboard', () => {
    const gas = scheduled();
    gas.setFetchCode(401);
    at(gas, vn(4, 5));
    gas.ctx.autoRun();
    const { run } = gas.get({ action: 'status' });
    assert.equal(run.phase, 'error');
    assert.match(run.message, /^Không tự chạy được lượt 04:00: GitHub token sai hoặc đã hết hạn/);
    assert.match(gas.sheet('Config').getRange('B4').getValue(), /^✗ Không tự chạy được lượt 04:00/);
  });
  test('tắt tự chạy → không chạy; next = null', () => {
    const gas = scheduled();
    gas.props.set('DASHBOARD_CODE', 'ABCDEFGH');
    at(gas, vn(3, 55));
    const res = gas.post({ action: 'schedule', code: 'ABCD-EFGH', schedule: { enabled: false, everyHours: 3, startHour: 1 } });
    assert.equal(res.ok, true);
    assert.equal(res.status.schedule.next, null);
    assert.match(gas.sheet('Config').getRange('B3').getValue(), /^Đang tắt/);
    at(gas, vn(4, 5));
    gas.ctx.autoRun();
    assert.equal(posts(gas), 0);
  });
  test('đổi lịch: mỗi 6 giờ từ 07:00 → 01, 07, 13, 19; không chạy bù ngay lúc đổi', () => {
    const gas = scheduled();
    gas.props.set('DASHBOARD_CODE', 'ABCDEFGH');
    at(gas, vn(7, 20));
    const res = gas.post({ action: 'schedule', code: 'abcdefgh', schedule: { enabled: true, everyHours: 6, startHour: 7 } });
    assert.equal(res.ok, true);
    assert.deepEqual(res.status.schedule.hours, [1, 7, 13, 19]);
    assert.equal(res.status.schedule.next, vn(13));
    assert.match(gas.sheet('Config').getRange('B5').getValue(), /^Lịch tự chạy: mỗi 6 giờ \(01:00, 07:00, 13:00, 19:00\)/);
    assert.equal(gas.sheet('Config').getRange('B3').getValue(), 'Mỗi 6 giờ (01:00, 07:00, 13:00, 19:00)');
    gas.ctx.autoRun();
    assert.equal(posts(gas), 0);
    at(gas, vn(13, 4));
    gas.ctx.autoRun();
    assert.equal(posts(gas), 1);
  });
  test('mỗi 24 giờ từ 08:00 → một lượt/ngày; lượt kế tiếp có thể là ngày mai', () => {
    const gas = scheduled();
    gas.props.set('DASHBOARD_CODE', 'ABCDEFGH');
    at(gas, vn(9));
    const res = gas.post({ action: 'schedule', code: 'ABCDEFGH', schedule: { enabled: true, everyHours: 24, startHour: 8 } });
    assert.deepEqual(res.status.schedule.hours, [8]);
    assert.equal(res.status.schedule.next, vn(8) + 24 * 3600 * 1000);
  });
  test('lịch không hợp lệ → từ chối, giữ lịch cũ', () => {
    const gas = scheduled();
    gas.props.set('DASHBOARD_CODE', 'ABCDEFGH');
    const bad = gas.post({ action: 'schedule', code: 'ABCDEFGH', schedule: { enabled: true, everyHours: 5, startHour: 1 } });
    assert.deepEqual([bad.ok, bad.error], [false, 'invalid']);
    const bad2 = gas.post({ action: 'schedule', code: 'ABCDEFGH', schedule: { enabled: true, everyHours: 3, startHour: 24 } });
    assert.equal(bad2.error, 'invalid');
    assert.equal(gas.get({ action: 'status' }).schedule.everyHours, 3);
  });
});

describe('Code.gs — dashboard (trạng thái, Chạy ngay, mã thao tác)', () => {
  const posts = (gas) => gas.fetches.filter((f) => f.opts.method === 'post').length;
  function withCode() {
    const { gas } = ready();
    gas.props.set('GITHUB_TOKEN', 't');
    return { gas, code: gas.props.get('DASHBOARD_CODE') };
  }

  test('setup tạo mã thao tác 8 ký tự dễ đọc (không có I, O, 0, 1), dạng ABCD-EFGH', () => {
    const { code } = withCode();
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });
  test('trạng thái: ai cũng xem được, không gọi GitHub', () => {
    const { gas } = withCode();
    const s = gas.get({ action: 'status' });
    assert.equal(s.ok, true);
    assert.equal(s.run.phase, 'idle');
    assert.deepEqual(s.ready, { github: true, code: true });
    assert.deepEqual(s.everyHoursOptions, [1, 2, 3, 4, 6, 8, 12, 24]);
    assert.equal(gas.fetches.length, 0);
    assert.ok(!JSON.stringify(s).includes(gas.props.get('DASHBOARD_CODE')));
    assert.deepEqual(gas.get({}), { ok: true, service: 'iptv-monitor' });
  });
  test('Chạy ngay: sai mã → từ chối; đúng mã (có gạch, chữ thường) → gửi, trạng thái "queued"', () => {
    const { gas, code } = withCode();
    const wrong = gas.post({ action: 'run', code: 'WRONG123' });
    assert.deepEqual([wrong.ok, wrong.error, wrong.message], [false, 'bad_code', 'Mã thao tác không đúng.']);
    assert.equal(posts(gas), 0);
    const res = gas.post({ action: 'run', code: code.replace('-', '').toLowerCase() });
    assert.equal(res.ok, true);
    assert.equal(res.status.run.phase, 'queued');
    assert.equal(posts(gas), 1);
    assert.match(gas.sheet('Config').getRange('B5').getValue(), /^Đã gửi yêu cầu chạy từ dashboard lúc/);
  });
  test('Chạy ngay khi đang có lần chạy → từ chối, không gửi thêm', () => {
    const { gas, code } = withCode();
    gas.post({ action: 'run', code });
    const again = gas.post({ action: 'run', code });
    assert.deepEqual([again.ok, again.error], [false, 'busy']);
    assert.equal(posts(gas), 1);
  });
  test('Sheet đang ghi kết quả (giữ khoá) → coi như đang chạy', () => {
    const { gas, code } = withCode();
    gas.ctx.__lockBusy = true;
    assert.equal(gas.post({ action: 'run', code }).error, 'busy');
    assert.equal(posts(gas), 0);
  });
  test('chưa có GitHub token → báo rõ', () => {
    const { gas, code } = withCode();
    gas.props.delete('GITHUB_TOKEN');
    assert.equal(gas.get({ action: 'status' }).ready.github, false);
    const res = gas.post({ action: 'run', code });
    assert.equal(res.error, 'dispatch');
    assert.match(res.message, /chưa nhập GitHub token/);
  });
  test('đoán mã: sai 10 lần → khoá 15 phút, kể cả mã đúng; hết 15 phút → dùng lại được', () => {
    const { gas, code } = withCode();
    const t0 = Date.now();
    gas.ctx.Date.now = () => t0;
    for (let i = 0; i < 10; i++) assert.equal(gas.post({ action: 'run', code: `BAD${i}` }).error, 'bad_code');
    const locked = gas.post({ action: 'run', code });
    assert.equal(locked.error, 'locked');
    assert.match(locked.message, /thử lại sau 15 phút/);
    assert.equal(posts(gas), 0);
    gas.ctx.Date.now = () => t0 + 16 * 60 * 1000;
    assert.equal(gas.post({ action: 'run', code }).ok, true);
  });
  test('Sheet chưa có mã (Apps Script cũ nâng cấp) → báo cách tạo mã', () => {
    const { gas } = withCode();
    gas.props.delete('DASHBOARD_CODE');
    const res = gas.post({ action: 'run', code: 'X' });
    assert.equal(res.error, 'no_code');
    assert.match(res.message, /Quản trị → Đặt \/ đổi mã thao tác dashboard/);
  });
  test('lần chạy xong → trạng thái dashboard có phase, giờ bắt đầu / xong, link', () => {
    const { gas, code } = withCode();
    gas.post({ action: 'run', code });
    const started = new Date(Date.now() - 120000).toISOString();
    gas.setRuns([{ id: 9, status: 'completed', conclusion: 'success', created_at: new Date().toISOString(), run_started_at: started, updated_at: new Date().toISOString(), html_url: 'https://github.com/x/runs/9' }]);
    gas.ctx.watchRun();
    const { run } = gas.get({ action: 'status' });
    assert.equal(run.phase, 'success');
    assert.equal(run.startedAt, Date.parse(started));
    assert.ok(run.finishedAt >= run.startedAt);
    assert.equal(run.url, 'https://github.com/x/runs/9');
  });
  test('lần chạy bấm trên GitHub (không qua Sheet) → load bật theo dõi để dashboard thấy', () => {
    const { gas, token } = ready();
    gas.props.set('GITHUB_TOKEN', 't');
    gas.post({ token, action: 'load' });
    assert.equal(gas.get({ action: 'status' }).run.phase, 'running');
    assert.equal(gas.triggers.filter((t) => t.handler === 'watchRun').length, 1);
    gas.post({ token, action: 'load' }); // already watching: nothing new
    assert.equal(gas.triggers.filter((t) => t.handler === 'watchRun').length, 1);
  });
  test('Apps Script cũ chưa có trigger autoRun → mở dashboard (status) tự bật lịch', () => {
    const { gas } = withCode();
    gas.triggers.splice(0, gas.triggers.length);
    gas.get({ action: 'status' });
    assert.equal(gas.triggers.filter((t) => t.handler === 'autoRun').length, 1);
  });
  test('trigger autoRun bị tạo trùng → chỉ giữ 1', () => {
    const { gas } = withCode();
    gas.ctx.ScriptApp.newTrigger('autoRun').timeBased().everyMinutes(10).create();
    gas.get({ action: 'status' });
    assert.equal(gas.triggers.filter((t) => t.handler === 'autoRun').length, 1);
  });
  test('menu Đặt / đổi mã: hộp nhập hiện mã hiện tại + link dashboard; bấm Huỷ → không đổi', () => {
    const { gas, code } = withCode();
    gas.withUi();
    gas.ctx.__prompt = { button: 'CANCEL', text: '' };
    gas.ctx.setDashboardCode();
    const shown = gas.dialogs.at(-1);
    assert.equal(shown.prompt, 'Mã thao tác dashboard');
    assert.ok(shown.text.startsWith(`Mã hiện tại: ${code}\n`));
    assert.ok(shown.text.includes('https://tienbeta.github.io/iptv_monitor/'));
    assert.equal(gas.props.get('DASHBOARD_CODE'), code);
  });
  test('Sheet chưa có mã (chưa chạy Cài đặt ban đầu) → mở menu là có mã mới, hiện luôn trong hộp', () => {
    const { gas } = withCode();
    gas.props.delete('DASHBOARD_CODE');
    gas.withUi();
    gas.ctx.__prompt = { button: 'CANCEL', text: '' };
    gas.ctx.setDashboardCode();
    const code = gas.props.get('DASHBOARD_CODE');
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.ok(gas.dialogs.at(-1).text.startsWith(`Mã hiện tại: ${code}`));
  });
  test('Xem bridge token: hộp HTML không mở được → vẫn hiện token bằng hộp thông báo', () => {
    const { gas, code } = withCode();
    const token = gas.props.get('BRIDGE_TOKEN');
    gas.withUi();
    gas.ctx.__htmlDialogFails = true;
    gas.ctx.showBridgeToken();
    assert.equal(gas.dialogs.at(-1).title, 'Bridge token');
    assert.ok(gas.dialogs.at(-1).alert.includes(token));
    assert.ok(code);
  });
  describe('tự đặt mã (menu Đặt / đổi mã thao tác)', () => {
    const setCode = (gas, answer) => {
      gas.withUi();
      gas.ctx.__prompt = answer;
      gas.ctx.setDashboardCode();
    };
    test('mã tự chọn → dùng được, không phân biệt hoa thường / dấu gạch; mã cũ hết hiệu lực', () => {
      const { gas, code } = withCode();
      setCode(gas, { button: 'OK', text: '  Vulcan 2026 ' });
      assert.equal(gas.props.get('DASHBOARD_CODE'), 'VULCAN 2026');
      assert.equal(gas.dialogs.at(-1).title, 'Đã đổi mã thao tác dashboard');
      assert.ok(gas.dialogs.at(-1).alert.startsWith('Mã: VULCAN 2026\n'));
      assert.equal(gas.post({ action: 'run', code }).error, 'bad_code');
      assert.equal(gas.post({ action: 'run', code: 'vulcan-2026' }).ok, true);
    });
    test('mã giữ nguyên qua Cài đặt ban đầu', () => {
      const { gas } = withCode();
      setCode(gas, { button: 'OK', text: 'MKT-TEAM-01' });
      gas.ctx.setup();
      assert.equal(gas.props.get('DASHBOARD_CODE'), 'MKT-TEAM-01');
    });
    test('mã không hợp lệ → báo lỗi, giữ mã cũ', () => {
      const { gas, code } = withCode();
      for (const text of ['abc12', 'mã số 2026', 'abc!2026', '111111', '123456', '987654', 'A'.repeat(33)]) {
        setCode(gas, { button: 'OK', text });
        assert.match(gas.dialogs.at(-1).alert, /Mã cũ vẫn giữ nguyên/, text);
        assert.equal(gas.props.get('DASHBOARD_CODE'), code, text);
      }
    });
    test('bấm Huỷ (kể cả đã gõ) hoặc để trống bấm OK → giữ mã hiện tại', () => {
      const { gas, code } = withCode();
      setCode(gas, { button: 'CANCEL', text: 'ABCDEF123' });
      assert.equal(gas.props.get('DASHBOARD_CODE'), code);
      setCode(gas, { button: 'OK', text: '   ' });
      assert.equal(gas.props.get('DASHBOARD_CODE'), code);
    });
    test('đặt mã mới xoá bộ đếm nhập sai', () => {
      const { gas } = withCode();
      for (let i = 0; i < 10; i++) gas.post({ action: 'run', code: `BAD${i}` });
      setCode(gas, { button: 'OK', text: 'NEWCODE-26' });
      assert.equal(gas.post({ action: 'run', code: 'newcode26' }).ok, true);
    });
  });
});

describe('Code.gs — dashboard đổi cấu hình (settings)', () => {
  const vn = (h, m = 0) => Date.UTC(2026, 8, 24, h - 7, m);
  const L4B = '4b - Giải mã được hình';
  const L3 = '3 - Tải được dữ liệu video';
  const same = { enabled: true, everyHours: 3, startHour: 1 };
  function withCode() {
    const { gas } = ready();
    gas.props.set('GITHUB_TOKEN', 't');
    return { gas, code: gas.props.get('DASHBOARD_CODE') };
  }
  const reruns = (gas) => gas.triggers.filter((t) => t.handler === 'scheduledRun').length;
  const config = (gas) => gas.get({ action: 'status' }).config;

  test('trạng thái có toàn bộ cấu hình (ai cũng xem được) + danh sách mức', () => {
    const { gas } = withCode();
    const s = gas.get({ action: 'status' });
    assert.deepEqual(s.config, { countries: ['VN'], languages: [], categories: [], level: L3, exclude: [], rev: 1 });
    assert.equal(s.levelOptions.length, 5);
    assert.equal(s.levelOptions[4], L4B);
  });
  test('đổi mức → lưu, hẹn chạy lại ~1 phút; ô Cấu hình trong Sheet cập nhật', () => {
    const { gas, code } = withCode();
    const res = gas.post({ action: 'settings', code, level: L4B, schedule: same });
    assert.equal(res.ok, true);
    assert.equal(res.message, 'Đã lưu mức kiểm tra. Sẽ tự chạy lại sau khoảng 1–2 phút.');
    assert.equal(res.status.config.level, L4B);
    assert.equal(res.status.config.rev, 2);
    assert.equal(reruns(gas), 1);
    assert.match(gas.sheet('Config').getRange('B2').getValue(), /· Mức 4b - Giải mã được hình ·/);
    assert.match(gas.sheet('Config').getRange('B5').getValue(), /^Cấu hình đổi từ dashboard lúc \d\d:\d\d \(mức kiểm tra\) — sẽ tự chạy lại/);
    gas.ctx.scheduledRun();
    assert.equal(gas.fetches.filter((f) => f.opts.method === 'post').length, 1);
  });
  test('đổi phạm vi: mã quốc gia viết thường / GB đều được; bỏ trùng', () => {
    const { gas, code } = withCode();
    const res = gas.post({ action: 'settings', code, scope: { countries: ['vn', 'th', 'GB', 'VN'], languages: ['VIE'], categories: ['news'] } });
    assert.equal(res.ok, true);
    assert.deepEqual([res.status.config.countries, res.status.config.languages, res.status.config.categories], [['VN', 'TH', 'UK'], ['vie'], ['news']]);
    const load = gas.post({ token: gas.props.get('BRIDGE_TOKEN'), action: 'load' });
    assert.deepEqual(load.config, { countries: 'VN, TH, UK', languages: 'vie', categories: 'news', level: L3 });
    assert.equal(reruns(gas), 1);
  });
  test('để trống quốc gia = tất cả quốc gia', () => {
    const { gas, code } = withCode();
    gas.post({ action: 'settings', code, scope: { countries: [], languages: [], categories: [] } });
    assert.deepEqual(config(gas).countries, []);
    assert.match(gas.sheet('Config').getRange('B2').getValue(), /^Quốc gia: tất cả ·/);
  });
  test('danh sách bỏ qua: thêm / sửa ghi chú / xoá; bỏ dòng trống và trùng', () => {
    const { gas, code } = withCode();
    gas.post({ action: 'settings', code, exclude: [{ entry: ' An Ninh ', note: 'a' }, { entry: '', note: 'x' }, { entry: 'An Ninh', note: 'b' }, { entry: 'VTV1', note: '' }] });
    assert.deepEqual(config(gas).exclude.map((e) => [e.entry, e.note]), [['An Ninh', 'a'], ['VTV1', '']]);
    assert.equal(gas.post({ token: gas.props.get('BRIDGE_TOKEN'), action: 'load' }).exclude.join('|'), 'An Ninh|VTV1');
    gas.post({ action: 'settings', code, exclude: [{ entry: 'VTV1', note: 'giữ VTV10' }] });
    assert.deepEqual(config(gas).exclude, [{ entry: 'VTV1', note: 'giữ VTV10', report: '' }]);
    assert.match(gas.sheet('Config').getRange('B2').getValue(), /Bỏ qua: 1 mục$/);
  });
  test('giá trị không hợp lệ → không lưu gì (kể cả phần hợp lệ gửi kèm)', () => {
    const { gas, code } = withCode();
    for (const body of [
      { level: '5 - Siêu', schedule: same },
      { level: L4B, schedule: { enabled: true, everyHours: 5, startHour: 1 } },
      { level: L4B, scope: { countries: ['Việt Nam'] } },
      { scope: { languages: ['vi'] } },
      { exclude: [{ entry: 'x'.repeat(201), note: '' }] },
      { exclude: Array.from({ length: 301 }, (_, i) => ({ entry: `K${i}`, note: '' })) },
    ]) {
      assert.equal(gas.post({ action: 'settings', code, ...body }).error, 'invalid', JSON.stringify(body).slice(0, 60));
    }
    assert.equal(config(gas).level, L3);
    assert.deepEqual(config(gas).countries, ['VN']);
    assert.equal(config(gas).rev, 1);
    assert.equal(reruns(gas), 0);
  });
  test('người khác vừa lưu (rev cũ) → từ chối, trả cấu hình mới nhất', () => {
    const { gas, code } = withCode();
    const rev = config(gas).rev;
    gas.post({ action: 'settings', code, rev, scope: { countries: ['TH'] } }); // someone else
    const res = gas.post({ action: 'settings', code, rev, level: L4B });
    assert.deepEqual([res.ok, res.error], [false, 'conflict']);
    assert.deepEqual(res.status.config.countries, ['TH']);
    assert.equal(config(gas).level, L3);
    assert.equal(gas.post({ action: 'settings', code, rev: res.status.config.rev, level: L4B }).ok, true);
  });
  test('chỉ đổi lịch → không chạy lại', () => {
    const { gas, code } = withCode();
    const res = gas.post({ action: 'settings', code, schedule: { enabled: true, everyHours: 6, startHour: 7 } });
    assert.equal(res.message, 'Đã lưu lịch tự chạy.');
    assert.equal(reruns(gas), 0);
  });
  test('sai mã → từ chối, không đổi gì', () => {
    const { gas } = withCode();
    assert.equal(gas.post({ action: 'settings', code: 'WRONG-1', level: L4B, scope: { countries: ['TH'] } }).error, 'bad_code');
    assert.equal(config(gas).level, L3);
    assert.deepEqual(config(gas).countries, ['VN']);
  });
  test('không đổi gì → không chạy lại, không làm mất lượt tự chạy sắp tới', () => {
    const { gas, code } = withCode();
    gas.ctx.Date.now = () => vn(4, 2); // lượt 04:00 chưa được trigger chạy
    const res = gas.post({ action: 'settings', code, level: L3, schedule: same, scope: { countries: ['VN'] }, exclude: [] });
    assert.equal(res.message, 'Không có gì thay đổi.');
    assert.equal(reruns(gas), 0);
    gas.ctx.Date.now = () => vn(4, 5);
    gas.ctx.autoRun();
    assert.equal(gas.fetches.filter((f) => f.opts.method === 'post').length, 1);
  });
});
