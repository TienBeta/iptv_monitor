// Runs the real apps-script/Code.gs against an in-memory Sheet.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
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
    assert.equal(gas.sheet('Config').getRange('B7').getValue(), false);
    assert.equal(gas.triggers.filter((t) => t.handler === 'onConfigEdit').length, 1);
    assert.equal(gas.ss.tz, 'Asia/Ho_Chi_Minh');
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
  test('sai token → unauthorized', () => {
    const { gas } = ready();
    assert.deepEqual(gas.post({ token: 'wrong', action: 'load' }), { ok: false, error: 'unauthorized' });
    assert.deepEqual(gas.post({ action: 'load' }), { ok: false, error: 'unauthorized' });
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
    assert.ok(isDate(config.getRange('B10').getValue()));
    assert.equal(config.getRange('A11').getValue(), 'Nguồn dữ liệu');
    assert.equal(config.getRange('B12').getValue(), 2);
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
  test('tick ô Chạy ngay → gọi GitHub API, bỏ tick, ghi thông báo', () => {
    const { gas } = ready();
    gas.props.set('GITHUB_TOKEN', 'github_pat_test');
    gas.sheet('Config').getRange('B7').setValue(true);
    gas.edit('Config', 'B7');
    const posts = gas.fetches.filter((f) => f.opts.method === 'post');
    assert.equal(posts.length, 1);
    const { url, opts } = posts[0];
    assert.equal(url, 'https://api.github.com/repos/TienBeta/iptv_monitor/actions/workflows/check.yml/dispatches');
    assert.equal(opts.method, 'post');
    assert.equal(opts.headers.Authorization, 'Bearer github_pat_test');
    assert.deepEqual(JSON.parse(opts.payload), { ref: 'main' });
    assert.equal(gas.sheet('Config').getRange('B7').getValue(), false);
    assert.match(gas.sheet('Config').getRange('C7').getValue(), /^Đã gửi yêu cầu chạy/);
    assert.equal(gas.sheet('Config').getRange('B8').getValue(), '⏳ Đang chờ GitHub bắt đầu chạy…');
  });
  test('chưa có GitHub token / token sai → thông báo rõ ràng', () => {
    const { gas } = ready();
    gas.sheet('Config').getRange('B7').setValue(true);
    gas.edit('Config', 'B7');
    assert.match(gas.sheet('Config').getRange('C7').getValue(), /chưa nhập GitHub token/);
    gas.props.set('GITHUB_TOKEN', 'expired');
    gas.setFetchCode(401);
    gas.sheet('Config').getRange('B7').setValue(true);
    gas.edit('Config', 'B7');
    assert.match(gas.sheet('Config').getRange('C7').getValue(), /sai hoặc đã hết hạn/);
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
  test('sửa cột hướng dẫn hoặc khối kết quả → không chạy lại', () => {
    const { gas } = ready();
    gas.edit('Config', 'C3');
    gas.edit('Config', 'B12');
    assert.equal(gas.triggers.filter((t) => t.handler === 'scheduledRun').length, 0);
  });
});

describe('Code.gs — ô "Trạng thái" và khoá nút Chạy ngay', () => {
  const tick = (gas) => {
    gas.sheet('Config').getRange('B7').setValue(true);
    gas.edit('Config', 'B7');
  };
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
  test('sau khi gửi: "⏳ Đang chờ" (nền vàng), có link Actions, 1 trigger theo dõi', () => {
    const gas = started();
    assert.equal(progress(gas), '⏳ Đang chờ GitHub bắt đầu chạy…');
    assert.equal(color(gas), '#fff4cc');
    assert.equal(link(gas), 'https://github.com/TienBeta/iptv_monitor/actions/workflows/check.yml');
    assert.equal(watchers(gas), 1);
  });
  test('bấm lại ngay khi GitHub chưa kịp hiện lần chạy → bị chặn, không gửi thêm', () => {
    const gas = started();
    tick(gas);
    tick(gas);
    assert.equal(posts(gas), 1);
    assert.match(gas.sheet('Config').getRange('C7').getValue(), /^Đang có một lần chạy/);
    assert.equal(gas.sheet('Config').getRange('B7').getValue(), false);
    assert.equal(watchers(gas), 1);
  });
  test('đang có lần chạy (kể cả chạy theo lịch) → bị chặn, hiện "Đang chạy" và theo dõi lần đó', () => {
    const { gas } = ready();
    gas.props.set('GITHUB_TOKEN', 't');
    gas.setRuns([run({ id: 77, event: 'schedule', status: 'in_progress', run_started_at: new Date(Date.now() - 60000).toISOString() })]);
    tick(gas);
    assert.equal(posts(gas), 0);
    assert.match(gas.sheet('Config').getRange('C7').getValue(), /^Đang có một lần chạy/);
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
    assert.equal(gas.sheet('Config').getRange('C7').getValue(), 'Cấu hình đã đổi — sẽ chạy lại ngay sau lần chạy hiện tại.');
  });
  test('đang chạy → "Đang chạy… (bắt đầu hh:mm, đã N phút)", link tới lần chạy', () => {
    const gas = started();
    gas.setRuns([run({ status: 'in_progress', run_started_at: new Date(Date.now() - 2 * 60000).toISOString() })]);
    gas.ctx.watchRun();
    assert.match(progress(gas), /^⏳ Đang chạy… \(bắt đầu \d\d:\d\d, đã 2 phút\)$/);
    assert.equal(link(gas), 'https://github.com/TienBeta/iptv_monitor/actions/runs/1');
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
  test('lỗi → "✗ Lỗi lúc …" kèm link xem nguyên nhân, dừng theo dõi', () => {
    const gas = started();
    gas.setRuns([run({ status: 'completed', conclusion: 'failure', updated_at: new Date().toISOString() })]);
    gas.ctx.watchRun();
    assert.match(progress(gas), /^✗ Lỗi lúc/);
    assert.equal(color(gas), '#f8d4d4');
    assert.equal(link(gas), 'https://github.com/TienBeta/iptv_monitor/actions/runs/1');
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
