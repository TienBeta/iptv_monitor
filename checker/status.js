// Status transitions (fail twice in a row → OFFLINE) and the Vietnamese
// wording shown to the MKT team.

export const OFFLINE_AFTER = 2;

export const STATUS_LABELS = {
  ONLINE: 'Hoạt động',
  SLOW: 'Chậm',
  FAILING: 'Đang lỗi',
  OFFLINE: 'Không hoạt động',
  UNSUPPORTED: 'Không kiểm tra được',
  PENDING: 'Chờ kiểm tra',
};

export const STATUS_ORDER = ['ONLINE', 'SLOW', 'FAILING', 'OFFLINE', 'UNSUPPORTED', 'PENDING'];

export const REASON_LABELS = {
  HTTP_403: 'Bị chặn truy cập (có thể do giới hạn quốc gia)',
  HTTP_404: 'Link không còn tồn tại',
  HTTP_4XX: 'Máy chủ từ chối yêu cầu',
  HTTP_429: 'Máy chủ đang giới hạn truy cập',
  HTTP_5XX: 'Máy chủ đang lỗi',
  TIMEOUT: 'Quá thời gian chờ',
  DNS_ERROR: 'Tên miền không tồn tại',
  CONNECTION_ERROR: 'Không kết nối được máy chủ',
  TLS_ERROR: 'Lỗi chứng chỉ bảo mật',
  EMPTY_RESPONSE: 'Máy chủ trả về rỗng',
  INVALID_PLAYLIST: 'Danh sách phát không hợp lệ',
  SEGMENT_ERROR: 'Không tải được dữ liệu video',
  INVALID_MEDIA: 'Dữ liệu không phải video',
  NO_MEDIA_STREAM: 'Không tìm thấy hình/tiếng',
  DECODE_ERROR: 'Không giải mã được video',
  INVALID_URL: 'Link không hợp lệ',
  UNSUPPORTED_PROTOCOL: 'Giao thức không hỗ trợ',
  UNKNOWN_ERROR: 'Lỗi không xác định',
};

export const LEVEL_LABELS = {
  1: '1 - Link có phản hồi',
  2: '2 - Danh sách phát hợp lệ',
  3: '3 - Tải được dữ liệu video',
  '4a': '4a - Có hình hoặc tiếng',
  '4b': '4b - Giải mã được hình',
};

export const LABEL_NAMES = {
  'Geo-blocked': 'Giới hạn quốc gia',
  'Not 24/7': 'Không phát 24/7',
};

export function reasonFor(status, error) {
  if (status === 'SLOW') return 'Phản hồi chậm (trên 5 giây)';
  if (status === 'ONLINE' || status === 'PENDING') return '';
  return REASON_LABELS[error] || REASON_LABELS.UNKNOWN_ERROR;
}

/**
 * New state of a stream after this run. `result` is undefined when the stream
 * was not checked (time budget ran out): the previous state is kept.
 */
export function nextState(prev, result) {
  const firstSeen = prev?.firstSeen || result?.at || Date.now();
  const lastOnline = prev?.lastOnline || 0;
  const failStreak = prev?.failStreak || 0;

  if (!result) {
    if (!prev) {
      return { status: 'PENDING', error: '', httpCode: '', responseMs: '', failStreak: 0, lastChecked: 0, lastOnline: 0, firstSeen };
    }
    return {
      status: prev.status || 'PENDING', error: prev.error || '', httpCode: prev.httpCode ?? '',
      responseMs: prev.responseMs ?? '', failStreak, lastChecked: prev.lastChecked || 0, lastOnline, firstSeen,
    };
  }

  const common = { httpCode: result.httpCode ?? '', responseMs: result.ms ?? '', lastChecked: result.at, firstSeen };
  if (result.ok) {
    return { ...common, status: result.slow ? 'SLOW' : 'ONLINE', error: '', failStreak: 0, lastOnline: result.at };
  }
  if (result.code === 'UNSUPPORTED_PROTOCOL') {
    return { ...common, status: 'UNSUPPORTED', error: result.code, failStreak: 0, lastOnline };
  }
  const streak = failStreak + 1;
  return { ...common, status: streak >= OFFLINE_AFTER ? 'OFFLINE' : 'FAILING', error: result.code, failStreak: streak, lastOnline };
}

export function countByStatus(rows) {
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  return counts;
}
