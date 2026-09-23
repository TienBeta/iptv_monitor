// Checks one stream at the configured level (1, 2, 3, 4a, 4b) and returns
// { ok, code, httpCode, ms, slow, phase, retried }. Never throws.

import { spawn } from 'node:child_process';
import { CheckError, httpErrorCode, httpGet } from './http.js';
import { sleep } from './util.js';

export const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

export const DEFAULTS = {
  connectTimeoutMs: 4000,
  requestTimeoutMs: 10000,
  streamBudgetMs: 30000,
  slowMs: 5000,
  retryDelayMs: 3000,
  playlistMaxBytes: 1 << 20,
  level1MaxBytes: 64 * 1024,
  segmentBytes: 4096,
  ffprobeTimeoutMs: 20000,
  ffprobe: 'ffprobe',
  ffmpeg: 'ffmpeg',
};

export const LEVELS = ['1', '2', '3', '4a', '4b'];

export async function checkStream(stream, level, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const deadline = Date.now() + o.streamBudgetMs;
  let result = await attempt(stream, level, o, deadline);
  const canRetry = options.allowRetry !== false && result.retryable &&
    Date.now() + o.retryDelayMs + 1000 < deadline;
  if (canRetry) {
    await sleep(o.retryDelayMs);
    result = { ...(await attempt(stream, level, o, deadline)), retried: true };
  }
  delete result.retryable;
  return result;
}

async function attempt(stream, level, o, deadline) {
  const t0 = Date.now();
  try {
    let httpCode = null;
    let openMs;
    if (!/^https?:/i.test(stream.url)) {
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(stream.url)) throw new CheckError('INVALID_URL');
      // rtmp, rtsp, srt, mmsh...: ffprobe is the only way, whatever the level.
      const info = await probe(stream.url, stream, { hls: false }, o, deadline);
      openMs = Date.now() - t0;
      if (level === '4b') await decode(stream.url, stream, info, o, deadline);
    } else {
      const target = await httpCheck(stream, level, o, deadline);
      httpCode = target.status;
      // "Slow" means the server answers slowly, so it is the HTTP time only:
      // ffprobe's own analysis takes > 5 s even on healthy streams.
      openMs = Date.now() - t0;
      if (level === '4a' || level === '4b') {
        const info = await probe(target.probeUrl, stream, { hls: target.kind === 'hls' }, o, deadline);
        if (level === '4b') await decode(target.probeUrl, stream, info, o, deadline);
      }
    }
    return { ok: true, code: '', httpCode, ms: openMs, slow: openMs > o.slowMs, phase: null, retryable: false };
  } catch (err) {
    const e = err instanceof CheckError ? err : new CheckError('UNKNOWN_ERROR');
    return {
      ok: false, code: e.code, httpCode: e.httpCode, ms: Date.now() - t0, slow: false,
      phase: e.phase, retryable: e.retryable,
    };
  }
}

export function buildHeaders(stream) {
  const headers = {
    'User-Agent': stream.userAgent || CHROME_UA,
    Accept: '*/*',
    'Accept-Encoding': 'identity',
  };
  if (stream.referrer) {
    headers.Referer = stream.referrer;
    try {
      headers.Origin = new URL(stream.referrer).origin; // what a browser player also sends
    } catch {
      // referrer is not a URL: send Referer only
    }
  }
  return headers;
}

function ensureOk(res) {
  if (res.status < 200 || res.status >= 300) {
    throw new CheckError(httpErrorCode(res.status), { httpCode: res.status, phase: 'response' });
  }
}

