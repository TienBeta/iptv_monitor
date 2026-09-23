# Hướng dẫn cài đặt từ đầu (Phase 6)

Tất cả làm trên trình duyệt, **không cần cài Node.js / Python / Docker** trên máy. Tổng thời gian khoảng 20–30 phút.

Bạn sẽ có:

- **Google Sheet** — nơi MKT chọn quốc gia / mức kiểm tra và xem kết quả.
- **GitHub Actions** — tự kiểm tra stream mỗi 3 giờ.
- **Dashboard** — `https://tienbeta.github.io/iptv_monitor/`.

Thứ tự: A (Sheet) → B (GitHub) → C (chạy lần đầu) → D (chia sẻ cho MKT).

---

## A. Google Sheet + Apps Script

**A1. Tạo Sheet.** Mở <https://sheets.new>, đặt tên file là `IPTV Monitor`.

**A2. Mở Apps Script.** Menu **Tiện ích mở rộng (Extensions) → Apps Script**. Một tab mới mở ra.

**A3. Dán code.**
1. Trong tab Apps Script, xoá hết nội dung file `Code.gs` có sẵn.
2. Mở file [`apps-script/Code.gs`](../apps-script/Code.gs) trong repo → nút **Copy raw file** → dán vào.
3. Bấm biểu tượng đĩa mềm (**Save**). Đặt tên project là `IPTV Monitor` nếu được hỏi.

**A4. Cài đặt ban đầu.**
1. Quay lại tab Google Sheet → **tải lại trang** (F5). Sau vài giây menu **IPTV Monitor** xuất hiện trên thanh menu.
2. Chọn **IPTV Monitor → Cài đặt ban đầu**.
3. Google hỏi quyền: **Tiếp tục** → chọn tài khoản của bạn → màn hình *“Google chưa xác minh ứng dụng này”* → **Nâng cao** → **Đi tới IPTV Monitor (không an toàn)** → **Cho phép**.
   (Đây là script của chính bạn trong Sheet của bạn, nên cảnh báo này là bình thường.)
4. Nếu lần đầu Google chỉ xin quyền mà không chạy, chọn lại **IPTV Monitor → Cài đặt ban đầu**.
5. Hộp thoại hiện **Bridge token** (chuỗi 64 ký tự). **Copy lại** — dùng ở bước B3.
   (Xem lại bất cứ lúc nào: **IPTV Monitor → Xem bridge token**.)

Sheet giờ có: `Config`, `Exclude`, `Streams` và `_data` (ẩn).

**A5. Deploy web app** (để GitHub Actions đọc/ghi được Sheet).
1. Ở tab Apps Script: nút **Deploy (Triển khai) → New deployment (Tuỳ chọn triển khai mới)**.
2. Bấm bánh răng cạnh *Select type* → chọn **Web app**.
3. Điền:
   - Description: `bridge`
   - Execute as: **Me (email của bạn)**
   - Who has access: **Anyone (Bất kỳ ai)** ← bắt buộc, GitHub không đăng nhập Google được. Mọi request vẫn phải có đúng bridge token.
4. **Deploy** → cho phép quyền nếu được hỏi → copy **Web app URL** (dạng `https://script.google.com/macros/s/…/exec`). Dùng ở bước B3.

> Kiểm tra nhanh: dán Web app URL vào trình duyệt → phải thấy `{"ok":true,"service":"iptv-monitor"}`.

---

## B. GitHub

**B1. Đưa code lên nhánh `main`.** Cron và nút “Chạy ngay” chỉ chạy với workflow nằm trên nhánh mặc định.

- Repo hiện chỉ có nhánh `claude/elegant-pascal-gmsour` (đang là nhánh mặc định). Cách đơn giản nhất:
  1. Vào <https://github.com/TienBeta/iptv_monitor/branches> → **New branch** → tên `main`, nguồn `claude/elegant-pascal-gmsour` → **Create**.
  2. **Settings → General → Default branch** → bấm biểu tượng ⇄ → chọn `main` → **Update**.
- Sau này có code mới: tạo Pull Request vào `main` rồi merge.

**B2. Quyền cho workflow.** **Settings → Actions → General → Workflow permissions** → chọn **Read and write permissions** → **Save**.
(Workflow cần quyền ghi để đăng dashboard lên nhánh `gh-pages`.)

**B3. Thêm 2 secret.** **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Secret |
|---|---|
| `SHEET_BRIDGE_URL` | Web app URL ở bước A5 |
| `SHEET_BRIDGE_TOKEN` | Bridge token ở bước A4 |

**B4. Tạo GitHub token cho “Chạy ngay”** (để Sheet gọi được GitHub).
1. Ảnh đại diện góc phải → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Điền:
   - Token name: `IPTV Sheet`
   - Expiration: **1 năm** (hoặc tuỳ chọn; hết hạn thì tạo lại)
   - Repository access: **Only select repositories** → `TienBeta/iptv_monitor`
   - Permissions → Repository permissions → **Actions: Read and write** (không cần quyền nào khác)
3. **Generate token** → copy.
4. Quay lại Google Sheet → **IPTV Monitor → Nhập GitHub token** → dán → **OK**.

---

## C. Chạy lần đầu

**C1. Chọn phạm vi.** Sheet `Config`:

