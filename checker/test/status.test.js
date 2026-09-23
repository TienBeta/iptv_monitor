// Status transitions, Vietnamese labels, concurrency pool, host circuit breaker.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { runChecks } from '../index.js';
import { nextState, reasonFor } from '../status.js';
import { runPool, sleep } from '../util.js';
import { send, startServer } from './helpers.js';

const ok = (at, extra = {}) => ({ ok: true, code: '', httpCode: 200, ms: 120, slow: false, at, ...extra });
const fail = (at, code = 'HTTP_404') => ({ ok: false, code, httpCode: 404, ms: 80, slow: false, at });

describe('nextState — ngưỡng 2 lần lỗi', () => {
  test('lỗi 1 lần → FAILING, 2 lần liên tiếp → OFFLINE, 1 lần thành công → ONLINE', () => {
    const s1 = nextState(undefined, fail(1000));
    assert.equal(s1.status, 'FAILING');
    assert.equal(s1.failStreak, 1);
    assert.equal(s1.firstSeen, 1000);
    const s2 = nextState(s1, fail(2000));
    assert.equal(s2.status, 'OFFLINE');
    assert.equal(s2.failStreak, 2);
    assert.equal(s2.firstSeen, 1000);
    const s3 = nextState(s2, ok(3000));
    assert.equal(s3.status, 'ONLINE');
    assert.equal(s3.failStreak, 0);
    assert.equal(s3.lastOnline, 3000);
    const s4 = nextState(s3, fail(4000));
    assert.equal(s4.status, 'FAILING');
    assert.equal(s4.lastOnline, 3000);
  });
  test('chậm → SLOW, vẫn tính là online', () => {
    const s = nextState(undefined, ok(1000, { slow: true, ms: 6200 }));
    assert.equal(s.status, 'SLOW');
    assert.equal(s.lastOnline, 1000);
    assert.equal(reasonFor('SLOW', ''), 'Phản hồi chậm (trên 5 giây)');
  });
  test('giao thức không hỗ trợ → UNSUPPORTED, không tính là lỗi', () => {
    const s = nextState(undefined, fail(1000, 'UNSUPPORTED_PROTOCOL'));
    assert.equal(s.status, 'UNSUPPORTED');
    assert.equal(s.failStreak, 0);
  });
  test('chưa kịp check: giữ trạng thái cũ; stream mới → PENDING', () => {
    const prev = { status: 'ONLINE', error: '', failStreak: 0, lastChecked: 500, lastOnline: 500, firstSeen: 100 };
    assert.equal(nextState(prev, undefined).status, 'ONLINE');
    assert.equal(nextState(prev, undefined).lastChecked, 500);
    assert.equal(nextState(undefined, undefined).status, 'PENDING');
  });
  test('lý do tiếng Việt cho MKT', () => {
    assert.equal(reasonFor('OFFLINE', 'HTTP_404'), 'Link không còn tồn tại');
    assert.equal(reasonFor('FAILING', 'TIMEOUT'), 'Quá thời gian chờ');
    assert.equal(reasonFor('OFFLINE', 'WHATEVER'), 'Lỗi không xác định');
    assert.equal(reasonFor('ONLINE', ''), '');
  });
});

describe('runPool — giới hạn song song', () => {
  test('không vượt giới hạn tổng và theo host; host lớn bắt đầu trước', async () => {
    const items = [
      ...Array.from({ length: 20 }, (_, i) => ({ id: `big${i}`, host: 'big' })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `small${i}`, host: `s${i}` })),
    ];
    let active = 0;
    let peak = 0;
    const perHost = {};
    const peakHost = {};
    const order = [];
    await runPool(items, {
      concurrency: 5,
      keyOf: (it) => it.host,
      hostLimit: (h) => (h === 'big' ? 3 : 1),
      worker: async (it) => {
        order.push(it.host);
        active++;
        perHost[it.host] = (perHost[it.host] || 0) + 1;
        peak = Math.max(peak, active);
        peakHost[it.host] = Math.max(peakHost[it.host] || 0, perHost[it.host]);
        await sleep(5);
        active--;
        perHost[it.host]--;
      },
    });
    assert.equal(order.length, 24);
    assert.equal(peak, 5);
    assert.equal(peakHost.big, 3);
    assert.equal(order[0], 'big');
  });
  test('dừng nhận việc mới khi hết ngân sách thời gian', async () => {
    let done = 0;
    let stop = false;
    await runPool(Array.from({ length: 50 }, (_, i) => ({ host: `h${i}` })), {
      concurrency: 5,
      keyOf: (it) => it.host,
      hostLimit: () => 1,
      shouldStop: () => stop,
      worker: async () => {
        await sleep(5);
        done++;
        if (done >= 10) stop = true;
      },
    });
    assert.ok(done >= 10 && done < 50, `done=${done}`);
  });
  test('danh sách rỗng kết thúc ngay', async () => {
    await runPool([], { concurrency: 5, keyOf: () => 'x', hostLimit: () => 1, worker: async () => {} });
  });
});

describe('runChecks — ngắt sớm host chết', () => {
  let srv;
  before(async () => {
    srv = await startServer({ '*': send(200, 'ok') });
  });
  after(() => srv.close());

  test('3 lỗi kết nối liên tiếp → phần còn lại của host không bị check', async () => {
    const dead = Array.from({ length: 12 }, (_, i) => ({ url: `http://no-such-host.invalid/${i}.m3u8`, host: 'no-such-host.invalid' }));
    const alive = Array.from({ length: 5 }, (_, i) => ({ url: `${srv.base}/ok${i}`, host: '127.0.0.1' }));
    const results = await runChecks([...dead, ...alive], '1', {
      checkOptions: { requestTimeoutMs: 800, connectTimeoutMs: 400, retryDelayMs: 10 },
    });
    const deadResults = dead.map((d) => results.get(d.url));
    assert.ok(deadResults.every((r) => r.code === 'DNS_ERROR'));
    assert.ok(deadResults.filter((r) => r.skipped).length >= 12 - 3 - 2); // at most ~3 in flight when it trips
    assert.ok(alive.every((a) => results.get(a.url).ok));
  });
  test('lỗi HTTP (404) không làm ngắt host', async () => {
    const srv404 = await startServer({ '*': send(404, 'nope') });
    const items = Array.from({ length: 8 }, (_, i) => ({ url: `${srv404.base}/x${i}`, host: 'h404' }));
    const results = await runChecks(items, '1', { checkOptions: { requestTimeoutMs: 800 } });
    await srv404.close();
    assert.ok(items.every((it) => results.get(it.url).code === 'HTTP_404' && !results.get(it.url).skipped));
  });
});
