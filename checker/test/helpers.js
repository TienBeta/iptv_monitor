// Test helpers: a local HTTP server with scripted routes, and tiny media
// fixtures generated with ffmpeg (when it is installed).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

// routes: { '/path': (req, res, ctx) => void } — ctx.hits counts requests per path.
export async function startServer(routes) {
  const hits = {};
  const requests = [];
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    hits[pathname] = (hits[pathname] || 0) + 1;
    requests.push({ path: pathname, url: req.url, headers: req.headers, method: req.method });
    const route = routes[pathname] || routes['*'];
    if (!route) {
      res.writeHead(404).end('not found');
      return;
    }
    route(req, res, { hits: hits[pathname] });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    hits,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

export const send = (status, body, headers = {}) => (req, res) => {
  res.writeHead(status, { 'Content-Type': 'application/octet-stream', ...headers });
  res.end(body);
};

export const hlsMedia = (segments, { key = false } = {}) => [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:2',
  '#EXT-X-MEDIA-SEQUENCE:1',
  ...(key ? ['#EXT-X-KEY:METHOD=AES-128,URI="key.bin"'] : []),
  ...segments.flatMap((s) => ['#EXTINF:2.0,', s]),
].join('\n');

export const tsPacket = () => {
  const b = Buffer.alloc(188 * 4, 0xff);
  for (let i = 0; i < 4; i++) b[i * 188] = 0x47;
  return b;
};

export function hasFfmpeg() {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let fixtures = null;
// Two-second test clips: video+audio and audio-only, as MPEG-TS.
export function mediaFixtures() {
  if (fixtures) return fixtures;
  const dir = mkdtempSync(path.join(tmpdir(), 'iptv-fixtures-'));
  const av = path.join(dir, 'av.ts');
  const audio = path.join(dir, 'audio.ts');
  const quiet = { stdio: 'ignore' };
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '2', '-c:v', 'libx264', '-g', '10', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mpegts', av], quiet);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:a', 'aac', '-f', 'mpegts', audio], quiet);
  fixtures = { av: readFileSync(av), audio: readFileSync(audio) };
  return fixtures;
}