// Levels 1–3 over HTTP; for 4a/4b this does the level-2 part and tells the
// caller which URL ffprobe should open (the lowest-bitrate variant for HLS).
async function httpCheck(stream, level, o, deadline) {
  const headers = buildHeaders(stream);
  const get = (url, maxBytes, extra = {}, earlyStop = null) => httpGet(url, {
    headers: { ...headers, ...extra },
    maxBytes,
    connectTimeoutMs: o.connectTimeoutMs,
    timeoutMs: o.requestTimeoutMs,
    deadline,
    earlyStop,
  });

  // A direct video link is an endless stream: its first KB is enough.
  const first = await get(stream.url, level === '1' ? o.level1MaxBytes : o.playlistMaxBytes, {}, sniffMedia);
  ensureOk(first);
  const status = first.status;
  if (level === '1') return { status, probeUrl: first.url, kind: 'unknown' };

  const kind = detectKind(first.body);
  if (kind === 'empty') throw new CheckError('EMPTY_RESPONSE', { httpCode: status });
  if (kind === 'dash' || kind === 'media') return { status, probeUrl: first.url, kind };
  if (kind !== 'hls') throw new CheckError('INVALID_PLAYLIST', { httpCode: status });

  let playlist = parseM3u8(first.body.toString('utf8'), first.url);
  let playlistUrl = first.url;
  if (playlist.variants.length) {
    const variant = lowestVariant(playlist.variants);
    const res = await get(variant.url, o.playlistMaxBytes);
    ensureOk(res);
    if (detectKind(res.body) !== 'hls') throw new CheckError('INVALID_PLAYLIST', { httpCode: status });
    playlist = parseM3u8(res.body.toString('utf8'), res.url);
    playlistUrl = res.url;
  }
  if (!playlist.segments.length) throw new CheckError('INVALID_PLAYLIST', { httpCode: status });

  if (level === '3') {
    const segmentUrl = playlist.segments[playlist.segments.length - 1];
    let seg;
    try {
      seg = await get(segmentUrl, o.segmentBytes, { Range: `bytes=0-${o.segmentBytes - 1}` });
    } catch (err) {
      throw new CheckError('SEGMENT_ERROR', { httpCode: status, phase: err.phase, retryable: err.retryable });
    }
    if (seg.status < 200 || seg.status >= 300 || seg.body.length === 0) {
      throw new CheckError('SEGMENT_ERROR', {
        httpCode: seg.status, phase: 'response', retryable: seg.status >= 500 || seg.status === 429,
      });
    }
    // Encrypted segments are random bytes by design: skip the signature check.
    if (!playlist.encrypted && !sniffMedia(seg.body)) {
      throw new CheckError('INVALID_MEDIA', { httpCode: seg.status });
    }
  }
  return { status, probeUrl: playlistUrl, kind: 'hls' };
}

export function detectKind(buf) {
  if (!buf || buf.length === 0) return 'empty';
  const head = buf.subarray(0, 4096).toString('utf8').replace(/^﻿/, '').trimStart();
  if (head.startsWith('#EXTM3U')) return 'hls';
  if (/<MPD[\s>]/i.test(head)) return 'dash';
  if (sniffMedia(buf)) return 'media';
  return 'other';
}

// True when the first bytes look like audio/video data.
export function sniffMedia(b) {
  if (!b || b.length < 2) return false;
  if (b[0] === 0x47 && (b.length < 189 || b[188] === 0x47)) return true; // MPEG-TS
  if (b.length >= 197 && b[4] === 0x47 && b[196] === 0x47) return true; // M2TS (192-byte packets)
  if (b.length >= 8 && ['ftyp', 'styp', 'moof', 'sidx', 'moov', 'emsg', 'free', 'mdat'].includes(b.toString('latin1', 4, 8))) return true; // (f)MP4
  const magic = b.toString('latin1', 0, 3);
  if (magic === 'ID3' || magic === 'FLV') return true; // ID3-tagged AAC/MP3, FLV
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return true; // ADTS AAC / MPEG audio
  return false;
}

export function parseM3u8(text, baseUrl) {
  const variants = [];
  const segments = [];
  let encrypted = false;
  let pendingVariant = null;
  let pendingSegment = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const bw = /[:,]BANDWIDTH=(\d+)/.exec(line);
      pendingVariant = { bandwidth: bw ? Number(bw[1]) : Infinity };
    } else if (line.startsWith('#EXTINF')) {
      pendingSegment = true;
    } else if (line.startsWith('#EXT-X-KEY')) {
      const method = /METHOD=([A-Z0-9-]+)/.exec(line);
      if (method && method[1] !== 'NONE') encrypted = true;
    } else if (!line.startsWith('#')) {
      let url;
      try {
        url = new URL(line, baseUrl).href;
      } catch {
        continue;
      }
      if (pendingVariant) {
        variants.push({ ...pendingVariant, url });
        pendingVariant = null;
      } else if (pendingSegment) {
        segments.push(url);
        pendingSegment = false;
      }
    }
  }
  return { variants, segments, encrypted };
}

