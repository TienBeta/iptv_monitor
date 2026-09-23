// End-to-end: fake iptv-org API → checker → Apps Script web app (302 like the
// real one) → in-memory Sheet, plus results.json. Covers source failures,
// the 50% guard, Exclude, state carried across runs, and local mode.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { runMonitor } from '../index.js';
import { loadAppsScript, startWebApp } from './fake-apps-script.js';
import { hlsMedia, send, startServer, tsPacket } from './helpers.js';

const FAST = { requestTimeoutMs: 600, connectTimeoutMs: 300, streamBudgetMs: 3000, retryDelayMs: 20 };

let streams;
let api;
let apiMode = 'ok'; // ok | down | empty | shrink
let web;
let gas;

const channel = (id, country) => ({ id, country, categories: ['general'], is_nsfw: false, closed: null });

before(async () => {
  let brokenSeg = false;
  streams = await startServer({
    '/good.m3u8': send(200, hlsMedia(['s.ts'])),
    '/s.ts': send(200, tsPacket()),
    '/geo.m3u8': send(403, 'geo'),
    '/flip.m3u8': (req, res) => (brokenSeg ? send(404, 'gone')(req, res) : send(200, hlsMedia(['s.ts']))(req, res)),
    '/thai.m3u8': send(200, hlsMedia(['s.ts'])),
  });
  const s = (ch, feed, file, extra = {}) => ({
    channel: ch, feed, title: ch.split('.')[0], url: `${streams.base}/${file}`, quality: '720p', labels: [], referrer: null, user_agent: null, ...extra,
  });
  const fullList = () => [
    s('VTV1.vn', 'HD', 'good.m3u8'),
    s('VTV1.vn', 'HD', 'good.m3u8', { title: 'duplicate URL' }),
    s('VTV2.vn', 'HD', 'geo.m3u8?token=secret456', { labels: ['Geo-blocked'] }),
    s('VTV3.vn', 'HD', 'flip.m3u8'),
    s('HTV7.vn', 'HD', 'good.m3u8?token=secret123', { title: 'HTV7' }),
    s('THVL1.vn', 'HD', 'good.m3u8?b=1'),
    s('ThaiPBS.th', 'SD', 'thai.m3u8'),
  ];
  api = await startServer({
    '*': (req, res) => {
      if (apiMode === 'down') return send(502, 'bad gateway')(req, res);
      const name = new URL(req.url, 'http://x').pathname.slice(1);
      const channels = ['VTV1.vn', 'VTV2.vn', 'VTV3.vn', 'HTV7.vn', 'THVL1.vn'].map((id) => channel(id, 'VN')).concat(channel('ThaiPBS.th', 'TH'));
      const body = {
        'streams.json': apiMode === 'empty' ? [] : apiMode === 'shrink' ? fullList().slice(0, 1) : fullList(),
        'channels.json': channels,
        'feeds.json': [],
        'countries.json': [{ code: 'VN', name: 'Vietnam', flag: '🇻🇳' }, { code: 'TH', name: 'Thailand', flag: '🇹🇭' }],
      }[name];
      return body ? send(200, JSON.stringify(body), { 'Content-Type': 'application/json' })(req, res) : send(404, '')(req, res);
    },
  });
  gas = loadAppsScript();
  gas.ctx.setup();
  web = await startWebApp(gas);
  // expose a switch for the "stream dies" scenario
  streams.breakFlip = () => { brokenSeg = true; };
});
after(async () => {
  await web?.close();
  await api?.close();
  await streams?.close();
});

const outDir = mkdtempSync(path.join(tmpdir(), 'iptv-e2e-'));
const env = () => ({
  SHEET_BRIDGE_URL: web.url,
  SHEET_BRIDGE_TOKEN: gas.props.get('BRIDGE_TOKEN'),
  SOURCE_BASE: api.base,
  OUT_DIR: outDir,
  GITHUB_REPOSITORY: 'TienBeta/iptv_monitor',
});
const run = () => runMonitor({ env: env(), checkOptions: FAST });
const results = () => JSON.parse(readFileSync(path.join(outDir, 'results.json'), 'utf8'));
const streamsSheet = () => gas.sheet('Streams').rows().slice(1);
const byTitle = (title) => streamsSheet().find((r) => r[0] === title);
const config = (a1) => gas.sheet('Config').getRange(a1).getValue();

