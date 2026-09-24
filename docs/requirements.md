# IPTV Monitor — Requirements (v1, đã xác nhận)

Công cụ tự động lấy danh sách stream từ [iptv-org API](https://github.com/iptv-org/api),
kiểm tra stream còn hoạt động không, lưu kết quả vào Google Sheet và hiển thị trên
dashboard GitHub Pages. Người dùng cuối là team MKT — mọi thứ hiển thị phải tối giản,
tiếng Việt, không thuật ngữ kỹ thuật.

```text
Google Sheet (Config, Exclude, Streams) + Apps Script (cầu nối, lịch tự chạy, menu "Chạy ngay")
        ▲ đọc config + trạng thái cũ │ ghi kết quả
        │                            ▼
GitHub Actions (Node.js, chạy khi Apps Script gọi: theo lịch hoặc Chạy ngay)
        ├─ tải iptv-org API → lọc → mỗi channel+feed giữ 1 URL
        ├─ check stream theo mức kiểm tra đã chọn
        └─ đẩy results.json lên nhánh gh-pages
                                     ▼
GitHub Pages (dashboard tiếng Việt, đọc results.json)
```

## 1. Functional Requirements

| # | Yêu cầu |
|---|---|
| FR1 | Mỗi lần chạy, Actions đọc config + trạng thái cũ từ Google Sheet qua Apps Script web app (có token). |
| FR2 | Tải `streams.json`, `channels.json`, `feeds.json`, `countries.json` từ `https://iptv-org.github.io/api/`. |
| FR3 | Lọc theo config (mục 4). |
| FR4 | Dedupe URL; mỗi channel+feed giữ đúng 1 URL tốt nhất. |
| FR5 | Dựng danh sách mới từ API, chép trạng thái cũ theo key `url`; stream không còn trong API → xoá. |
| FR6 | Check từng stream theo mức kiểm tra chọn trong Sheet (mục 5). |
| FR7 | Cập nhật trạng thái, ngưỡng 2 lần fail liên tiếp → Không hoạt động; 1 lần thành công → Hoạt động. |
| FR8 | Ghi kết quả vào Sheet theo batch (sheet `Streams` cho MKT, sheet ẩn `_data` cho logic) + khối "Lần chạy gần nhất". |
| FR9 | Xuất `results.json` lên nhánh `gh-pages`; dashboard tiếng Việt đọc file này. Sheet giữ private. |
| FR10 | Tự chạy theo lịch (mặc định mỗi 3h từ 01:00 giờ VN; đổi chu kỳ 1/2/3/4/6/8/12/24h + giờ bắt đầu, hoặc tắt, trên dashboard) — trigger Apps Script mỗi 10 phút gọi GitHub API; lượt nào gặp lần chạy trước chưa xong thì bỏ qua. Chạy tay bằng menu **IPTV Monitor → Chạy ngay** hoặc nút **Chạy ngay** trên dashboard. |
| FR11 | Sửa `Config` hoặc `Exclude` → tự chạy lại sau ~1 phút (gom nhiều lần sửa thành 1 lần chạy). |
| FR12 | API iptv-org lỗi → giữ danh sách cũ, báo `SOURCE_ERROR`, vẫn check danh sách cũ. |

## 2. Non-functional Requirements

- Không cài gì trên máy; setup hoàn toàn trên trình duyệt (GitHub, Google Sheets).
- Chi phí 0đ (repo public → GitHub Actions + Pages miễn phí).
- Mỗi lần chạy có ngân sách 150 phút; quá thì dừng, lưu phần đã check, lần sau ưu tiên stream lâu chưa check nhất. Không chạy chồng nhau.
- Song song: tối đa 150 check (mức 1–3) / 60 check (mức 4a, 4b). Mỗi host tối đa 3 kết nối; host có > 100 link trong lần chạy được 9 kết nối.
- Ngắt sớm host chết: 3 lỗi kết nối liên tiếp (DNS, từ chối kết nối, hết thời gian kết nối, TLS) trên cùng host → các stream còn lại của host đó nhận cùng lỗi, không check.
- Host nhiều link được bắt đầu trước; trong mỗi host, stream lâu chưa check nhất đi trước.
- Ghi Sheet theo batch (vài request/lần chạy), không ghi từng ô.
- Bảo mật: token chỉ nằm trong GitHub Secrets và Script Properties của Apps Script; log Actions che query string của URL; không in secret ra log. URL stream hiển thị công khai trên dashboard (đã chấp nhận).
- Code Node.js LTS, không dependency ngoài, dễ đọc.
- Chấp nhận: lịch có thể trễ 5–30 phút; runner ở Mỹ (stream geo-block VN sẽ fail); vùng xám điều khoản GitHub Actions.

## 3. Input

### Sheet `Config` (MKT sửa)

| Ô | Ví dụ | Quy ước |
|---|---|---|
| Quốc gia | `VN, TH` | Mã ISO 3166-1 alpha-2, lấy từ đuôi channel ID (`AnGiangTV1.vn` → `VN`) |
| Ngôn ngữ | `vie` | Mã ISO 639-3, theo `languages` của feed |
| Thể loại | `news, sports` | ID category của iptv-org |
| Mức kiểm tra | `3` | Dropdown `1` / `2` / `3` / `4a` / `4b` — áp dụng chung cho mọi stream |

Bên dưới (script tự ghi): dòng 7 **Lịch tự chạy** (đổi trên dashboard), dòng 8 **Trạng thái** lần chạy,
dòng 9 **Thông báo**, từ dòng 10 khối **Lần chạy gần nhất**. Menu: *Chạy ngay* cho mọi người; các mục cài đặt / token / mã thao tác
nằm trong menu con *Quản trị (chủ Sheet)*.

### Sheet `Exclude` (MKT sửa)

Cột A mỗi dòng một mục, cột B ghi chú, cột C **Đang bỏ** (script ghi sau mỗi lần chạy: *"2 link: An Ninh TV"*,
*"Không khớp kênh nào"*…). Cách so khớp:

| Nhập | Bỏ những link nào |
|---|---|
| Link đầy đủ (`https://…`) | Đúng link đó (giống hệt). Kênh có link dự phòng thì link dự phòng hiện thay |
| Chữ (`An Ninh`, `VTV`, `dong thap`) | Link có **tên kênh / tên khác / mã kênh** chứa chữ đó **ở đầu một từ** — không phân biệt hoa thường, dấu, khoảng trắng (`An Ninh` = `anninh` → AnNinhTV.vn, "An Ninh TV"; `VTV` → VTV1, VTVcab… nhưng không "Lao SV TV"). Chữ kết thúc bằng số khớp trọn số (`VTV1` không bỏ VTV10). Không so với link |
| Có `.` hoặc `/`, không có khoảng trắng (`vtvprime.vn`, `AnNinhTV.vn`) | Như chữ, và thêm mọi link chứa đoạn đó |
| Dưới 3 chữ/số (`TV`) | Không dùng (tránh xoá hết) |

Lý do không so chữ thường với link: phần lớn link VN nằm trên `vtvprime.vn`, nên `VTV` sẽ bỏ gần hết danh sách.

### Field dùng từ `streams.json`

`channel`, `feed`, `title`, `url`, `referrer`, `user_agent`, `quality`, `labels` — lưu cả 8.
Khi check chỉ gửi `url`, `referrer` (header `Referer`), `user_agent` (header `User-Agent`).

## 4. Filtering (theo thứ tự)

1. Loại kênh NSFW và kênh đã đóng (`closed`).
2. Quốc gia: đuôi channel ID ∈ danh sách.
3. Ngôn ngữ: `languages` của feed giao với danh sách ≠ rỗng.
4. Thể loại: `categories` của channel giao với danh sách ≠ rỗng.
5. Ô trống = không lọc; nhiều giá trị trong 1 ô = OR; giữa các ô = AND. Stream không có metadata (`channel = null`) chỉ được giữ khi cả 3 ô đều trống.
6. Loại các link khớp `Exclude` (quy tắc ở trên; chỉ tính trong phạm vi sau bước 1–5).
7. Giữ stream có label `Geo-blocked` / `Not 24/7`, gắn nhãn hiển thị.
8. Dedupe URL.
9. Mỗi channel+feed giữ 1 URL: không label → quality cao hơn (`1080p`/`1080i` → 1080, `null` → 0) → thứ tự trong API.
10. Không giới hạn số lượng.

## 5. Stream validation

| Mức | ONLINE khi |
|---|---|
| 1 | HTTP 2xx sau redirect (chỉ đọc tối đa ~1 MB body để tránh luồng vô tận) |
| 2 | Như 1 + nội dung hợp lệ. HLS: `#EXTM3U` + `#EXTINF`; master playlist → vào variant bitrate thấp nhất. DASH: chứa `<MPD` |
| 3 | Như 2 + GET segment cuối playlist với `Range` (vài KB), byte đầu hợp lệ (TS `0x47`, fMP4, ID3, ADTS) |
| 4a | ffprobe mở được và thấy ≥ 1 track video/audio |
| 4b | Như 4a + decode được 1 khung hình chính (keyframe); stream chỉ có tiếng thì decode 1 frame âm thanh |

- Header: `Referer` khi có `referrer`; `User-Agent` = `user_agent` của stream, nếu không có thì dùng UA Chrome.
- Timeout: kết nối 4 s; 10 s/request; tối đa 30 s/stream (đã gồm retry).
- SLOW: thời gian máy chủ phản hồi HTTP (playlist, variant, segment) > 5 s. Ở mức 4a/4b **không** tính thời gian ffprobe/ffmpeg phân tích — chạy thật 84 link VN cho thấy ffprobe thường mất > 5 s kể cả với stream tốt (42/68 link bị gắn “Chậm” nếu tính vào).
- Mức 4a/4b: check HTTP như mức 2 trước; ffprobe chỉ mở variant bitrate thấp nhất, đọc ít dữ liệu (`probesize` 500 KB).
- HLS mã hoá (`#EXT-X-KEY`): mức 3 bỏ kiểm tra byte đầu.
- DASH ở mức 3 = mức 2.
- rtmp / rtsp / mmsh / srt: luôn check bằng ffprobe.

## 6. Output

### Trạng thái

| Mã (nội bộ) | Hiển thị cho MKT | Nghĩa |
|---|---|---|
| `ONLINE` | Hoạt động | Check thành công |
| `SLOW` | Chậm | Thành công nhưng > 5 s |
| `FAILING` | Đang lỗi | Fail 1 lần, đang theo dõi |
| `OFFLINE` | Không hoạt động | Fail ≥ 2 lần liên tiếp |
| `UNSUPPORTED` | Không kiểm tra được | Giao thức không mở được |
| `PENDING` | Chờ kiểm tra | Chưa check |

### Lý do (hiển thị khi không hoạt động)

| Mã lỗi | Lý do hiển thị |
|---|---|
| `HTTP_403` | Bị chặn truy cập (có thể do giới hạn quốc gia) |
| `HTTP_404` | Link không còn tồn tại |
| `HTTP_4XX` | Máy chủ từ chối yêu cầu |
| `HTTP_429` | Máy chủ đang giới hạn truy cập |
| `HTTP_5XX` | Máy chủ đang lỗi |
| `TIMEOUT` | Quá thời gian chờ |
| `DNS_ERROR` | Tên miền không tồn tại |
| `CONNECTION_ERROR` | Không kết nối được máy chủ |
| `TLS_ERROR` | Lỗi chứng chỉ bảo mật |
| `EMPTY_RESPONSE` | Máy chủ trả về rỗng |
| `INVALID_PLAYLIST` | Danh sách phát không hợp lệ |
| `SEGMENT_ERROR` | Không tải được dữ liệu video |
| `INVALID_MEDIA` | Dữ liệu không phải video |
| `NO_MEDIA_STREAM` | Không tìm thấy hình/tiếng |
| `DECODE_ERROR` | Không giải mã được video |
| `INVALID_URL` | Link không hợp lệ |
| `UNSUPPORTED_PROTOCOL` | Giao thức không hỗ trợ |
| `UNKNOWN_ERROR` | Lỗi không xác định |

### Sheet `Streams` (MKT xem, script ghi đè mỗi lần chạy)

`Tên kênh | Kênh | Quốc gia | Link | Trạng thái | Lý do | Kiểm tra lúc`

### Sheet `_data` (ẩn, cho logic)

URL, Channel, Feed, Title, Country, Quality, Labels, Referrer, User Agent, Status, Error, HTTP Code,
Response ms, Fail Streak, Last Checked, Last Online, First Seen.

### Sheet `Config` — khối "Lần chạy gần nhất"

Gọn 5 dòng (chi tiết xem dashboard): Thời điểm · Nguồn dữ liệu (Bình thường / Lỗi nguồn) · Kết quả
(*84 link: 70 hoạt động · 14 không hoạt động* — bỏ trạng thái bằng 0) · Chưa kịp kiểm tra (chỉ khi > 0) · Thời gian chạy · Dashboard.

### Dashboard (tiếng Việt)

4 thẻ tổng hợp: Tổng số link / Hoạt động / Cảnh báo (Chậm + Đang lỗi) / Không hoạt động — bấm
thẻ để lọc; thời điểm cập nhật + nút làm mới; cảnh báo nguồn; bảng Tên kênh / Quốc gia /
Trạng thái + Lý do / Kiểm tra lúc / Link (nút copy); tìm kiếm; lọc theo trạng thái (kể cả nhóm
Cảnh báo và Khác = không kiểm tra được / chờ) và quốc gia; nút Xoá bộ lọc; sắp xếp; nhãn
"Giới hạn quốc gia" / "Không phát 24/7"; giờ Việt Nam; màn hình đang tải / không có kết quả /
lỗi tải (có nút Thử lại); nền sáng, dùng được trên máy tính, tablet, điện thoại.
Thêm: lọc theo **Lý do**; thẻ *Không hoạt động* ghi số link *bị chặn truy cập* (HTTP 403, thường do máy kiểm tra ở Mỹ);
cột **Hoạt động lần cuối** (thay *Kiểm tra lúc* vì mọi link được kiểm tra cùng lúc); **So với lần chạy trước**:
*mới lỗi* (đang hoạt động → lỗi), *hoạt động lại*, *link mới*, số link bị bỏ khỏi danh sách (bấm để lọc) và ▲▼ trên thẻ
(chỉ tính các link có ở cả hai lần chạy).
Nút **Cài đặt** (cần mã thao tác): đổi **mức kiểm tra** (ghi vào ô B6 của Sheet, rồi tự chạy lại sau ~1–2 phút như khi sửa trong Sheet)
và **lịch tự chạy**; kiểm tra hợp lệ hết rồi mới lưu, chỉ lưu phần thay đổi. Phạm vi (quốc gia / ngôn ngữ / thể loại) và Exclude vẫn chỉ sửa trong Sheet.

## 7. Schedule

- Lịch nằm trong Apps Script (trigger `autoRun` mỗi 10 phút), mặc định mỗi 3 giờ: 01:00, 04:00, …, 22:00 giờ VN; lượt chạy bắt đầu trong ~10 phút sau giờ hẹn. Đổi trên dashboard (**Cài đặt**). Không dùng cron của GitHub nữa (để đổi lịch không phải sửa file workflow).
- Đánh đổi: lịch tự chạy cần GitHub token trong Sheet còn hạn — hết hạn thì không tự chạy (dashboard + ô Trạng thái báo lỗi).
- Chạy tay: menu **IPTV Monitor → Chạy ngay**, nút **Chạy ngay** trên dashboard (cần mã thao tác), hoặc nút Run workflow trên GitHub.
- Dashboard hiện trạng thái lần chạy (đang chờ / đang chạy / xong / lỗi — không có link GitHub, lỗi thì hướng dẫn "thử Chạy ngay lại; nếu vẫn lỗi, báo người quản lý") cho mọi người; chạy ngay và đổi lịch cần mã thao tác 8 ký tự (sai 10 lần → khoá 15 phút).
- Sửa `Config` / `Exclude` → tự chạy sau ~1 phút.

## 8. Error handling

| Lỗi | Retry |
|---|---|
| `TIMEOUT`, `CONNECTION_ERROR`, `HTTP_5XX`, `HTTP_429` | 1 lần sau 3 s, trong ngân sách 30 s/stream — **trừ** stream đang `OFFLINE` (không retry) |
| `HTTP_403`/`404`/`4XX`, `DNS_ERROR`, `TLS_ERROR`, lỗi nội dung/media | Không |

- API không tải được / JSON lỗi / rỗng → `SOURCE_ERROR`, giữ danh sách cũ, vẫn check.
- Số stream sau lọc < 50% lần trước **khi config không đổi** → `SOURCE_ERROR`.
- Không đọc/ghi được Sheet → workflow fail → GitHub tự gửi email; kết quả chỉ ghi 1 lần cuối, không ghi dở.

## 9. Quota

| Thành phần | Giới hạn | Mức dùng dự kiến |
|---|---|---|
| GitHub Actions (public) | Không giới hạn phút; job ≤ 6h | VN: ~3–5 phút/lần |
| Cron | Tự tắt sau 60 ngày không hoạt động | Mỗi lần chạy push `results.json` |
| Apps Script | 6 phút/execution; UrlFetch 20k/ngày | 2 lần gọi web app + tối đa vài lần dispatch mỗi lần chạy |
| Google Sheets | 10 triệu ô/file | 17.5k stream × ~24 cột ≈ 420k ô |
| GitHub Pages | Site ≤ 1 GB; ~100 GB/tháng | `results.json`: VN ~50 KB, toàn bộ ~5 MB |

## 10. Quyền truy cập

- MKT có quyền **Editor** trên Sheet (tự sửa `Config`, `Exclude`).
- Chấp nhận: Editor mở được Apps Script và xem được token trong Script Properties. GitHub token chỉ có quyền
  Actions trên repo này (tệ nhất: chạy/huỷ workflow); bridge token chỉ đọc/ghi được chính Sheet này.
- Sheet `Streams` khoá dạng cảnh báo (MKT vẫn lọc/sắp xếp được, sửa sẽ bị ghi đè); `_data` ẩn và khoá hẳn.

## 11. Ngoài phạm vi v1

Thông báo; lịch sử chi tiết / uptime %; stream riêng có credential; check từ IP Việt Nam;
tự chuyển sang URL dự phòng; hiển thị codec.
