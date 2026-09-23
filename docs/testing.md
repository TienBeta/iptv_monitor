# Test cases & kết quả (Phase 5)

Chạy toàn bộ: `npm test` (Node 22+, cần `ffmpeg` cho nhóm mức 4a/4b — CI tự cài).
Workflow [`Tests`](../.github/workflows/test.yml) chạy lại mỗi khi có code mới.

**Kết quả gần nhất:** 86/86 pass (23/09/2026, Node 22, ffmpeg 6.1.1 — cùng bản với runner Ubuntu 24.04 của GitHub).

## Cách test

| Lớp | Cách làm | File |
|---|---|---|
| Kiểm tra stream | Server HTTP cục bộ giả lập đủ loại phản hồi: 200/403/404/429/5xx, treo, playlist hỏng, luồng phát vô tận… | `checker/test/check.test.js` |
| Mức 4a/4b | Video thật do ffmpeg tạo (H.264 + AAC, và chỉ-âm-thanh) | `checker/test/media.test.js` |
| Lọc nguồn | Dữ liệu mẫu theo đúng cấu trúc iptv-org | `checker/test/source.test.js` |
| Trạng thái, song song, ngắt host | Unit test | `checker/test/status.test.js` |
| Apps Script | Chạy **chính file `apps-script/Code.gs`** trên Google Sheet giả lập trong bộ nhớ | `checker/test/apps-script.test.js` |
| Toàn bộ luồng | API iptv-org giả → checker → web app (trả 302 như Apps Script thật) → Sheet giả → `results.json` | `checker/test/monitor.test.js` |
| Quy mô | 1.000 link trên 21 host, timeout thu nhỏ 10 lần | `checker/test/scale.test.js` |
| Dashboard | Chụp màn hình bằng Chromium: máy tính, điện thoại (390 px), nền tối; không tràn ngang, không lỗi JS | thủ công (xem Phase 4) |

## 15 test case đã yêu cầu

| # | Test case | Kết quả mong đợi | Thực tế |
|---|---|---|---|
| 1 | API fetch thành công | Lọc đúng phạm vi, bỏ URL trùng, ghi `Streams` + `_data` + khối tóm tắt, `results.json` | ✅ `monitor` · lần 1 |
| 2 | API fetch lỗi (502) | `SOURCE_ERROR`, giữ danh sách cũ, **vẫn check**, Config ghi “Lỗi nguồn, đang dùng danh sách cũ” | ✅ `monitor` · API lỗi |
| 3 | API trả rỗng | `SOURCE_ERROR`, không xoá dữ liệu; thêm: số link tụt < 50% khi cấu hình không đổi cũng là `SOURCE_ERROR`, còn đổi cấu hình thì không | ✅ `monitor` · 3 test |
| 4 | Stream trùng | Bỏ URL trùng; mỗi channel+feed giữ 1 URL (không label → quality cao → thứ tự API) | ✅ `source` · 3 test |
| 5 | URL không hợp lệ | `INVALID_URL` → “Link không hợp lệ” | ✅ `check` |
| 6 | HTTP 200 | Mức 1: `ONLINE`; trang HTML trả 200 vẫn ONLINE ở mức 1 nhưng là `INVALID_PLAYLIST` ở mức 2 | ✅ `check` |
| 7 | HTTP 404 | `HTTP_404`, **không retry** (đếm đúng 1 request) | ✅ `check` |
| 8 | HTTP 403 | `HTTP_403` → “Bị chặn truy cập (có thể do giới hạn quốc gia)” | ✅ `check`, `monitor` |
| 9 | Timeout | Server treo → `TIMEOUT` sau đúng thời gian chờ, retry 1 lần; stream đang OFFLINE thì không retry; 503 rồi 200 → retry thành công | ✅ `check` · 3 test |
| 10 | HLS hợp lệ | Mức 2 và 3 `ONLINE`; master → chỉ tải variant bitrate thấp nhất; segment cuối, có header `Range` | ✅ `check`, `media` |
| 11 | HLS không hợp lệ | Rỗng → `EMPTY_RESPONSE`; không có segment → `INVALID_PLAYLIST`; segment là HTML → `INVALID_MEDIA`; segment 404 → `SEGMENT_ERROR` | ✅ `check` · 4 test |
| 12 | Stream có `referrer` | Gửi `Referer` (+ `Origin`), cả khi check HTTP lẫn ffprobe; thiếu → 403 | ✅ `check`, `media` |
| 13 | Stream có `user_agent` | Gửi đúng UA của stream; mặc định UA Chrome; ffprobe cũng gửi | ✅ `check`, `media` |
| 14 | 1.000 stream | Đủ 1.000 kết quả, host chết bị ngắt sớm, xong trong **10 giây** với timeout ×0,1 (≈ 1–2 phút với timeout thật); ghi 1.000 dòng vào Sheet 1 lần; ghi 12.000 dòng cũng được | ✅ `scale`, `apps-script` |
| 15 | Trigger định kỳ | Cron `17 */3 * * *` (UTC); mỗi lúc 1 lần chạy; thiếu secret thì bỏ qua êm | ⏳ chỉ kiểm chứng được sau khi deploy — xem mục dưới |