function lowestVariant(variants) {
  return variants.reduce((best, v) => (v.bandwidth < best.bandwidth ? v : best), variants[0]);
}

// ---- ffprobe / ffmpeg (levels 4a, 4b and non-HTTP protocols) ----

function ffInputArgs(url, stream, { hls }) {
  const scheme = url.split(':')[0].toLowerCase();
  const args = ['-probesize', '500000', '-analyzeduration', '2000000'];
  if (scheme === 'http' || scheme === 'https') {
    args.push('-user_agent', stream.userAgent || CHROME_UA, '-rw_timeout', '10000000');
    if (stream.referrer) args.push('-referer', stream.referrer);
    if (hls) args.push('-allowed_extensions', 'ALL');
  } else if (scheme === 'rtsp') {
    args.push('-rtsp_transport', 'tcp');
  }
  return args;
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout, stderr: String(err.message), timedOut, missing: true });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, Math.max(1, timeoutMs));
    child.stdout.on('data', (d) => { if (stdout.length < 200000) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 20000) stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err.message), timedOut, missing: err.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, missing: false });
    });
  });
}

export function ffErrorCode(stderr) {
  const s = String(stderr).toLowerCase();
  const m = /(?:server returned|http error) (\d{3}|4xx|5xx)/.exec(s);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) return new CheckError(httpErrorCode(n), { httpCode: n });
    return new CheckError(m[1] === '5xx' ? 'HTTP_5XX' : 'HTTP_4XX');
  }
  if (s.includes('protocol not found')) return new CheckError('UNSUPPORTED_PROTOCOL');
  if (/failed to resolve|name or service not known|no address associated|could not resolve/.test(s)) return new CheckError('DNS_ERROR');
  if (/connection refused|connection reset|network is unreachable|broken pipe/.test(s)) return new CheckError('CONNECTION_ERROR');
  if (/timed out|timeout/.test(s)) return new CheckError('TIMEOUT');
  if (/ssl|tls|certificate/.test(s)) return new CheckError('TLS_ERROR');
  if (s.includes('invalid data found')) return new CheckError('INVALID_MEDIA');
  return new CheckError('NO_MEDIA_STREAM');
}

async function probe(url, stream, flags, o, deadline) {
  const args = [
    '-v', 'error', '-hide_banner', ...ffInputArgs(url, stream, flags),
    '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', url,
  ];
  const res = await run(o.ffprobe, args, Math.min(o.ffprobeTimeoutMs, deadline - Date.now()));
  if (res.missing) throw new CheckError('UNKNOWN_ERROR');
  if (res.timedOut) throw new CheckError('TIMEOUT');
  if (res.code !== 0) throw ffErrorCode(res.stderr);
  let streams = [];
  try {
    streams = JSON.parse(res.stdout || '{}').streams || [];
  } catch {
    throw new CheckError('NO_MEDIA_STREAM');
  }
  const hasVideo = streams.some((s) => s.codec_type === 'video');
  const hasAudio = streams.some((s) => s.codec_type === 'audio');
  if (!hasVideo && !hasAudio) throw new CheckError('NO_MEDIA_STREAM');
  return { hasVideo, hasAudio, flags };
}

// Decodes one keyframe (or one audio frame for radio-style streams).
async function decode(url, stream, info, o, deadline) {
  const args = ['-v', 'error', '-hide_banner', ...ffInputArgs(url, stream, info.flags)];
  if (info.hasVideo) args.push('-skip_frame', 'nokey');
  args.push('-i', url);
  if (info.hasVideo) args.push('-map', '0:v:0', '-frames:v', '1');
  else args.push('-map', '0:a:0', '-frames:a', '1');
  args.push('-f', 'framemd5', '-');
  const res = await run(o.ffmpeg, args, Math.min(o.ffprobeTimeoutMs, deadline - Date.now()));
  if (res.missing) throw new CheckError('UNKNOWN_ERROR');
  if (res.timedOut) throw new CheckError('TIMEOUT');
  const frames = res.stdout.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  if (res.code !== 0 || frames.length === 0) throw new CheckError('DECODE_ERROR', { retryable: false });
}
