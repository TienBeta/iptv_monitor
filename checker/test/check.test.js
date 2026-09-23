// Stream checks over HTTP (levels 1–3), error classification, headers, retry.

import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, describe, test } from 'node:test';
import { checkStream, detectKind, parseM3u8, sniffMedia } from '../check.js';
import { hlsMedia, send, startServer, tsPacket } from './helpers.js';

const FAST = { requestTimeoutMs: 800, connectTimeoutMs: 400, streamBudgetMs: 4000, retryDelayMs: 50, slowMs: 5000 };
const html = '<!doctype html><html><body>Service unavailable</body></html>';

let srv;
before(async () => {
  srv = await startServer({
    '/ok.bin': send(200, 'hello'),
    '/404': send(404, 'nope'),
    '/403': send(403, 'forbidden'),
    '/410': send(410, 'gone'),
    '/429': send(429, 'slow down'),
    '/500': send(500, 'boom'),
    '/empty.m3u8': send(200, ''),
    '/html': send(200, html, { 'Content-Type': 'text/html' }),
    '/media.m3u8': send(200, hlsMedia(['seg1.ts', 'seg2.ts'])),
    '/seg1.ts': send(200, tsPacket()),
    '/seg2.ts': (req, res) => {
      // Record the Range header; serve TS bytes.
      res.writeHead(req.headers.range ? 206 : 200);
      res.end(tsPacket());
    },
    '/master.m3u8': send(200, [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720',
      'hi.m3u8',
      '#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=900000,BANDWIDTH=500000,RESOLUTION=320x180',
      'lo.m3u8',
    ].join('\n')),
    '/hi.m3u8': send(200, hlsMedia(['seg1.ts'])),
    '/lo.m3u8': send(200, hlsMedia(['seg1.ts', 'seg2.ts'])),
    '/nosegments.m3u8': send(200, '#EXTM3U\n#EXT-X-VERSION:3\n'),
    '/badseg.m3u8': send(200, hlsMedia(['badseg.ts'])),
    '/badseg.ts': send(200, html),
    '/seg404.m3u8': send(200, hlsMedia(['missing.ts'])),
    '/enc.m3u8': send(200, hlsMedia(['enc.ts'], { key: true })),
    '/enc.ts': send(200, Buffer.from([0x13, 0x37, 0x42, 0x99, 0x00, 0x11])),
    '/dash.mpd': send(200, '<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic"></MPD>'),
    '/redirect': (req, res) => res.writeHead(302, { Location: '/media.m3u8' }).end(),
    '/loop': (req, res) => res.writeHead(302, { Location: '/loop' }).end(),
    '/hang': () => {}, // never answers
    '/slow.m3u8': (req, res) => setTimeout(() => send(200, hlsMedia(['seg1.ts']))(req, res), 300),
    '/live.ts': (req, res) => {
      // Endless live stream: keeps sending TS packets.
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      const timer = setInterval(() => res.write(tsPacket()), 5);
      req.on('close', () => clearInterval(timer));
    },
    '/needs-referer.m3u8': (req, res) => (req.headers.referer === 'https://site.example/player'
      ? send(200, hlsMedia(['seg1.ts']))(req, res) : send(403, 'no referer')(req, res)),
    '/needs-ua.m3u8': (req, res) => (req.headers['user-agent'] === 'MyPlayer/1.0'
      ? send(200, hlsMedia(['seg1.ts']))(req, res) : send(403, 'bad ua')(req, res)),
    '/flaky': (req, res, ctx) => (ctx.hits === 1 ? send(503, 'try later')(req, res) : send(200, 'ok')(req, res)),
    '/flaky404': send(404, 'nope'),
  });
});
after(() => srv.close());

const url = (p) => `${srv.base}${p}`;
const check = (p, level, opts = {}) => checkStream({ url: url(p), ...opts.stream }, level, { ...FAST, ...opts });