describe('toàn bộ luồng qua Google Sheet (giả lập)', () => {
  test('lần 1: API OK → lọc VN, bỏ URL trùng, ghi Sheet + results.json', async () => {
    const { saveError, summary } = await run();
    assert.equal(saveError, null);
    assert.equal(summary.sourceStatus, 'OK');
    assert.equal(summary.total, 5); // VN only, duplicate removed
    assert.equal(byTitle('VTV1')[4], 'Hoạt động');
    assert.equal(byTitle('VTV2')[4], 'Đang lỗi'); // first failure
    assert.equal(byTitle('VTV2')[5], 'Bị chặn truy cập (có thể do giới hạn quốc gia)');
    assert.equal(byTitle('VTV1')[2], '🇻🇳 Việt Nam');
    assert.equal(config('A11'), 'Nguồn dữ liệu');
    assert.equal(config('B11'), 'Bình thường');
    const data = results();
    assert.equal(data.total, 5);
    assert.equal(data.counts.ONLINE, 4);
    assert.equal(data.counts.FAILING, 1);
    assert.ok(!('referrer' in data.streams[0]));
    assert.deepEqual(data.streams.find((x) => x.title === 'VTV2').labels, ['Geo-blocked']);
  });
  test('lần 2: lỗi lần thứ 2 → Không hoạt động; stream vừa chết → Đang lỗi', async () => {
    streams.breakFlip();
    await run();
    assert.equal(byTitle('VTV2')[4], 'Không hoạt động');
    assert.equal(byTitle('VTV3')[4], 'Đang lỗi');
    assert.equal(byTitle('VTV3')[5], 'Link không còn tồn tại');
    const firstSeen = gas.sheet('_data').rows();
    const header = firstSeen[0];
    const vtv1 = firstSeen.find((r) => r[header.indexOf('title')] === 'VTV1');
    assert.ok(vtv1[header.indexOf('firstSeen')] < vtv1[header.indexOf('lastChecked')]);
  });
  test('API lỗi → SOURCE_ERROR, giữ danh sách cũ và vẫn check', async () => {
    apiMode = 'down';
    const { summary } = await run();
    assert.equal(summary.sourceStatus, 'SOURCE_ERROR');
    assert.equal(summary.total, 5);
    assert.equal(byTitle('VTV3')[4], 'Không hoạt động'); // checked again from the old list
    assert.match(config('B11'), /^Lỗi nguồn, đang dùng danh sách cũ/);
    assert.equal(results().sourceStatus, 'SOURCE_ERROR');
  });
  test('API trả rỗng → SOURCE_ERROR, không xoá dữ liệu', async () => {
    apiMode = 'empty';
    const { summary } = await run();
    assert.equal(summary.sourceStatus, 'SOURCE_ERROR');
    assert.equal(streamsSheet().length, 5);
  });
  test('số link tụt dưới 50% khi cấu hình không đổi → SOURCE_ERROR', async () => {
    apiMode = 'shrink';
    const { summary } = await run();
    assert.equal(summary.sourceStatus, 'SOURCE_ERROR');
    assert.match(summary.sourceMessage, /giảm bất thường: 1 so với 5/);
  });
  test('đổi cấu hình (thêm TH) → không bị coi là lỗi nguồn', async () => {
    apiMode = 'ok';
    gas.sheet('Config').getRange('B3').setValue('VN, TH');
    const { summary } = await run();
    assert.equal(summary.sourceStatus, 'OK');
    assert.equal(summary.total, 6);
    assert.equal(byTitle('ThaiPBS')[2], '🇹🇭 Thái Lan');
  });
  test('thu hẹp phạm vi (chỉ TH) → hợp lệ vì cấu hình đã đổi', async () => {
    gas.sheet('Config').getRange('B3').setValue('TH');
    const { summary } = await run();
    assert.equal(summary.sourceStatus, 'OK');
    assert.equal(summary.total, 1);
  });
  test('Exclude → link bị bỏ khỏi danh sách', async () => {
    gas.sheet('Config').getRange('B3').setValue('VN');
    gas.sheet('Exclude').getRange('A2').setValue(`${streams.base}/geo.m3u8?token=secret456`);
    const { summary } = await run();
    assert.equal(summary.total, 4);
    assert.equal(byTitle('VTV2'), undefined);
  });
  test('mức kiểm tra lấy từ dropdown trong Sheet', async () => {
    gas.sheet('Config').getRange('B6').setValue('1 - Link có phản hồi');
    const { summary } = await run();
    assert.equal(summary.level, '1');
    assert.equal(results().levelLabel, '1 - Link có phản hồi');
  });
  test('sai bridge token → dừng với lỗi rõ ràng', async () => {
    await assert.rejects(
      runMonitor({ env: { ...env(), SHEET_BRIDGE_TOKEN: 'wrong' }, checkOptions: FAST }),
      /Apps Script từ chối \(load\): Sheet ở link này chờ token mã [0-9A-F]{6}, nhưng nhận được token mã [0-9A-F]{6} dài 5 ký tự\. GitHub đang gửi token mã [0-9A-F]{6} dài 5 ký tự/,
    );
  });
});

describe('chế độ khác', () => {
  test('chạy trên GitHub Actions mà thiếu secret → báo lỗi', async () => {
    await assert.rejects(runMonitor({ env: { GITHUB_ACTIONS: 'true', OUT_DIR: outDir } }), /Thiếu secret SHEET_BRIDGE_URL/);
  });
  test('chạy local không cần Sheet: cấu hình qua biến môi trường, lưu state.json', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'iptv-local-'));
    const localEnv = { COUNTRIES: 'TH', LEVEL: '2', SOURCE_BASE: api.base, OUT_DIR: dir };
    const first = await runMonitor({ env: localEnv, checkOptions: FAST });
    assert.equal(first.summary.total, 1);
    assert.equal(first.rows[0].status, 'ONLINE');
    const second = await runMonitor({ env: localEnv, checkOptions: FAST });
    assert.equal(second.rows[0].firstSeen, first.rows[0].firstSeen);
  });
  test('log không lộ query string (token) của URL', async () => {
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
      gas.sheet('Config').getRange('B6').setValue('3 - Tải được dữ liệu video');
      gas.sheet('Config').getRange('B3').setValue('VN');
      gas.sheet('Exclude').getRange('A2').setValue('');
      await runMonitor({ env: env(), checkOptions: FAST });
    } finally {
      console.log = orig;
    }
    assert.ok(lines.some((l) => l.includes('HTTP_403') && l.includes('/geo.m3u8?…')), lines.join('\n'));
    assert.ok(lines.every((l) => !l.includes('secret')));
  });
});
