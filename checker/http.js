// Minimal HTTP GET client on node:http/https. We use it instead of fetch()
// because we need a separate connect timeout, any header (Referer,
// User-Agent, Range), a hard cap on body size for endless live streams, and
// precise error codes for classification.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

export class CheckError extends Error {
  constructor(code, { httpCode = null, phase = null, retryable } = {}) {
    super(code);
    this.code = code;
    this.httpCode = httpCode;
    this.phase = phase; // 'connect' | 'response' | null
    this.retryable = retryable ?? RETRYABLE.has(code);
  }
}

const RETRYABLE = new Set(['TIMEOUT', 'CONNECTION_ERROR', 'HTTP_5XX', 'HTTP_429']);

export function httpErrorCode(status) {
  if (status === 403) return 'HTTP_403';
  if (status === 404) return 'HTTP_404';
  if (status === 429) return 'HTTP_429';
  if (status >= 500) return 'HTTP_5XX';
  if (status >= 400) return 'HTTP_4XX';
  return 'UNKNOWN_ERROR';
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'EAI_NODATA']);
const CONNECTION_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'ECONNABORTED', 'EADDRNOTAVAIL', 'ENETDOWN', 'EHOSTDOWN',
]);

function classify(err, connected) {
  if (err instanceof CheckError) return err;
  const code = String(err?.code || '');
  const phase = connected ? 'response' : 'connect';
  if (DNS_CODES.has(code)) return new CheckError('DNS_ERROR', { phase: 'connect' });
  if (code === 'ETIMEDOUT') return new CheckError('TIMEOUT', { phase });
  if (code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL') || code === 'EPROTO' ||
      /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/.test(code)) {
    return new CheckError('TLS_ERROR', { phase: 'connect' });
  }
  if (CONNECTION_CODES.has(code) || /socket hang up|aborted/i.test(err?.message || '')) {
    return new CheckError('CONNECTION_ERROR', { phase });
  }
  return new CheckError('UNKNOWN_ERROR', { phase });
}

// One DNS lookup per host per run: thousands of streams share few hosts, and
// libuv's small DNS thread pool would otherwise eat into the connect timeout.
const dnsCache = new Map();
function cachedLookup(hostname, options, callback) {
  const key = `${hostname}|${options.family || 0}|${options.all ? 1 : 0}`;
  let pending = dnsCache.get(key);
  if (!pending) {
    pending = dns.promises.lookup(hostname, options);
    pending.catch(() => {});
    dnsCache.set(key, pending);
  }
  pending.then(
    (res) => (options.all ? callback(null, res) : callback(null, res.address, res.family)),
    (err) => callback(err),
  );
}

function decodeBody(buf, encoding) {
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.gunzipSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    if (encoding === 'deflate') return zlib.inflateSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    if (encoding === 'br') return zlib.brotliDecompressSync(buf, { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
  } catch {
    // Truncated or bogus compression: keep the raw bytes.
  }
  return buf;
}

function requestOnce(url, headers, { connectTimeoutMs, timeoutMs, maxBytes, earlyStop }) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new CheckError('INVALID_URL'));
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new CheckError('UNSUPPORTED_PROTOCOL'));
      return;
    }
    if (timeoutMs <= 0) {
      reject(new CheckError('TIMEOUT', { phase: 'response' }));
      return;
    }

    const lib = u.protocol === 'https:' ? https : http;
    let connected = false;
    let settled = false;
    let connectTimer = null;
    let totalTimer = null;
    let req = null;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      fn(value);
    };
    const fail = (err) => {
      settle(reject, classify(err, connected));
      req?.destroy();
    };

    try {
      req = lib.request(u, { method: 'GET', headers, lookup: cachedLookup });
    } catch {
      reject(new CheckError('INVALID_URL'));
      return;
    }
    connectTimer = setTimeout(() => fail(new CheckError('TIMEOUT', { phase: 'connect' })), Math.min(connectTimeoutMs, timeoutMs));
    totalTimer = setTimeout(() => fail(new CheckError('TIMEOUT', { phase: connected ? 'response' : 'connect' })), timeoutMs);

    req.on('socket', (socket) => {
      const markConnected = () => {
        connected = true;
        clearTimeout(connectTimer);
      };
      if (!socket.connecting) markConnected(); // reused keep-alive socket
      else socket.once(u.protocol === 'https:' ? 'secureConnect' : 'connect', markConnected);
    });
    req.on('error', fail);
    req.on('response', (res) => {
      connected = true;
      clearTimeout(connectTimer);
      const status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        settle(resolve, { redirect: res.headers.location });
        return;
      }
      const chunks = [];
      let size = 0;
      let truncated = false;
      let sniffed = !earlyStop;
      const finish = () => {
        const raw = Buffer.concat(chunks).subarray(0, maxBytes);
        const body = decodeBody(raw, String(res.headers['content-encoding'] || '').toLowerCase());
        settle(resolve, { status, headers: res.headers, body, truncated, url: u.href });
      };
      res.on('data', (chunk) => {
        if (settled) return;
        chunks.push(chunk);
        size += chunk.length;
        if (!sniffed && size >= 1024) {
          sniffed = true;
          if (earlyStop(Buffer.concat(chunks))) {
            truncated = true;
            finish();
            res.destroy();
            return;
          }
        }
        if (size >= maxBytes) {
          truncated = true;
          finish();
          res.destroy();
        }
      });
      res.on('end', finish);
      res.on('error', (err) => {
        if (!settled) fail(err);
      });
      res.on('close', () => {
        // Server closed mid-body: if we already have data, judge what we got.
        if (!settled && size > 0) finish();
        else if (!settled) fail(new CheckError('CONNECTION_ERROR', { phase: 'response' }));
      });
    });
    req.end();
  });
}

/**
 * GET `url`, following up to 5 redirects. Resolves with
 * { status, headers, body (Buffer, at most maxBytes), truncated, url }.
 * Rejects with CheckError. Each hop gets its own timeout, capped by `deadline`.
 * `earlyStop(firstKb)` may end the download once the first 1 KB is enough.
 */
export async function httpGet(url, {
  headers = {},
  connectTimeoutMs = 4000,
  timeoutMs = 10000,
  maxBytes = 1 << 20,
  maxRedirects = 5,
  deadline = Infinity,
  earlyStop = null,
} = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const left = Math.min(timeoutMs, deadline - Date.now());
    const res = await requestOnce(current, headers, { connectTimeoutMs, timeoutMs: left, maxBytes, earlyStop });
    if (!res.redirect) return res;
    try {
      current = new URL(res.redirect, current).href;
    } catch {
      throw new CheckError('INVALID_URL');
    }
  }
  throw new CheckError('UNKNOWN_ERROR'); // too many redirects
}