describe('mức 1 — HTTP 200', () => {
  test('HTTP 200 → ONLINE', async () => {
    const r = await check('/ok.bin', '1');
    assert.equal(r.ok, true);
    assert.equal(r.httpCode, 200);
  });
  test('tên miền (qua DNS, có cache) hoạt động như IP', async () => {
    const port = new URL(srv.base).port;
    for (let i = 0; i < 2; i++) {
      const r = await checkStream({ url: `http://localhost:${port}/ok.bin` }, '1', FAST);
      assert.equal(r.ok, true, JSON.stringify(r));
    }
  });
  test('HTTP 404 → HTTP_404, không retry', async () => {
    const before = srv.hits['/flaky404'] || 0;
    const r = await checkStream({ url: url('/flaky404') }, '1', FAST);
    assert.equal(r.code, 'HTTP_404');
    assert.equal(r.httpCode, 404);
    assert.equal(srv.hits['/flaky404'] - before, 1);
  });
  test('HTTP 403 / 410 / 429 / 500 được phân loại', async () => {
    assert.equal((await check('/403', '1')).code, 'HTTP_403');
    assert.equal((await check('/410', '1')).code, 'HTTP_4XX');
    assert.equal((await check('/429', '1', { allowRetry: false })).code, 'HTTP_429');
    assert.equal((await check('/500', '1', { allowRetry: false })).code, 'HTTP_5XX');
  });
  test('trang HTML trả 200 vẫn là ONLINE ở mức 1', async () => {
    assert.equal((await check('/html', '1')).ok, true);
  });
  test('luồng phát liên tục không làm treo (đọc đoạn đầu rồi dừng)', async () => {
    const t0 = Date.now();
    const r = await check('/live.ts', '1');
    assert.equal(r.ok, true);
    assert.ok(Date.now() - t0 < 1500);
  });
});

describe('mức 2 — playlist hợp lệ', () => {
  test('HLS hợp lệ → ONLINE', async () => {
    assert.equal((await check('/media.m3u8', '2')).ok, true);
  });
  test('master playlist → vào variant bitrate thấp nhất', async () => {
    const lo = srv.hits['/lo.m3u8'] || 0;
    const hi = srv.hits['/hi.m3u8'] || 0;
    const r = await check('/master.m3u8', '2');
    assert.equal(r.ok, true);
    assert.equal(srv.hits['/lo.m3u8'] - lo, 1);
    assert.equal((srv.hits['/hi.m3u8'] || 0) - hi, 0);
  });
  test('HTML thay cho playlist → INVALID_PLAYLIST', async () => {
    assert.equal((await check('/html', '2')).code, 'INVALID_PLAYLIST');
  });
  test('body rỗng → EMPTY_RESPONSE', async () => {
    assert.equal((await check('/empty.m3u8', '2')).code, 'EMPTY_RESPONSE');
  });
  test('playlist không có segment → INVALID_PLAYLIST', async () => {
    assert.equal((await check('/nosegments.m3u8', '2')).code, 'INVALID_PLAYLIST');
  });
  test('DASH có <MPD → ONLINE', async () => {
    assert.equal((await check('/dash.mpd', '2')).ok, true);
    assert.equal((await check('/dash.mpd', '3')).ok, true);
  });
  test('redirect được theo tới playlist', async () => {
    assert.equal((await check('/redirect', '2')).ok, true);
  });
  test('redirect vô hạn → UNKNOWN_ERROR', async () => {
    assert.equal((await check('/loop', '2')).code, 'UNKNOWN_ERROR');
  });
  test('link video trực tiếp → ONLINE', async () => {
    assert.equal((await check('/live.ts', '2')).ok, true);
  });
});

describe('mức 3 — tải được segment', () => {
  test('segment cuối là MPEG-TS → ONLINE, có gửi Range', async () => {
    const r = await check('/media.m3u8', '3');
    assert.equal(r.ok, true);
    const segReq = srv.requests.filter((x) => x.path === '/seg2.ts').at(-1);
    assert.equal(segReq.headers.range, 'bytes=0-4095');
  });
  test('segment trả HTML → INVALID_MEDIA', async () => {
    assert.equal((await check('/badseg.m3u8', '3')).code, 'INVALID_MEDIA');
  });
  test('segment 404 → SEGMENT_ERROR', async () => {
    const r = await check('/seg404.m3u8', '3');
    assert.equal(r.code, 'SEGMENT_ERROR');
    assert.equal(r.httpCode, 404);
  });
  test('HLS mã hoá: bỏ kiểm tra byte đầu', async () => {
    assert.equal((await check('/enc.m3u8', '3')).ok, true);
  });
});