| Ô | Ví dụ | Ghi chú |
|---|---|---|
| B3 Quốc gia | `VN` | Nhiều nước: `VN, TH`. Để trống = tất cả (~13.000 link) |
| B4 Ngôn ngữ | để trống | VD `vie` |
| B5 Thể loại | để trống | VD `news, sports` |
| B6 Mức kiểm tra | `3 - Tải được dữ liệu video` | Chọn trong danh sách |

**C2. Chạy.** Tick ô **B7 “Chạy ngay”**. Ô C7 báo *“Đã gửi yêu cầu chạy lúc …”*.
(Hoặc trên GitHub: tab **Actions → IPTV check → Run workflow → main → Run workflow**.)

**C3. Theo dõi.** Tab **Actions** trên GitHub → lần chạy mới nhất (khoảng 3–5 phút với phạm vi VN).
Xong: bấm vào lần chạy → phần **Summary** có bảng số link theo trạng thái.

**C4. Bật dashboard** (chỉ làm một lần, sau khi lần chạy đầu xong vì nó tạo nhánh `gh-pages`):
**Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `gh-pages` / `(root)` → Save**.
Khoảng 1–2 phút sau mở <https://tienbeta.github.io/iptv_monitor/>.

**C5. Kiểm tra.**
- Sheet `Streams` có danh sách kênh, cột **Trạng thái** tô màu.
- Sheet `Config`, khối **LẦN CHẠY GẦN NHẤT** có thời điểm, số link, thời gian chạy.
- Dashboard hiện cùng số liệu.
- Sau vài giờ, tab **Actions** có các lần chạy *Scheduled* quanh 01:17, 04:17, 07:17, 10:17, 13:17, 16:17, 19:17, 22:17 giờ Việt Nam. GitHub có thể chạy trễ 5–30 phút — bình thường.

---

## D. Chia sẻ cho MKT

1. Google Sheet → **Chia sẻ** → thêm email MKT → quyền **Người chỉnh sửa (Editor)**.
2. Gửi link dashboard: <https://tienbeta.github.io/iptv_monitor/>.
3. Hướng dẫn MKT (3 dòng):
   - Chỉ sửa **ô vàng B3–B6** trong `Config` và sheet `Exclude`. Sửa xong hệ thống **tự chạy lại sau 1–2 phút**.
   - Muốn chạy ngay: **tick ô B7**. Không cần dùng menu.
   - Sheet `Streams` tự cập nhật mỗi 3 giờ; lọc/sắp xếp thoải mái, nhưng sửa tay sẽ bị ghi đè.

> **Lưu ý bảo mật:** người có quyền Editor mở được Apps Script và xem được 2 token.
> GitHub token chỉ có quyền chạy/huỷ workflow của repo này; bridge token chỉ đọc/ghi được chính Sheet này.
> Nếu một người rời team: tạo GitHub token mới (B4) và đổi bridge token (xoá `BRIDGE_TOKEN` trong
> *Apps Script → Project Settings → Script Properties*, chạy lại **Cài đặt ban đầu**, cập nhật secret B3).

---

## E. Vận hành

| Việc | Cách làm |
|---|---|
| Xem lịch sử chạy / lỗi | GitHub → tab **Actions**. Lỗi phía Sheet: Apps Script → **Executions** |
| Cập nhật code Apps Script | Dán code mới → Save → **Deploy → Manage deployments** → bút chì → Version: **New version** → Deploy (URL giữ nguyên) |
| Tạm dừng | Actions → IPTV check → `···` → **Disable workflow** |
| Thấy banner “scheduled workflow is disabled” | Bấm **Enable workflow** (GitHub tắt nếu repo 60 ngày không có hoạt động; mỗi lần chạy đều push dashboard nên hiếm gặp) |
| GitHub token hết hạn | Làm lại B4. Cron vẫn chạy bình thường, chỉ “Chạy ngay” bị ảnh hưởng |
| Chạy thử trên máy (tuỳ chọn, cần Node 22+) | `COUNTRIES=VN LEVEL=3 node checker/index.js` → `dist/results.json`; `npm test` để chạy test |

## F. Xử lý sự cố

| Triệu chứng | Nguyên nhân | Cách sửa |
|---|---|---|
| Run có cảnh báo “Chưa có secret … bỏ qua lần chạy này” | Chưa làm B3 | Thêm 2 secret |
| “Apps Script trả về không phải JSON … Who has access: Anyone” | Web app deploy sai quyền truy cập | Làm lại A5 với **Anyone** |
| “Apps Script báo lỗi (load): unauthorized” | Bridge token trong secret không khớp | **IPTV Monitor → Xem bridge token** → cập nhật secret `SHEET_BRIDGE_TOKEN` |
| “chưa có sheet Config” | Chưa chạy **Cài đặt ban đầu** | Làm A4 |
| C7 báo “không tìm thấy workflow check.yml trên nhánh main” | Code chưa ở `main` | Làm B1 |
| C7 báo “GitHub token sai hoặc đã hết hạn” / “thiếu quyền” | Token hết hạn hoặc thiếu quyền Actions | Làm lại B4 |
| Bước “Đăng dashboard” lỗi 403 | Workflow chưa có quyền ghi | Làm B2 |
| Dashboard 404 | Chưa bật Pages hoặc chưa có lần chạy nào | Làm C2 rồi C4 |
| Nhiều kênh VN “Bị chặn truy cập (có thể do giới hạn quốc gia)” | Máy kiểm tra của GitHub đặt ở Mỹ | Giới hạn đã biết; mở thử bằng VLC ở Việt Nam |
