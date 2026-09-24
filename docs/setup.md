# Hướng dẫn cài đặt từ đầu (Phase 6)

Tất cả làm trên trình duyệt, **không cần cài Node.js / Python / Docker** trên máy. Tổng thời gian khoảng 20–30 phút.

Bạn sẽ có:

- **Google Sheet** — nơi MKT chọn quốc gia / mức kiểm tra và xem kết quả.
- **GitHub Actions** — kiểm tra stream theo lịch (mặc định mỗi 3 giờ; đổi được trên dashboard).
- **Dashboard** — `https://tienbeta.github.io/iptv_monitor/`: kết quả, nút **Chạy ngay**, trạng thái lần chạy, **Lịch chạy**.

Thứ tự: A (Sheet) → B (GitHub) → C (chạy lần đầu) → D (chia sẻ cho MKT).
Đã cài bản cũ (lịch chạy bằng cron của GitHub)? Làm mục **E. Cập nhật lên bản mới**.

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
2. Chọn **IPTV Monitor → Quản trị → Cài đặt ban đầu**.
3. Google hỏi quyền: **Tiếp tục** → chọn tài khoản của bạn → màn hình *“Google chưa xác minh ứng dụng này”* → **Nâng cao** → **Đi tới IPTV Monitor (không an toàn)** → **Cho phép**.
   (Đây là script của chính bạn trong Sheet của bạn, nên cảnh báo này là bình thường.)
4. Nếu lần đầu Google chỉ xin quyền mà không chạy, chọn lại **IPTV Monitor → Quản trị → Cài đặt ban đầu**.
5. Hộp thoại hiện **Bridge token** (chuỗi 64 ký tự). **Copy lại** — dùng ở bước B3.
   (Xem lại bất cứ lúc nào: **IPTV Monitor → Quản trị → Xem bridge token**.)
   Hộp thoại cũng có **mã thao tác dashboard** (mã ngẫu nhiên dạng `ABCD-EFGH`, dùng ở mục D) và lịch tự chạy mặc định.
   Muốn mã dễ nhớ: **IPTV Monitor → Quản trị → Đặt / đổi mã thao tác dashboard** → gõ mã của bạn (VD `VULCAN-2026`).

Sheet giờ có: `Config`, `Exclude`, `Streams` và `_data` (ẩn).

**A5. Deploy web app** (để GitHub Actions đọc/ghi được Sheet).
1. Ở tab Apps Script: nút **Deploy (Triển khai) → New deployment (Tuỳ chọn triển khai mới)**.
2. Bấm bánh răng cạnh *Select type* → chọn **Web app**.
3. Điền:
   - Description: `bridge`
   - Execute as: **Me (email của bạn)**
   - Who has access: **Anyone (Bất kỳ ai)** ← bắt buộc, GitHub không đăng nhập Google được (để *Only myself* sẽ luôn lỗi 401).
     “Anyone” chỉ áp dụng cho link web app, **Sheet vẫn private**. Không có bridge token thì không đọc/ghi được gì;
     script có `@OnlyCurrentDoc` nên chỉ đụng được chính Sheet này.
     Dashboard cũng gọi link này (nên link hiện công khai trong trang): ai cũng xem được *trạng thái lần chạy*,
     còn **Chạy ngay** và **đổi lịch** phải có mã thao tác; đọc/ghi Sheet vẫn chỉ bằng bridge token.
4. **Deploy** → cho phép quyền nếu được hỏi → copy **Web app URL** (dạng `https://script.google.com/macros/s/…/exec`). Dùng ở bước B3.

> Kiểm tra nhanh: dán Web app URL vào trình duyệt → phải thấy `{"ok":true,"service":"iptv-monitor"}`.

---

## B. GitHub

**B1. Đưa code lên nhánh `main`.** Lịch tự chạy và nút “Chạy ngay” chỉ chạy workflow nằm trên nhánh `main`.

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

**B4. Tạo GitHub token** (để Sheet gọi được GitHub — dùng cho **cả lịch tự chạy lẫn “Chạy ngay”**).
1. Ảnh đại diện góc phải → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Điền:
   - Token name: `IPTV Sheet`
   - Expiration: **dài nhất có thể** (VD 1 năm) và ghi lịch nhắc tạo lại trước ngày hết hạn — token hết hạn thì **lịch tự chạy dừng** (dashboard và ô Trạng thái sẽ báo lỗi)
   - Repository access: **Only select repositories** → `TienBeta/iptv_monitor`
   - Permissions → Repository permissions → **Actions: Read and write** (không cần quyền nào khác)
