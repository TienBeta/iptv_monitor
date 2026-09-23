// 1,000 streams spread over 21 local "hosts" (one per port), with a mix of
// alive / 404 / hanging / refused, checked at level 3 and written to the fake
// Sheet. Timeouts are scaled down (×0.1) so the test runs in seconds.

import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, test } from 'node:test';
import { runChecks } from '../index.js';
import { toDataTable, toStreamsTable } from '../bridge.js';
import { nextState } from '../status.js';
import { loadAppsScript } from './fake-apps-script.js';
import { hlsMedia, send, startServer, tsPacket } from './helpers.js';

const SCALED = { requestTimeoutMs: 1000, connectTimeoutMs: 400, streamBudgetMs: 3000, retryDelayMs: 300 };
const servers = [];
let refusedPort;

before(async () => {
  for (let i = 0; i < 20; i++) {
    servers.push(await startServer({
      '/ok.m3u8': (req, res) => setTimeout(() => send(200, hlsMedia(['s.ts']))(req, res), 20 + Math.random() * 80),
      '/s.ts': send(200, tsPacket()),
      '/gone.m3u8': send(404, 'gone'),
      '/hang.m3u8': () => {},
    }));
  }
  refusedPort = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
});
after(() => Promise.all(servers.map((s) => s.close())));

test('1,000 stream, mức 3: xong nhanh, đủ kết quả, ghi Sheet 1 lần', async () => {
  const items = [];
  let n = 0;
  // 940 links on 20 live hosts: 75% ok, 13% 404, 12% hanging
  for (const srv of servers) {
    for (let i = 0; i < 47; i++, n++) {
      const kind = n % 100 < 75 ? 'ok' : n % 100 < 88 ? 'gone' : 'hang';
      items.push({ url: `${srv.base}/${kind}.m3u8?i=${n}`, host: srv.base.slice(7), kind });
    }
  }
  // 60 links on a dead host (connection refused) → circuit breaker
  for (let i = 0; i < 60; i++) items.push({ url: `http://127.0.0.1:${refusedPort}/x${i}.m3u8`, host: `127.0.0.1:${refusedPort}`, kind: 'refused' });
  assert.equal(items.length, 1000);

  const t0 = Date.now();
  const results = await runChecks(items, '3', { checkOptions: SCALED });
  const seconds = (Date.now() - t0) / 1000;

  assert.equal(results.size, 1000);
  const by = (kind) => items.filter((it) => it.kind === kind).map((it) => results.get(it.url));
  assert.ok(by('ok').every((r) => r.ok), 'all alive links ONLINE');
  assert.ok(by('gone').every((r) => r.code === 'HTTP_404'));
  assert.ok(by('hang').every((r) => r.code === 'TIMEOUT'));
  assert.ok(by('refused').every((r) => r.code === 'CONNECTION_ERROR'));
  assert.ok(by('refused').filter((r) => r.skipped).length >= 50, 'dead host skipped after 3 failures');
  // Bound: per host ~47 links / 3 connections × (hang 1s + 0.3s + 1s retry for 12%) ≈ 5 s
  assert.ok(seconds < 25, `took ${seconds}s`);
  console.log(`[scale] 1,000 link mức 3: ${seconds.toFixed(1)} giây`);

  const now = Date.now();
  const rows = items.map((it) => ({ ...it, title: it.kind, labels: [], ...nextState(undefined, results.get(it.url) || { at: now }) }));
  const gas = loadAppsScript();
  gas.ctx.setup();
  const w0 = Date.now();
  const out = gas.post({
    token: gas.props.get('BRIDGE_TOKEN'),
    action: 'save',
    data: toDataTable(rows),
    streams: toStreamsTable(rows),
    summary: { runAt: now, sourceCount: 1000, configHash: 'x', lines: [] },
  });
  assert.equal(out.ok, true);
  assert.equal(gas.sheet('Streams').rows().length, 1001);
  console.log(`[scale] ghi 1,000 dòng vào Sheet (giả lập): ${Date.now() - w0} ms`);
});