describe('lỗi mạng, timeout, retry', () => {
  test('server không trả lời → TIMEOUT sau ~timeout, có retry 1 lần', async () => {
    const t0 = Date.now();
    const r = await check('/hang', '1');
    const took = Date.now() - t0;
    assert.equal(r.code, 'TIMEOUT');
    assert.equal(r.retried, true);
    assert.ok(took >= 1600 && took < 4000, `took ${took}ms`);
  });
  test('stream đang OFFLINE thì không retry', async () => {
    const r = await check('/hang', '1', { allowRetry: false });
    assert.equal(r.code, 'TIMEOUT');
    assert.equal(r.retried, undefined);
  });
  test('503 rồi 200 → retry thành công', async () => {
    const r = await check('/flaky', '1');
    assert.equal(r.ok, true);
    assert.equal(r.retried, true);
  });
  test('cổng đóng → CONNECTION_ERROR (giai đoạn kết nối)', async () => {
    const port = await new Promise((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
    const r = await checkStream({ url: `http://127.0.0.1:${port}/x.m3u8` }, '1', { ...FAST, allowRetry: false });
    assert.equal(r.code, 'CONNECTION_ERROR');
    assert.equal(r.phase, 'connect');
  });
  test('tên miền không tồn tại → DNS_ERROR, không retry', async () => {
    const r = await checkStream({ url: 'http://no-such-host.invalid/live.m3u8' }, '1', FAST);
    assert.equal(r.code, 'DNS_ERROR');
    assert.equal(r.retried, undefined);
  });
  test('link sai định dạng → INVALID_URL', async () => {
    assert.equal((await checkStream({ url: 'not a url' }, '2', FAST)).code, 'INVALID_URL');
    assert.equal((await checkStream({ url: 'http://' }, '2', FAST)).code, 'INVALID_URL');
  });
  test('phản hồi chậm hơn ngưỡng → SLOW', async () => {
    const r = await check('/slow.m3u8', '2', { slowMs: 200 });
    assert.equal(r.ok, true);
    assert.equal(r.slow, true);
  });
});

describe('HTTP headers từ iptv-org', () => {
  test('gửi Referer (và Origin) khi stream có referrer', async () => {
    const ok = await check('/needs-referer.m3u8', '2', { stream: { referrer: 'https://site.example/player' } });
    assert.equal(ok.ok, true);
    const req = srv.requests.filter((x) => x.path === '/needs-referer.m3u8').at(-1);
    assert.equal(req.headers.origin, 'https://site.example');
    const without = await check('/needs-referer.m3u8', '2');
    assert.equal(without.code, 'HTTP_403');
  });
  test('gửi đúng user_agent của stream; mặc định là UA Chrome', async () => {
    assert.equal((await check('/needs-ua.m3u8', '2', { stream: { userAgent: 'MyPlayer/1.0' } })).ok, true);
    await check('/ok.bin', '1');
    const req = srv.requests.filter((x) => x.path === '/ok.bin').at(-1);
    assert.match(req.headers['user-agent'], /Chrome\/\d+/);
  });
});

describe('hàm phụ', () => {
  test('parseM3u8 lấy variant, segment, mã hoá', () => {
    const p = parseM3u8(hlsMedia(['a.ts', 'https://cdn.example/b.ts'], { key: true }), 'http://h.example/live/index.m3u8');
    assert.deepEqual(p.segments, ['http://h.example/live/a.ts', 'https://cdn.example/b.ts']);
    assert.equal(p.encrypted, true);
  });
  test('sniffMedia nhận TS / fMP4 / ID3 / ADTS, từ chối HTML', () => {
    assert.equal(sniffMedia(tsPacket()), true);
    assert.equal(sniffMedia(Buffer.from('\0\0\0\x18ftypmp42', 'latin1')), true);
    assert.equal(sniffMedia(Buffer.from('ID3\x04\0', 'latin1')), true);
    assert.equal(sniffMedia(Buffer.from([0xff, 0xf1, 0x50, 0x80])), true);
    assert.equal(sniffMedia(Buffer.from(html)), false);
    assert.equal(detectKind(Buffer.from('﻿#EXTM3U\n')), 'hls');
  });
});