3. **Generate token** → copy.
4. Quay lại Google Sheet → **IPTV Monitor → Quản trị → Nhập GitHub token** → dán → **OK**.

---

## C. Chạy lần đầu

**C1. Chọn phạm vi.** Sheet `Config`:

| Ô | Ví dụ | Ghi chú |
|---|---|---|
| B3 Quốc gia | `VN` | Nhiều nước: `VN, TH`. Để trống = tất cả (~13.000 link) |
| B4 Ngôn ngữ | để trống | VD `vie` |
| B5 Thể loại | để trống | VD `news, sports` |
| B6 Mức kiểm tra | `3 - Tải được dữ liệu video` | Chọn trong danh sách |

**C2. Chạy.** Menu **IPTV Monitor → Chạy ngay**. Ô **B9 Thông báo** báo *“Đã gửi yêu cầu chạy lúc …”*.
(Hoặc trên GitHub: tab **Actions → IPTV check → Run workflow → main → Run workflow**.
Nút **Chạy ngay** trên dashboard dùng được từ sau lần chạy đầu tiên này.)

**C3. Theo dõi.** Ngay trong sheet `Config`, dòng 8 **Trạng thái** tự cập nhật mỗi phút:
*⏳ Đang chờ GitHub bắt đầu chạy…* → *⏳ Đang chạy… (đã N phút)* (nền vàng) → *✓ Xong lúc …* (nền xanh) hoặc *✗ Lỗi lúc …* (nền đỏ).
Khi đang ⏳, “Chạy ngay” (ở Sheet hay dashboard) sẽ bị từ chối — kể cả khi đang chạy theo lịch — để không tạo nhiều lần chạy chồng nhau.
Dashboard hiện cùng trạng thái này ở thanh trên cùng.
Ô C8 **Xem chi tiết trên GitHub** mở đúng lần chạy đó (phần **Summary** có bảng số link theo trạng thái; nếu lỗi, log ghi rõ nguyên nhân).
Phạm vi VN thường xong sau khoảng 2–3 phút.

**C4. Bật dashboard** (chỉ làm một lần, sau khi lần chạy đầu xong vì nó tạo nhánh `gh-pages`):
**Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `gh-pages` / `(root)` → Save**.
Khoảng 1–2 phút sau mở <https://tienbeta.github.io/iptv_monitor/>.

**C5. Kiểm tra.**
- Sheet `Streams` có danh sách kênh, cột **Trạng thái** tô màu.
- Sheet `Config`: dòng 7 **Lịch tự chạy** (*Mỗi 3 giờ (01:00, 04:00, …)*); khối **LẦN CHẠY GẦN NHẤT** có thời điểm, nguồn dữ liệu, kết quả (*84 link: 70 hoạt động · 14 không hoạt động*), thời gian chạy, link dashboard.
- Dashboard hiện cùng số liệu.
- Dashboard: thanh trên cùng ghi *Đã chạy xong* và *Tự chạy mỗi 3 giờ · lần tới …*.
- Sau vài giờ, tab **Actions** có các lần chạy tự động (sự kiện *workflow_dispatch*) trong khoảng 10 phút sau 01:00, 04:00, 07:00, 10:00, 13:00, 16:00, 19:00, 22:00 giờ Việt Nam (lịch mặc định).

---

## D. Chia sẻ cho MKT

1. Google Sheet → **Chia sẻ** → thêm email MKT → quyền **Người chỉnh sửa (Editor)**.
2. Gửi link dashboard: <https://tienbeta.github.io/iptv_monitor/>.
3. Hướng dẫn MKT (3 dòng):
   - Chỉ sửa **ô vàng B3–B6** trong `Config` và sheet `Exclude`. Sửa xong hệ thống **tự chạy lại sau 1–2 phút**.
   - Muốn chạy ngay: menu **IPTV Monitor → Chạy ngay** (hoặc nút **Chạy ngay** trên dashboard), rồi xem ô **Trạng thái** (dòng 8). Đang ⏳ thì chưa bấm lại được — đợi ✓ Xong.
   - Các mục khác trong menu nằm ở **Quản trị** — dành cho chủ Sheet, MKT không cần bấm.
   - Sheet `Streams` tự cập nhật theo lịch; lọc/sắp xếp thoải mái, nhưng sửa tay sẽ bị ghi đè.