## Test bổ sung

- Mức 4a/4b với video thật: có hình+tiếng, chỉ có tiếng, segment không có đuôi chuẩn, dữ liệu rác, link TS trực tiếp, rtmp không kết nối được, giao thức lạ.
- Luồng phát vô tận không làm treo (chỉ đọc phần đầu).
- Ngưỡng trạng thái: 1 lỗi → Đang lỗi, 2 lỗi liên tiếp → Không hoạt động, 1 lần OK → Hoạt động; chậm > 5 s → Chậm.
- Ngắt sớm host chết sau 3 lỗi kết nối; lỗi HTTP không làm ngắt host.
- Hết ngân sách thời gian: dừng nhận việc mới, phần chưa check giữ trạng thái cũ.
- Apps Script: token sai → `unauthorized`; tick “Chạy ngay” gọi đúng GitHub API rồi bỏ tick; sửa cấu hình nhiều lần chỉ hẹn 1 lần chạy; sửa cột hướng dẫn không chạy lại; giữ tiêu chí lọc của MKT sau mỗi lần ghi; chữ bắt đầu bằng `=` được lưu dạng chữ, không thành công thức.
- Log không bao giờ in query string (token) của URL.

## Chạy thật trên GitHub Actions (stream thật, chưa dùng Sheet)

Workflow [`Smoke test`](../.github/workflows/smoke.yml), phạm vi `VN` (84 link sau khi lọc 1 link / channel+feed), 23/09/2026:

| Mức | Thời gian | Hoạt động | Chậm | Đang lỗi | Lỗi chính |
|---|---|---|---|---|---|
| 3 | 23 giây | 67 | 3 | 14 | `HTTP_403` ×9 (vtvprime.vn, fptplay — chặn IP ngoài VN), `TIMEOUT` ×2, `HTTP_404` ×2, `SEGMENT_ERROR` ×1 |
| 4b | 1 phút | 26 | 42 | 16 | như trên + `TIMEOUT` ×2 (ffprobe), `INVALID_MEDIA` ×1 |

- ffprobe/ffmpeg chạy được với stream thật: 68/84 link giải mã được hình, gần bằng mức 3 (70/84).
- Phát hiện: ở mức 4b có 42 link bị gắn “Chậm” vì thời gian ffprobe phân tích bị tính vào. Đã sửa:
  “Chậm” chỉ đo thời gian máy chủ phản hồi HTTP (xem requirements mục 5).
- Log chỉ in URL đã che query (`…/01.m3u8?…`).
- Lần đầu mọi link lỗi đều là “Đang lỗi” (chưa đủ 2 lần liên tiếp để thành “Không hoạt động”) — đúng thiết kế.

## Chưa test được trong môi trường phát triển — kiểm tra sau khi deploy

Google Apps Script thật và lịch chạy của GitHub chỉ kiểm chứng được sau khi cài đặt, nên 4 điểm dưới đây
kiểm tra ngay sau khi làm xong [docs/setup.md](setup.md):

| Kiểm tra | Cách làm | Mong đợi |
|---|---|---|
| Stream thật qua Sheet | Bước C2 với `VN`, mức 3 | Run xanh trong ~2–3 phút; khoảng 80% “Hoạt động”; khoảng 10% “Bị chặn truy cập” vì runner ở Mỹ (khớp smoke test) |
| Apps Script thật | Mở Sheet sau lần chạy | `Streams` có dữ liệu, cột Trạng thái tô màu, “Kiểm tra lúc” đúng giờ VN |
| Chạy ngay / tự chạy | Tick B7; sửa B3 | C7 báo đã gửi; tab Actions có run mới (*workflow_dispatch*) sau vài phút |
| Cron 3 giờ | Xem tab Actions sau ~6 giờ | Có run *schedule* quanh :17 các giờ 01, 04, 07, 10, 13, 16, 19, 22 (giờ VN), có thể trễ 5–30 phút |
