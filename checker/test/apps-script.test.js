// Runs the real apps-script/Code.gs against an in-memory Sheet.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { tokenCode } from '../bridge.js';
import { loadAppsScript } from './fake-apps-script.js';

const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]';

function ready() {
  const gas = loadAppsScript();
  gas.ctx.setup();
  return { gas, token: gas.props.get('BRIDGE_TOKEN') };
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
  test('setup tạo 4 sheet, token, trigger sửa; xoá sheet mặc định trống', () => {
    const { gas, token } = ready();
    assert.deepEqual(gas.ss.getSheets().map((s) => s.getName()), ['Config', 'Exclude', 'Streams', '_data']);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(gas.sheet('_data').hidden, true);
    assert.equal(gas.sheet('Config').getRange('B3').getValue(), 'VN');
    assert.equal(gas.sheet('Config').getRange('A7').getValue(), 'Lịch tự chạy');
    assert.equal(gas.sheet('Config').getRange('B7').getValue(), 'Mỗi 3 giờ (01:00, 04:00, 07:00, 10:00, 13:00, 16:00, 19:00, 22:00)');
    assert.equal(gas.sheet('Config').getRange('A9').getValue(), 'Thông báo');
    assert.equal(gas.sheet('Config').getRange('A10').getValue(), 'LẦN CHẠY GẦN NHẤT');
    assert.equal(gas.triggers.filter((t) => t.handler === 'onConfigEdit').length, 1);
    assert.equal(gas.ss.tz, 'Asia/Ho_Chi_Minh');
  });
  test('Sheet bố cục cũ (ô tick B7, tóm tắt từ dòng 10) → setup chuyển sang bố cục mới, giữ cấu hình', () => {
    const { gas } = ready();
    const sh = gas.sheet('Config');
    sh.getRange('B3').setValue('VN, TH');
    sh.getRange('A7:C7').setValues([['Chạy ngay', false, 'Đã gửi yêu cầu chạy lúc 10:00']]);
    sh.getRange('A9').setValue('LẦN CHẠY GẦN NHẤT');
    sh.getRange('A10:B12').setValues([['Thời điểm', new gas.ctx.Date()], ['Nguồn dữ liệu', 'Bình thường'], ['Mức kiểm tra', '3']]);
    sh.getRange('B8').setValue('✓ Xong lúc 10:02');
    sh.getRange('C8').setValue('Xem chi tiết trên GitHub');
    gas.ctx.setup();
    assert.equal(sh.getRange('C8').getValue(), ''); // old GitHub link removed
    assert.deepEqual(sh.getRange('A7:A10').getValues().map((r) => r[0]), ['Lịch tự chạy', 'Trạng thái', 'Thông báo', 'LẦN CHẠY GẦN NHẤT']);
    assert.match(sh.getRange('B7').getValue(), /^Mỗi 3 giờ/);
    assert.equal(sh.getRange('B8').getValue(), '✓ Xong lúc 10:02'); // status kept
    assert.equal(sh.getRange('B9').getValue(), '');
    assert.deepEqual(sh.getRange('A11:B12').getValues(), [['', ''], ['', '']]); // old summary gone
    assert.equal(sh.getRange('B3').getValue(), 'VN, TH');
    const descriptions = sh.getProtections('RANGE').map((p) => p.getDescription());
    gas.ctx.setup();
    assert.deepEqual(sh.getProtections('RANGE').map((p) => p.getDescription()), descriptions); // no duplicates
    assert.ok(descriptions.includes('Lịch, trạng thái, thông báo (script tự ghi)'));
  });
  test('chạy setup lần 2 không ghi đè cấu hình, không tạo trigger/token mới', () => {
    const { gas, token } = ready();
    gas.sheet('Config').getRange('B3').setValue('TH');
    gas.ctx.setup();
    assert.equal(gas.sheet('Config').getRange('B3').getValue(), 'TH');
    assert.equal(gas.props.get('BRIDGE_TOKEN'), token);
    assert.equal(gas.triggers.filter((t) => t.handler === 'onConfigEdit').length, 1);
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
  test('load trả cấu hình + danh sách loại trừ', () => {
    const { gas, token } = ready();
    gas.sheet('Config').getRange('B4').setValue('vie');
    gas.sheet('Exclude').getRange('A2:B3').setValues([['https://x/bad.m3u8', 'hỏng'], ['  https://x/b2.m3u8 ', '']]);
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
    assert.ok(isDate(config.getRange('B11').getValue()));
    assert.equal(config.getRange('A12').getValue(), 'Nguồn dữ liệu');
    assert.equal(config.getRange('B13').getValue(), 2);
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
    assert.match(gas.sheet('Config').getRange('B9').getValue(), /^Đã gửi yêu cầu chạy/);
    assert.equal(gas.sheet('Config').getRange('B8').getValue(), '⏳ Đang chờ GitHub bắt đầu chạy…');
  });
  test('chưa có GitHub token / token sai → thông báo rõ ràng', () => {
    const { gas } = ready();
    gas.ctx.runNow();
    assert.match(gas.sheet('Config').getRange('B9').getValue(), /chưa nhập GitHub token/);
    gas.props.set('GITHUB_TOKEN', 'expired');
    gas.setFetchCode(401);
    gas.ctx.runNow();
    assert.match(gas.sheet('Config').getRange('B9').getValue(), /sai hoặc đã hết hạn/);
  });
  test('sửa ô cấu hình nhiều lần → chỉ 1 lần chạy hẹn sau ~1 phút', () => {
    const { gas } = ready();
    gas.props.set('GITHUB_TOKEN', 't');
    gas.edit('Config', 'B3');
    gas.edit('Config', 'B6');
    gas.edit('Exclude', 'A2');
    assert.equal(gas.triggers.filter((t) => t.handler === 'scheduledRun').length, 1);
    assert.equal(gas.fetches.length, 0);
    gas.ctx.scheduledRun();
    assert.equal(gas.fetches.filter((f) => f.opts.method === 'post').length, 1);
    assert.equal(gas.triggers.filter((t) => t.handler === 'scheduledRun').length, 0);
  });
  test('sửa cột hướng dẫn, ô lịch / trạng thái / thông báo hoặc khối kết quả → không chạy lại', () => {
    const { gas } = ready();
    gas.edit('Config', 'C3');
    for (const a1 of ['B7', 'B8', 'B9', 'B12']) gas.edit('Config', a1);
    assert.equal(gas.triggers.filter((t) => t.handler === 'scheduledRun').length, 0);
  });
});

describe('Code.gs — ô "Trạng thái" và khoá nút Chạy ngay', () => {
  const tick = (gas) => gas.ctx.runNow();
  const watchers = (gas) => gas.triggers.filter((t) => t.handler === 'watchRun').length;
  const progress = (gas) => gas.sheet('Config').getRange('B8').getValue();
  const link = (gas) => gas.sheet('Config').links['8,3'];
  const color = (gas) => gas.sheet('Config').backgrounds['8,2'];
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
    assert.equal(gas.sheet('Config').getRange('A8').getValue(), 'Trạng thái');
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
    assert.match(gas.sheet('Config').getRange('B9').getValue(), /^Đang có một lần chạy/);
    assert.equal(watchers(gas), 1);
  });
  test('đang có lần chạy (kể cả chạy theo lịch) → bị chặn, hiện "Đang chạy" và theo dõi lần đó', () => {
    const { gas } = ready();
    gas.props.set('GITHUB_TOKEN', 't');
    gas.setRuns([run({ id: 77, event: 'schedule', status: 'in_progress', run_started_at: new Date(Date.now() - 60000).toISOString() })]);
    tick(gas);
    assert.equal(posts(gas), 0);
    assert.match(gas.sheet('Config').getRange('B9').getValue(), /^Đang có một lần chạy/);
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
    gas.edit('Config', 'B3');
    gas.ctx.scheduledRun();
    assert.equal(posts(gas), 1);
    assert.equal(gas.sheet('Config').getRange('B9').getValue(), 'Cấu hình đã đổi — sẽ chạy lại ngay sau lần chạy hiện tại.');
  });
  test('đang chạy → "Đang chạy… (bắt đầu hh:mm, đã N phút)"', () => {
    const gas = started();
    gas.setRuns([run({ status: 'in_progress', run_started_at: new Date(Date.now() - 2 * 60000).toISOString() })]);
    gas.ctx.watchRun();
    assert.match(progress(gas), /^⏳ Đang chạy… \(bắt đầu \d\d:\d\d, đã 2 phút\)$/);
    assert.equal(link(gas), undefined);
    assert.equal(watchers(gas), 1);
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
    assert.equal(gas.sheet('Config').getRange('B9').getValue(), 'Tự chạy theo lịch (lượt 04:00).');
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
    assert.equal(gas.sheet('Config').getRange('B9').getValue(), 'Bỏ qua lượt tự chạy 04:00 vì lần chạy trước chưa xong.');
  });
  test('GitHub token hết hạn → báo lỗi ở ô Trạng thái và trên dashboard', () => {
    const gas = scheduled();
    gas.setFetchCode(401);
    at(gas, vn(4, 5));
    gas.ctx.autoRun();
    const { run } = gas.get({ action: 'status' });
    assert.equal(run.phase, 'error');
    assert.match(run.message, /^Không tự chạy được lượt 04:00: GitHub token sai hoặc đã hết hạn/);
    assert.match(gas.sheet('Config').getRange('B8').getValue(), /^✗ Không tự chạy được lượt 04:00/);
  });
  test('tắt tự chạy → không chạy; next = null', () => {
    const gas = scheduled();
    gas.props.set('DASHBOARD_CODE', 'ABCDEFGH');
    at(gas, vn(3, 55));
    const res = gas.post({ action: 'schedule', code: 'ABCD-EFGH', schedule: { enabled: false, everyHours: 3, startHour: 1 } });
    assert.equal(res.ok, true);
    assert.equal(res.status.schedule.next, null);
    assert.match(gas.sheet('Config').getRange('B7').getValue(), /^Đang tắt/);
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
    assert.match(gas.sheet('Config').getRange('B9').getValue(), /^Lịch tự chạy: mỗi 6 giờ \(01:00, 07:00, 13:00, 19:00\)/);
    assert.equal(gas.sheet('Config').getRange('B7').getValue(), 'Mỗi 6 giờ (01:00, 07:00, 13:00, 19:00)');
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
    assert.match(gas.sheet('Config').getRange('B9').getValue(), /^Đã gửi yêu cầu chạy từ dashboard lúc/);
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

describe('Code.gs — dashboard đổi mức kiểm tra (settings)', () => {
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

  test('trạng thái có mức kiểm tra hiện tại (ô B6) và danh sách mức', () => {
    const { gas } = withCode();
    const s = gas.get({ action: 'status' });
    assert.equal(s.config.level, L3);
    assert.equal(s.levelOptions.length, 5);
    assert.equal(s.levelOptions[4], L4B);
  });
  test('đổi mức → ghi ô B6, hẹn chạy lại ~1 phút như khi sửa trong Sheet', () => {
    const { gas, code } = withCode();
    const res = gas.post({ action: 'settings', code, level: L4B, schedule: same });
    assert.equal(res.ok, true);
    assert.match(res.message, /tự chạy lại với mức kiểm tra mới/);
    assert.equal(gas.sheet('Config').getRange('B6').getValue(), L4B);
    assert.equal(res.status.config.level, L4B);
    assert.equal(reruns(gas), 1);
    assert.match(gas.sheet('Config').getRange('B9').getValue(), /^Mức kiểm tra đổi thành "4b - Giải mã được hình" từ dashboard/);
    gas.ctx.scheduledRun();
    assert.equal(gas.fetches.filter((f) => f.opts.method === 'post').length, 1);
  });
  test('mức không hợp lệ, hoặc lịch sai kèm mức đúng → không lưu gì', () => {
    const { gas, code } = withCode();
    assert.equal(gas.post({ action: 'settings', code, level: '5 - Siêu', schedule: same }).error, 'invalid');
    const bad = gas.post({ action: 'settings', code, level: L4B, schedule: { enabled: true, everyHours: 5, startHour: 1 } });
    assert.equal(bad.error, 'invalid');
    assert.equal(gas.sheet('Config').getRange('B6').getValue(), L3);
    assert.equal(reruns(gas), 0);
  });
  test('sai mã → từ chối, không đổi mức', () => {
    const { gas } = withCode();
    assert.equal(gas.post({ action: 'settings', code: 'WRONG-1', level: L4B }).error, 'bad_code');
    assert.equal(gas.sheet('Config').getRange('B6').getValue(), L3);
  });
  test('không đổi gì → không chạy lại, không làm mất lượt tự chạy sắp tới', () => {
    const { gas, code } = withCode();
    gas.ctx.Date.now = () => vn(4, 2); // lượt 04:00 chưa được trigger chạy
    const res = gas.post({ action: 'settings', code, level: L3, schedule: same });
    assert.equal(res.message, 'Không có gì thay đổi.');
    assert.equal(reruns(gas), 0);
    gas.ctx.Date.now = () => vn(4, 5);
    gas.ctx.autoRun();
    assert.equal(gas.fetches.filter((f) => f.opts.method === 'post').length, 1);
  });
});
