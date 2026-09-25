// Talks to the Apps Script web app bound to the Google Sheet, and converts
// between stream objects and the 2-D tables the Sheet stores.

import { createHash } from 'node:crypto';
import { STATUS_LABELS, reasonFor } from './status.js';

// Same fingerprint as tokenCode_() in Code.gs: first 3 bytes of SHA-256, upper-case hex.
export const tokenCode = (token) => createHash('sha256').update(String(token)).digest('hex').slice(0, 6).toUpperCase();

export const DATA_COLUMNS = [
  'url', 'channel', 'feed', 'title', 'country', 'countryName', 'flag', 'quality', 'labels',
  'referrer', 'userAgent', 'status', 'error', 'httpCode', 'responseMs', 'failStreak',
  'lastChecked', 'lastOnline', 'firstSeen', 'categories',
];
const LIST_COLUMNS = new Set(['labels', 'categories']); // stored as "a, b"
const NUMBER_COLUMNS = new Set(['httpCode', 'responseMs', 'failStreak', 'lastChecked', 'lastOnline', 'firstSeen']);

export const STREAMS_HEADER = ['Tên kênh', 'Kênh', 'Quốc gia', 'Link', 'Trạng thái', 'Lý do', 'Kiểm tra lúc'];
export const STREAMS_DATE_COLUMN = 6; // "Kiểm tra lúc": epoch ms, written as a date cell

export async function callBridge(url, token, action, payload = {}, timeoutMs = 5 * 60_000) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token, action, ...payload }),
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`Không gọi được Apps Script (${action}): ${err.message}`);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const hint = res.status === 401 || res.status === 403
      ? ' — web app đang đòi đăng nhập Google: Deploy → Manage deployments → "Who has access" phải là "Anyone",'
        + ' và secret SHEET_BRIDGE_URL phải là URL kết thúc bằng /exec (xem docs/setup.md mục F)'
      : /<html/i.test(text) ? ' — kiểm tra web app đã deploy với "Who has access: Anyone" chưa' : '';
    throw new Error(`Apps Script trả về không phải JSON (HTTP ${res.status})${hint}`);
  }
  if (String(data.error || '').startsWith('unauthorized')) {
    const detail = String(data.error).replace(/^unauthorized:?\s*/, '') || 'token không khớp';
    throw new Error(`Apps Script từ chối (${action}): ${detail}. GitHub đang gửi token mã ${tokenCode(token)} `
      + `dài ${token.length} ký tự. Đối chiếu với "Mã kiểm tra" ở menu IPTV Monitor → Quản trị → Xem bridge token trong Sheet `
      + '(xem docs/setup.md mục F)');
  }
  if (!data.ok) throw new Error(`Apps Script báo lỗi (${action}): ${data.error || 'không rõ'}`);
  return data;
}

export function toDataTable(rows) {
  return {
    header: DATA_COLUMNS,
    rows: rows.map((r) => DATA_COLUMNS.map((c) => {
      const v = r[c];
      if (LIST_COLUMNS.has(c)) return (v || []).join(', ');
      return v ?? '';
    })),
  };
}

export function fromDataTable(table) {
  if (!table?.header?.length) return [];
  const index = new Map(table.header.map((h, i) => [String(h), i]));
  return (table.rows || []).map((row) => {
    const obj = {};
    for (const c of DATA_COLUMNS) {
      const v = index.has(c) ? row[index.get(c)] : '';
      if (LIST_COLUMNS.has(c)) obj[c] = String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      else if (NUMBER_COLUMNS.has(c)) obj[c] = v === '' || v === null || v === undefined ? '' : Number(v) || 0;
      else obj[c] = String(v ?? '');
    }
    return obj;
  }).filter((r) => r.url);
}

const collator = new Intl.Collator('vi');

export function toStreamsTable(rows) {
  const sorted = [...rows].sort((a, b) =>
    collator.compare(a.countryName || '~', b.countryName || '~') || collator.compare(a.title, b.title));
  return {
    header: STREAMS_HEADER,
    dateColumn: STREAMS_DATE_COLUMN,
    rows: sorted.map((r) => [
      r.title,
      r.channel,
      [r.flag, r.countryName].filter(Boolean).join(' '),
      r.url,
      STATUS_LABELS[r.status] || r.status,
      reasonFor(r.status, r.error),
      r.lastChecked || '',
    ]),
  };
}