4. Người được phép bấm **Chạy ngay** / đổi **Lịch chạy** trên dashboard: gửi riêng cho họ **mã thao tác**
   (**IPTV Monitor → Quản trị → Xem mã thao tác dashboard**). Dashboard hỏi mã ở lần bấm đầu và có thể ghi nhớ trên máy đó.
   Người chỉ xem thì không cần mã.
   Mã **cố định** cho tới khi bạn đổi (chạy lại *Cài đặt ban đầu* cũng không đổi mã). Tự đặt mã dễ nhớ:
   **IPTV Monitor → Quản trị → Đặt / đổi mã thao tác dashboard** → 6–32 chữ không dấu / số, có thể có dấu gạch
   (không phân biệt hoa thường; tránh mã dễ đoán). Để trống = tạo mã ngẫu nhiên.

> **Lưu ý bảo mật:** người có quyền Editor mở được Apps Script và xem được 2 token.
> GitHub token chỉ có quyền chạy/huỷ workflow của repo này; bridge token chỉ đọc/ghi được chính Sheet này.
> Mã thao tác chỉ cho phép chạy kiểm tra và đổi lịch trên dashboard; nhập sai 10 lần thì bị khoá 15 phút.
> Nếu một người rời team: **IPTV Monitor → Quản trị → Đặt / đổi mã thao tác dashboard**, tạo GitHub token mới (B4) và đổi bridge token
> (xoá `BRIDGE_TOKEN` trong *Apps Script → Project Settings → Script Properties*, chạy lại **Cài đặt ban đầu**, cập nhật secret B3).

---

## E. Cập nhật lên bản mới (đã cài bản cũ)

Bản này chuyển **lịch tự chạy từ cron của GitHub sang Apps Script** (để đổi được lịch trên dashboard) và thêm
nút **Chạy ngay** + trạng thái trên dashboard. Làm **E1–E3 trước khi merge** code mới vào `main`
— nếu merge trước thì trong lúc chờ sẽ không có lần tự chạy nào.

1. **E1.** Apps Script: xoá hết `Code.gs` → dán bản mới từ [`apps-script/Code.gs`](../apps-script/Code.gs) → **Save**.
2. **E2.** Google Sheet: tải lại trang → **IPTV Monitor → Quản trị → Cài đặt ban đầu**
   (Sheet cũ chưa có menu *Quản trị* thì chọn **IPTV Monitor → Cài đặt ban đầu**). Không mất cấu hình (B3–B6, Exclude);
   bước này bật lịch tự chạy (mặc định mỗi 3 giờ từ 01:00, giống lịch cũ), tạo mã thao tác và chuyển `Config`
   sang bố cục mới: bỏ ô tick B7, thêm dòng *Lịch tự chạy* / *Thông báo*, khối kết quả gọn lại (hiện lại sau lần chạy tới).
3. **E3.** Apps Script: **Deploy → Manage deployments** → bút chì → Version: **New version** → **Deploy** (URL giữ nguyên).
4. **E4.** Merge code mới vào `main`.
5. **E5.** Chạy một lần (menu **IPTV Monitor → Chạy ngay**) để dashboard nhận link điều khiển → thanh **Chạy ngay** xuất hiện.
   Sau lần chạy này khối **LẦN CHẠY GẦN NHẤT** được ghi lại theo dạng gọn mới.
6. **E6.** Gửi mã thao tác cho người được phép (mục D, bước 4).

---

## F. Vận hành

| Việc | Cách làm |
|---|---|
| Xem lịch sử chạy / lỗi | GitHub → tab **Actions**. Lỗi phía Sheet: Apps Script → **Executions** |
| Cập nhật code Apps Script | Dán code mới → Save → **Deploy → Manage deployments** → bút chì → Version: **New version** → Deploy (URL giữ nguyên) |
| Đổi lịch tự chạy / tạm dừng | Dashboard → **Lịch chạy** → chọn *Chạy mỗi* + *Bắt đầu từ*, hoặc bỏ tick *Tự động chạy* → **Lưu lịch** (cần mã thao tác). Dừng hẳn: Actions → IPTV check → `···` → **Disable workflow** |
| GitHub token hết hạn | Làm lại B4. Trong lúc hết hạn **không có lần tự chạy nào**; dashboard / ô Trạng thái báo “Không tự chạy được…” |
| Đặt / đổi mã thao tác | **IPTV Monitor → Quản trị → Đặt / đổi mã thao tác dashboard** → gõ mã tự chọn (hoặc để trống = ngẫu nhiên) → gửi mã mới; ai lưu mã cũ sẽ được hỏi lại |
| Chạy thử với stream thật, không đụng tới Sheet | Actions → **Smoke test** → Run workflow → nhập quốc gia + mức → xem **Summary** |
| Chạy thử trên máy (tuỳ chọn, cần Node 22+) | `COUNTRIES=VN LEVEL=3 node checker/index.js` → `dist/results.json`; `npm test` để chạy test |

