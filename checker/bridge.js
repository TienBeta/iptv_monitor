// Talks to the Apps Script web app bound to the Google Sheet, and converts
// between stream objects and the 2-D tables the Sheet stores.

import { createHash } from 'node:crypto';
import { categoryName } from './source.js';
import { STATUS_LABELS, reasonFor } from './status.js';

// Same fingerprint as tokenCode_() in Code.gs: first 3 bytes of SHA-256, upper-case hex.
export const tokenCode = (token) => createHash('sha256').update(String(token)).digest('hex').slice(0, 6).toUpperCase();

export const DATA_COLUMNS = [
  'url', 'channel', 'feed', 'title', 'country', 'countryName', 'flag', 'quality', 'labels',
  'referrer', 'userAgent', 'status', 'error', 'httpCode', 'responseMs', 'failStreak',
  'lastChecked', 'lastOnline', 'firstSeen', 'categories',
  // details for the Sheet "Streams" (details.js), kept so a source failure still has them
  'logo', 'region', 'subdivision', 'city', 'languageNames', 'format', 'network', 'owners', 'website', 'launched', 'closed', 'guide',
];
const LIST_COLUMNS = new Set(['labels', 'categories']); // stored as "a, b"
const NUMBER_COLUMNS = new Set(['httpCode', 'responseMs', 'failStreak', 'lastChecked', 'lastOnline', 'firstSeen']);

// Sheet "Streams" for MKT: name, logo, link, the check result, then the channel details.
// Keep in step with STREAMS_HEADER in Code.gs (used when the Sheet is set up).
export const STREAMS_COLUMNS = [
  ['Tên kênh', (r) => r.title],
  ['Mã kênh', (r) => r.channel],
  ['Logo', (r) => r.logo], // shown as the image
  ['Link', (r) => r.url],
  ['Trạng thái', (r) => STATUS_LABELS[r.status] || r.status],
  ['Lý do', (r) => reasonFor(r.status, r.error)],
  ['Kiểm tra lúc', (r) => r.lastChecked || ''],
  ['Thể loại', (r, o) => (r.categories || []).map((id) => categoryName(id, o.categoryNames)).join(', ')],
  ['Quốc gia', (r) => [r.flag, r.countryName].filter(Boolean).join(' ')],
  ['Khu vực', (r) => r.region],
  ['Tỉnh/bang', (r) => r.subdivision],
  ['Thành phố', (r) => r.city],
  ['Ngôn ngữ', (r) => r.languageNames],
  ['Độ phân giải', (r) => r.quality],
  ['Định dạng video', (r) => r.format],
  ['Network', (r) => r.network],
  ['Chủ sở hữu', (r) => r.owners],
  ['Website', (r) => r.website],
  ['Ngày ra mắt', (r) => r.launched],
  ['Ngày đóng', (r) => r.closed],
  ['Lịch phát sóng', (r) => r.guide],
  ['Link logo', (r) => r.logo],
];
export const STREAMS_HEADER = STREAMS_COLUMNS.map(([h]) => h);
const at = (name) => STREAMS_HEADER.indexOf(name);
export const STREAMS_DATE_COLUMN = at('Kiểm tra lúc'); // epoch ms, written as a date cell
// Date cells and their format (Code.gs); launch / close dates are "YYYY-MM-DD".
export const STREAMS_DATE_COLUMNS = {
  [STREAMS_DATE_COLUMN]: 'dd/MM/yyyy HH:mm', [at('Ngày ra mắt')]: 'dd/MM/yyyy', [at('Ngày đóng')]: 'dd/MM/yyyy',
};
export const STREAMS_IMAGE_COLUMN = at('Logo');

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

/** `categoryNames`: category ID → Vietnamese name (as in results.json). */
export function toStreamsTable(rows, { categoryNames = {} } = {}) {
  const sorted = [...rows].sort((a, b) =>
    collator.compare(a.countryName || '~', b.countryName || '~') || collator.compare(a.title, b.title));
  const opts = { categoryNames: new Map(Object.entries(categoryNames)) };
  return {
    header: STREAMS_HEADER,
    dateColumn: STREAMS_DATE_COLUMN, // read by Code.gs versions before dateColumns
    dateColumns: STREAMS_DATE_COLUMNS,
    imageColumn: STREAMS_IMAGE_COLUMN,
    rows: sorted.map((r) => STREAMS_COLUMNS.map(([, value]) => value(r, opts) ?? '')),
  };
}
