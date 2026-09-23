# IPTV Monitor

Tự động lấy danh sách kênh từ [iptv-org](https://github.com/iptv-org/api), kiểm tra link còn xem được không
mỗi 3 giờ, lưu kết quả vào Google Sheet và hiển thị trên dashboard tiếng Việt.

```text
Google Sheet (Config, Exclude, Streams) + Apps Script (cầu nối, "Chạy ngay")
        ▲ đọc cấu hình + trạng thái cũ │ ghi kết quả
        │                               ▼
GitHub Actions (Node.js, cron 3h) ── iptv-org API → lọc → kiểm tra stream
        │
        ▼ results.json (nhánh gh-pages)
GitHub Pages — https://tienbeta.github.io/iptv_monitor/
```

- **Cài đặt từ đầu:** [docs/setup.md](docs/setup.md)
- **Yêu cầu đã chốt:** [docs/requirements.md](docs/requirements.md)
- **Test cases & kết quả:** [docs/testing.md](docs/testing.md)

## Cấu trúc

| Đường dẫn | Nội dung |
|---|---|
| `checker/` | Node.js, không thư viện ngoài: tải API (`source.js`), kiểm tra stream mức 1–4b (`check.js`, `http.js`), trạng thái (`status.js`), cầu nối Sheet (`bridge.js`), luồng chính (`index.js`) |
| `apps-script/Code.gs` | Dán vào Google Sheet: web app `load`/`save`, ô tick “Chạy ngay”, tự chạy lại khi sửa cấu hình |
| `site/` | Dashboard tĩnh (HTML/CSS/JS thuần) |
| `.github/workflows/check.yml` | Chạy mỗi 3 giờ + chạy tay; đăng dashboard |
| `.github/workflows/test.yml` | Chạy `npm test` khi có code mới |
| `.github/workflows/smoke.yml` | Chạy tay: kiểm tra stream thật, không cần Sheet (không ghi Sheet, không đăng dashboard) |

## Mức kiểm tra

| Mức | Nghĩa |
|---|---|
| 1 | Link có phản hồi (HTTP 2xx) |
| 2 | Danh sách phát hợp lệ (HLS `#EXTINF`, DASH `<MPD`) |
| 3 | Tải được dữ liệu video (segment cuối, kiểm tra byte đầu) |
| 4a | ffprobe thấy hình hoặc tiếng |
| 4b | Giải mã được 1 khung hình |

## Chạy trên máy (tuỳ chọn)

```bash
npm test                                   # cần Node 22+, ffmpeg cho test mức 4
COUNTRIES=VN LEVEL=3 node checker/index.js # không cần Sheet → dist/results.json
```

Giới hạn đã biết: máy kiểm tra của GitHub đặt ở Mỹ, nên kênh chỉ cho xem tại Việt Nam có thể báo
“Bị chặn truy cập” dù xem ở Việt Nam vẫn được.