## G. Xử lý sự cố

| Triệu chứng | Nguyên nhân | Cách sửa |
|---|---|---|
| Run có cảnh báo “Chưa có secret … bỏ qua lần chạy này” | Chưa làm B3 | Thêm 2 secret |
| “Apps Script trả về không phải JSON (HTTP 401)” | GitHub bị Google bắt đăng nhập: web app không để **Anyone**, hoặc URL trong secret là bản `/dev` | Apps Script → **Deploy → Manage deployments** → bút chì → *Who has access*: **Anyone** → Version: **New version** → **Deploy**. Kiểm tra secret `SHEET_BRIDGE_URL` kết thúc bằng `/exec`. Thử: mở URL trong cửa sổ ẩn danh phải thấy `{"ok":true,…}` mà không phải đăng nhập |
| Danh sách *Who has access* không có **Anyone** (chỉ có “Anyone within <công ty>” / “Anyone with Google account”) | Tài khoản Google Workspace công ty bị admin chặn chia sẻ ra ngoài | Nhờ admin cho phép, hoặc tạo Sheet + Apps Script bằng tài khoản Gmail cá nhân rồi chia sẻ Sheet cho MKT |
| “Apps Script trả về không phải JSON … Who has access: Anyone” | Web app deploy sai quyền truy cập | Làm lại A5 với **Anyone** |
| “Apps Script từ chối (load): …” / “unauthorized” | Token hoặc link web app trong GitHub không khớp với Sheet | Mở **IPTV Monitor → Quản trị → Xem bridge token** (có nút Copy và *Mã kiểm tra*) rồi so với dòng lỗi trong log: **(1)** “chưa có bridge token” hoặc *mã Sheet chờ* ≠ *Mã kiểm tra* trong menu → `SHEET_BRIDGE_URL` đang trỏ tới Apps Script khác: copy lại URL trong hộp thoại (hoặc Deploy → Manage deployments) vào secret. **(2)** *mã GitHub gửi* ≠ *Mã kiểm tra* → copy lại token vào `SHEET_BRIDGE_TOKEN`. Secret phải nằm ở tab **Actions** (không phải Codespaces / Dependabot) |
| “chưa có sheet Config” | Chưa chạy **Cài đặt ban đầu** | Làm A4 |
| Ô Thông báo (B9) báo “không tìm thấy workflow check.yml trên nhánh main” | Code chưa ở `main` | Làm B1 |
| Ô Thông báo (B9) báo “GitHub token sai hoặc đã hết hạn” / “thiếu quyền” | Token hết hạn hoặc thiếu quyền Actions | Làm lại B4 |
| Bước “Đăng dashboard” lỗi 403 | Workflow chưa có quyền ghi | Làm B2 |
| Dashboard 404 | Chưa bật Pages hoặc chưa có lần chạy nào | Làm C2 rồi C4 |
| Nhiều kênh VN “Bị chặn truy cập (có thể do giới hạn quốc gia)” | Máy kiểm tra của GitHub đặt ở Mỹ | Giới hạn đã biết; mở thử bằng VLC ở Việt Nam |
| Dashboard không có thanh **Chạy ngay** | Chưa có lần chạy nào kể từ khi cập nhật (dashboard lấy link điều khiển từ kết quả mới nhất) | Chạy một lần (E5) |
| Dashboard: “Apps Script trong Sheet chưa được cập nhật bản mới” | Web app vẫn đang chạy version cũ | Làm E1–E3 (nhớ bước **New version**) |
| Dashboard: “Không lấy được trạng thái lần chạy” | Web app không để **Anyone**, hoặc mạng chặn `script.google.com` | Làm lại A5 với **Anyone** → New version |
| Dashboard / ô Trạng thái: “Không tự chạy được lượt …: GitHub token …” | Token hết hạn hoặc thiếu quyền | Làm lại B4 |
| Dashboard: “Mã thao tác không đúng” / “Nhập sai mã quá nhiều lần” | Sai mã, hoặc mã đã được đổi | Lấy mã ở **IPTV Monitor → Quản trị → Xem mã thao tác dashboard**; bị khoá thì đợi 15 phút |
| Tab Actions không có lần tự chạy | Chưa làm E2 (trigger `autoRun` chưa được bật) hoặc lịch đang tắt | Làm E2; kiểm tra Apps Script → **Triggers** có `autoRun` mỗi 10 phút; xem **Lịch chạy** trên dashboard |
