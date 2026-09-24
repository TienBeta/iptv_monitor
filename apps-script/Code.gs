/**
 * @OnlyCurrentDoc  Script chỉ được truy cập chính Google Sheet này, không đụng tới file khác trong Drive.
 *
 * IPTV Monitor — Apps Script gắn với Google Sheet.
 *
 * - Web app (doPost): GitHub Actions đọc cấu hình + trạng thái cũ ("load")
 *   và ghi kết quả ("save"). Mọi request phải có đúng BRIDGE_TOKEN.
 * - Menu IPTV Monitor → Chạy ngay (hoặc nút trên dashboard): gọi GitHub API
 *   để chạy workflow ngay.
 * - Sửa Config / Exclude: tự hẹn chạy lại sau khoảng 1 phút.
 * - Lịch tự chạy: trigger autoRun (mỗi 10 phút) chạy workflow đúng các giờ đã hẹn.
 * - Dashboard: xem trạng thái (doGet ?action=status, ai cũng xem được);
 *   "Chạy ngay", đổi mức kiểm tra và lịch (doPost run / settings) cần mã thao tác.
 *
 * Cài đặt từng bước: docs/setup.md trong repo.
 */

const GITHUB_REPO = 'TienBeta/iptv_monitor';
const WORKFLOW_FILE = 'check.yml';
const GITHUB_REF = 'main';

const SHEET = { config: 'Config', exclude: 'Exclude', streams: 'Streams', data: '_data' };
// Config: B3:B6 inputs · B7 lịch tự chạy · B8 trạng thái · B9 thông báo ·
// A10 "LẦN CHẠY GẦN NHẤT" · summary from row 11. The script writes everything from row 7 down.
const CELL = { schedule: 'B7', message: 'B9' };
const INPUT_FIRST_ROW = 3; // B3:B6 = Quốc gia, Ngôn ngữ, Thể loại, Mức kiểm tra
const INPUT_LAST_ROW = 6;
const PROGRESS_ROW = 8;
const SUMMARY_HEADER_ROW = 10;
const STATE_COLORS = { busy: '#fff4cc', ok: '#d9f2e3', error: '#f8d4d4', idle: '#ffffff' };
const JUST_SENT_MS = 2 * 60 * 1000; // after a dispatch, GitHub may take a few seconds to list the run
const SUMMARY_ROW = 11;
const ACTIONS_URL = 'https://github.com/' + GITHUB_REPO + '/actions/workflows/' + WORKFLOW_FILE;
const WATCH_MAX_MS = 3 * 60 * 60 * 1000;
const SCHEDULE_HOURS = [1, 2, 3, 4, 6, 8, 12, 24];
// Same times as the old GitHub cron (17 */3 * * * UTC): 01:00, 04:00, … giờ Việt Nam.
const DEFAULT_SCHEDULE = { enabled: true, everyHours: 3, startHour: 1 };
const TICK_MINUTES = 10;
const HOUR_MS = 60 * 60 * 1000;
const VN_OFFSET_MS = 7 * HOUR_MS; // Việt Nam: UTC+7, không đổi giờ theo mùa
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 ký tự, bỏ I/O/0/1 dễ nhầm
const CODE_MAX_FAILS = 10;
const CODE_LOCK_MS = 15 * 60 * 1000;
const DASHBOARD_URL = 'https://' + GITHUB_REPO.split('/')[0].toLowerCase() + '.github.io/' + GITHUB_REPO.split('/')[1] + '/';
const STREAMS_HEADER = ['Tên kênh', 'Kênh', 'Quốc gia', 'Link', 'Trạng thái', 'Lý do', 'Kiểm tra lúc'];
const LEVEL_OPTIONS = [
  '1 - Link có phản hồi',
  '2 - Danh sách phát hợp lệ',
  '3 - Tải được dữ liệu video',
  '4a - Có hình hoặc tiếng',
  '4b - Giải mã được hình',
];
const STATUS_COLORS = {
  'Hoạt động': '#d9f2e3',
  'Chậm': '#fff4cc',
  'Đang lỗi': '#ffe2c6',
  'Không hoạt động': '#f8d4d4',
  'Không kiểm tra được': '#e8e8e8',
  'Chờ kiểm tra': '#e8e8e8',
};

// ---------------------------------------------------------------- menu

// MKT only needs "Chạy ngay"; the owner's items sit in a submenu so they are not clicked by mistake.
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('IPTV Monitor')
    .addItem('Chạy ngay', 'runNow')
    .addSeparator()
    .addSubMenu(ui.createMenu('Quản trị (chủ Sheet)')
      .addItem('Cài đặt ban đầu', 'setup')
      .addItem('Nhập GitHub token', 'setGithubToken')
      .addItem('Xem bridge token', 'showBridgeToken')
      .addSeparator()
      .addItem('Đặt / đổi mã thao tác dashboard', 'setDashboardCode'))
    .addToUi();
}

function runNow() {
  const msg = requestRun_();
  setMessage_(msg);
  SpreadsheetApp.getActive().toast(msg, 'IPTV Monitor', 8);
}

function setGithubToken() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt(
    'GitHub token',
    'Dán fine-grained token (chỉ repo ' + GITHUB_REPO + ', quyền "Actions: Read and write"):',
    ui.ButtonSet.OK_CANCEL,
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const token = res.getResponseText().trim();
  if (!token) return;
  PropertiesService.getScriptProperties().setProperty('GITHUB_TOKEN', token);
  ui.alert('Đã lưu GitHub token. Thử menu IPTV Monitor → Chạy ngay.');
}

// Shows the token in a box with a Copy button (copying from an alert is error-prone),
// plus its short "mã kiểm tra" to compare with the GitHub log when it says unauthorized.
function showBridgeToken() {
  const token = PropertiesService.getScriptProperties().getProperty('BRIDGE_TOKEN');
  if (!token) {
    alert_('Chưa có token — chạy menu IPTV Monitor → Quản trị → Cài đặt ban đầu.');
    return;
  }
  const url = ScriptApp.getService().getUrl() || '';
  const html = HtmlService.createHtmlOutput(
    '<div style="font:14px Arial,sans-serif;line-height:1.5">' +
    '<p>Dán vào GitHub → <b>Settings → Secrets and variables → Actions</b> → secret <b>SHEET_BRIDGE_TOKEN</b>:</p>' +
    copyBox_('t', token) +
    '<p>Mã kiểm tra: <b>' + tokenCode_(token) + '</b> (64 ký tự)</p>' +
    (/\/exec$/.test(url)
      ? '<p>Web app URL của Sheet này (secret <b>SHEET_BRIDGE_URL</b>):</p>' + copyBox_('u', url)
      : '<p>Web app URL: xem <b>Deploy → Manage deployments</b> trong Apps Script.</p>') +
    '<script>function cp(id){var e=document.getElementById(id);e.select();' +
    'try{navigator.clipboard.writeText(e.value)}catch(x){}document.execCommand("copy");' +
    'document.getElementById(id+"s").textContent="Đã copy";}</script></div>',
  ).setWidth(560).setHeight(url ? 330 : 250);
  const ui = sheetUi_();
  if (!ui) {
    Logger.log(token); // run from the editor: no UI
    return;
  }
  try {
    ui.showModalDialog(html, 'Bridge token');
  } catch (err) {
    // HTML dialogs can fail (e.g. several Google accounts signed in): a plain alert always opens.
    ui.alert('Bridge token', 'Token (secret SHEET_BRIDGE_TOKEN):\n' + token + '\n\nMã kiểm tra: ' + tokenCode_(token) +
      (url ? '\n\nWeb app URL (secret SHEET_BRIDGE_URL):\n' + url : ''), ui.ButtonSet.OK);
  }
}

// The Sheet's UI, or null when run from the Apps Script editor / a trigger.
function sheetUi_() {
  try {
    return SpreadsheetApp.getUi();
  } catch (err) {
    return null;
  }
}

function copyBox_(id, value) {
  const v = String(value).replace(/[&<>"]/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; });
  return '<input id="' + id + '" value="' + v + '" readonly onclick="this.select()" ' +
    'style="width:100%;box-sizing:border-box;font:12px monospace;padding:6px">' +
    '<button onclick="cp(\'' + id + '\')" style="margin-top:4px">Copy</button> <span id="' + id + 's"></span>';
}

// Short fingerprint of a token (first 3 bytes of SHA-256): safe to show, enough to compare.
function tokenCode_(token) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token), Utilities.Charset.UTF_8)
    .slice(0, 3).map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('').toUpperCase();
}

// The operator code lets the dashboard start a run and change the schedule.
// One menu item for it: the prompt shows the current code; typing a new one
// (e.g. VULCAN-2026) replaces it, empty / Huỷ keeps it. It never changes by itself.
function setDashboardCode() {
  const ui = SpreadsheetApp.getUi();
  const current = PropertiesService.getScriptProperties().getProperty('DASHBOARD_CODE') || saveNewCode_();
  const res = ui.prompt('Mã thao tác dashboard',
    'Mã hiện tại: ' + current + '\n' +
    'Dùng trên dashboard khi bấm "Chạy ngay" hoặc "Cài đặt" (' + DASHBOARD_URL + '). Chỉ xem kết quả thì không cần mã.\n\n' +
    'Đổi mã: nhập mã mới rồi bấm OK — 6–32 chữ không dấu hoặc số, có thể thêm dấu gạch / khoảng trắng ' +
    '(không phân biệt hoa thường; tránh mã dễ đoán như 123456). Mã cũ hết hiệu lực ngay.\n' +
    'Giữ mã hiện tại: để trống hoặc bấm Huỷ.',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const typed = res.getResponseText().trim();
  if (!typed) return;
  const problem = codeProblem_(typed);
  if (problem) {
    ui.alert(problem + '\n\nMã cũ vẫn giữ nguyên.');
    return;
  }
  showCodeDialog_(saveCode_(typed.toUpperCase().replace(/\s+/g, ' ')));
}

function codeProblem_(typed) {
  if (!/^[A-Za-z0-9 -]+$/.test(typed)) return 'Mã chỉ được có chữ không dấu (A–Z), số, dấu gạch hoặc khoảng trắng.';
  const core = normalizeCode_(typed);
  if (core.length < 6 || core.length > 32) return 'Mã cần 6–32 chữ hoặc số (không tính dấu gạch, khoảng trắng).';
  if (/^(.)\1+$/.test(core) || '0123456789'.indexOf(core) >= 0 || '9876543210'.indexOf(core) >= 0) {
    return 'Mã quá dễ đoán, hãy chọn mã khác.';
  }
  return null;
}

// A plain alert: always opens (unlike HTML dialogs), and an 8–32 character code is easy to copy by hand.
function showCodeDialog_(code) {
  const ui = sheetUi_();
  if (!ui) {
    Logger.log(code); // run from the editor: no UI
    return;
  }
  ui.alert('Đã đổi mã thao tác dashboard',
    'Mã: ' + code + '\n\n' +
    'Dùng trên dashboard khi bấm "Chạy ngay" hoặc "Cài đặt" (dashboard hỏi mã ở lần bấm đầu). ' +
    'Chỉ xem kết quả thì không cần mã.\n\n' +
    'Dashboard: ' + DASHBOARD_URL + '\n\n' +
    'Chỉ gửi mã cho người được phép chạy kiểm tra. Đổi mã: IPTV Monitor → Quản trị → Đặt / đổi mã thao tác dashboard.',
    ui.ButtonSet.OK);
}

function saveNewCode_() {
  return saveCode_(formatCode_(newCode_()));
}

// Stored as shown to people (e.g. ABCD-EFGH); compared without dashes/spaces/case.
function saveCode_(code) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('DASHBOARD_CODE', code);
  props.deleteProperty('CODE_FAILS');
  return code;
}

// 8 characters from a 32-letter alphabet, from UUID randomness (Math.random is not for secrets).
function newCode_() {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid() + Utilities.getUuid(), Utilities.Charset.UTF_8);
  let code = '';
  for (let i = 0; i < 8; i++) code += CODE_CHARS.charAt((bytes[i] + 256) % 32);
  return code;
}

function formatCode_(code) {
  return code.slice(0, 4) + '-' + code.slice(4);
}

function normalizeCode_(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Wrong codes are counted; after CODE_MAX_FAILS in CODE_LOCK_MS every code is
// refused until the window ends, so the code cannot be guessed by trying.
function checkCode_(given) {
  const props = PropertiesService.getScriptProperties();
  const code = props.getProperty('DASHBOARD_CODE');
  if (!code) {
    return { error: 'no_code', message: 'Sheet chưa có mã thao tác — chủ Sheet mở menu IPTV Monitor → Quản trị → Đặt / đổi mã thao tác dashboard.' };
  }
  const now = Date.now();
  let fails = JSON.parse(props.getProperty('CODE_FAILS') || 'null');
  if (!fails || now - fails.since > CODE_LOCK_MS) fails = { n: 0, since: now };
  if (fails.n >= CODE_MAX_FAILS) {
    const minutes = Math.max(1, Math.ceil((fails.since + CODE_LOCK_MS - now) / 60000));
    return { error: 'locked', message: 'Nhập sai mã quá nhiều lần — thử lại sau ' + minutes + ' phút.' };
  }
  if (normalizeCode_(given) === normalizeCode_(code)) return null;
  fails.n++;
  props.setProperty('CODE_FAILS', JSON.stringify(fails));
  return { error: 'bad_code', message: 'Mã thao tác không đúng.' };
}

// ---------------------------------------------------------------- setup

function setup() {
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone('Asia/Ho_Chi_Minh');
  setupConfigSheet_(ss);
  setupExcludeSheet_(ss);
  setupStreamsSheet_(ss);
  setupDataSheet_(ss);
  removeEmptyDefaultSheet_(ss);

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('BRIDGE_TOKEN')) props.setProperty('BRIDGE_TOKEN', newToken_());
  if (!props.getProperty('DASHBOARD_CODE')) saveNewCode_();
  installEditTrigger_(ss);
  ensureScheduleTrigger_();
  showSchedule_();
  ss.setActiveSheet(ss.getSheetByName(SHEET.config));

  alert_('Cài đặt xong.\n\nBridge token (dán vào GitHub secret SHEET_BRIDGE_TOKEN):\n\n' +
    props.getProperty('BRIDGE_TOKEN') +
    '\n\nMã thao tác dashboard (Chạy ngay / đổi lịch): ' + props.getProperty('DASHBOARD_CODE') +
    ' (tự đặt mã khác: menu IPTV Monitor → Quản trị → Đặt / đổi mã thao tác dashboard)' +
    '\nLịch tự chạy: ' + scheduleText_(readSchedule_()) +
    '\n\nBước tiếp theo: Deploy → New deployment → Web app (xem docs/setup.md).');
}

function setupConfigSheet_(ss) {
  const sh = ss.getSheetByName(SHEET.config) || ss.insertSheet(SHEET.config, 0);
  if (sh.getRange('A3').getValue() !== 'Quốc gia') {
    sh.getRange('A1:C6').setValues([
      ['IPTV MONITOR — CẤU HÌNH', '', ''],
      ['Mục', 'Giá trị', 'Hướng dẫn'],
      ['Quốc gia', 'VN', 'Mã 2 chữ cái, cách nhau dấu phẩy. VD: VN, TH. Để trống = tất cả quốc gia'],
      ['Ngôn ngữ', '', 'Mã 3 chữ cái. VD: vie, eng. Để trống = không lọc'],
      ['Thể loại', '', 'VD: news, sports, movies, kids, music. Để trống = không lọc'],
      ['Mức kiểm tra', LEVEL_OPTIONS[2], 'Mức càng cao càng chắc chắn nhưng chạy lâu hơn'],
    ]);
  }
  if (sh.getRange('A9').getValue() !== 'Thông báo') layoutRunRows_(sh);
  if (sh.getRange(PROGRESS_ROW, 2).getValue() === '') setProgress_('Sẵn sàng', ACTIONS_URL, 'idle', { phase: 'idle' });
  sh.getRange('C6').setValue('Mức càng cao càng chắc chắn nhưng chạy lâu hơn. Đổi ở đây hoặc trên dashboard (nút "Cài đặt")');
  sh.getRange('C7').setValue('Đổi trên dashboard: nút "Cài đặt"');
  sh.getRange('C8').clearContent(); // the old "Xem chi tiết trên GitHub" link
  sh.getRange('B6').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(LEVEL_OPTIONS, true).setAllowInvalid(false).build());
  sh.getRange('A1').setFontWeight('bold').setFontSize(13);
  sh.getRange('A2:C2').setFontWeight('bold').setBackground('#f1f3f4');
  sh.getRange('A7:A9').setFontWeight('normal');
  sh.getRange('A' + SUMMARY_HEADER_ROW).setFontWeight('bold');
  sh.getRange('B3:B6').setBackground('#fff8e1');
  sh.setColumnWidth(1, 170);
  sh.setColumnWidth(2, 260);
  sh.setColumnWidth(3, 460);
  // Warnings only: MKT edits B3:B6; labels and what the script writes stay intact.
  protectOnce_(sh, 'A1:A30', 'Nhãn cấu hình');
  protectOnce_(sh, 'B7:B9', 'Lịch, trạng thái, thông báo (script tự ghi)');
  protectOnce_(sh, 'B' + SUMMARY_ROW + ':B30', 'Kết quả lần chạy (script tự ghi)');
}

// Rows 7–10 (lịch tự chạy, trạng thái, thông báo, header). Also turns the old
// layout — B7 "Chạy ngay" checkbox, header in row 9, summary from row 10 — into
// this one; the next run writes the summary again.
function layoutRunRows_(sh) {
  sh.getRange('B7').clearDataValidations(); // the old checkbox
  sh.getRange('A7:C7').clearContent();
  sh.getRange('A9:C30').clearContent();
  sh.getRange('A7').setValue('Lịch tự chạy');
  sh.getRange('A8').setValue('Trạng thái');
  sh.getRange('A9').setValue('Thông báo');
  sh.getRange('A' + SUMMARY_HEADER_ROW).setValue('LẦN CHẠY GẦN NHẤT');
}

function protectOnce_(sh, a1, description) {
  const exists = sh.getProtections(SpreadsheetApp.ProtectionType.RANGE)
    .some(function (p) { return p.getDescription() === description; });
  if (!exists) sh.getRange(a1).protect().setDescription(description).setWarningOnly(true);
}

// B7: the schedule in words (it is changed on the dashboard).
function showSchedule_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.config);
  if (!sh) return;
  const s = readSchedule_();
  const text = s.enabled
    ? 'Mỗi ' + scheduleText_(s).slice(4)
    : 'Đang tắt (chỉ chạy khi bấm Chạy ngay hoặc sửa cấu hình)';
  sh.getRange(CELL.schedule).setValue(text);
}

// A: what to leave out — a name / channel ID / part of a link ("An Ninh") or a
// full link. B: notes. C: what each line removes, written by the script after each run.
function setupExcludeSheet_(ss) {
  const sh = ss.getSheetByName(SHEET.exclude) || ss.insertSheet(SHEET.exclude);
  sh.getRange('A1:C1').setValues([[
    'Bỏ qua: tên kênh, mã kênh hoặc link (VD: An Ninh)', 'Ghi chú', 'Đang bỏ (tự cập nhật sau mỗi lần chạy)',
  ]]);
  sh.getRange('A1:C1').setFontWeight('bold').setBackground('#f1f3f4');
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 420);
  sh.setColumnWidth(2, 260);
  sh.setColumnWidth(3, 420);
  protectOnce_(sh, 'C:C', 'Kết quả loại trừ (script tự ghi)');
}

function setupStreamsSheet_(ss) {
  const sh = ss.getSheetByName(SHEET.streams) || ss.insertSheet(SHEET.streams);
  sh.getRange(1, 1, 1, STREAMS_HEADER.length).setValues([STREAMS_HEADER])
    .setFontWeight('bold').setBackground('#f1f3f4');
  sh.setFrozenRows(1);
  [240, 170, 140, 420, 140, 300, 130].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  const statusRange = sh.getRange('E2:E');
  sh.setConditionalFormatRules(Object.keys(STATUS_COLORS).map(function (label) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(label).setBackground(STATUS_COLORS[label]).setRanges([statusRange]).build();
  }));
  if (!sh.getFilter()) sh.getRange(1, 1, Math.max(2, sh.getLastRow()), STREAMS_HEADER.length).createFilter();
  if (!sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) {
    sh.protect().setDescription('Script ghi đè mỗi lần chạy — sửa tay sẽ mất').setWarningOnly(true);
  }
}

function setupDataSheet_(ss) {
  const sh = ss.getSheetByName(SHEET.data) || ss.insertSheet(SHEET.data);
  sh.hideSheet();
  if (!sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) {
    const p = sh.protect().setDescription('Dữ liệu nội bộ — chỉ script ghi');
    p.addEditor(Session.getEffectiveUser());
    p.removeEditors(p.getEditors());
    if (p.canDomainEdit()) p.setDomainEdit(false);
  }
}

function removeEmptyDefaultSheet_(ss) {
  ss.getSheets().forEach(function (sh) {
    const ours = Object.keys(SHEET).some(function (k) { return SHEET[k] === sh.getName(); });
    if (!ours && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
}

function installEditTrigger_(ss) {
  const exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'onConfigEdit';
  });
  if (!exists) ScriptApp.newTrigger('onConfigEdit').forSpreadsheet(ss).onEdit().create();
}

function newToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

// ---------------------------------------------------------------- run now / auto-run

// Installable trigger (runs as the owner, so MKT editors need no permission).
function onConfigEdit(e) {
  if (!e || !e.range) return;
  const range = e.range;
  const sh = range.getSheet();
  const name = sh.getName();

  if (name === SHEET.config) {
    const touchesInputs = range.getColumn() <= 2 && range.getLastColumn() >= 2 &&
      range.getRow() <= INPUT_LAST_ROW && range.getLastRow() >= INPUT_FIRST_ROW;
    if (touchesInputs) {
      scheduleRun_();
      setMessage_('Cấu hình vừa thay đổi — sẽ tự chạy lại sau khoảng 1–2 phút.');
    }
    return;
  }
  if (name === SHEET.exclude && range.getColumn() === 1) { // notes (B) and the report (C) don't count
    scheduleRun_();
    setMessage_('Danh sách loại trừ vừa thay đổi — sẽ tự chạy lại sau khoảng 1–2 phút.');
  }
}

// Many edits in a row → one run: each edit replaces the pending trigger.
function scheduleRun_() {
  deleteTriggers_('scheduledRun');
  ScriptApp.newTrigger('scheduledRun').timeBased().after(60 * 1000).create();
}

// Config changed: always queue one run (GitHub runs it after the current one),
// so the new settings are applied even if a run is in progress.
function scheduledRun() {
  deleteTriggers_('scheduledRun');
  const busy = activeRun_();
  const msg = dispatchSafe_();
  setMessage_(busy && msg.indexOf('Đã gửi') === 0
    ? 'Cấu hình đã đổi — sẽ chạy lại ngay sau lần chạy hiện tại.'
    : msg);
}

// "Chạy ngay" from the Sheet menu: refused while a run is queued or running.
function requestRun_() {
  const r = tryRun_();
  if (r.busy) return 'Đang có một lần chạy — đợi dòng "Trạng thái" báo Xong rồi hãy chạy lại.';
  if (r.error) return 'Không gửi được yêu cầu chạy: ' + r.error;
  return sentMessage_();
}

// The one place that starts a run for "Chạy ngay" (Sheet, dashboard) and the
// schedule: refused while a run is queued or running (from anywhere), so
// repeated clicks never pile up runs. Returns { ok } / { busy } / { error }.
function tryRun_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, busy: true }; // a save holds the lock: a run is on
  try {
    const active = activeRun_();
    if (active) {
      watchRun_(active);
      return { ok: false, busy: true };
    }
    return dispatch_();
  } finally {
    lock.releaseLock();
  }
}

function deleteTriggers_(handler) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
  });
}

function dispatchSafe_() {
  const r = dispatch_();
  return r.error ? 'Không gửi được yêu cầu chạy: ' + r.error : sentMessage_();
}

function dispatch_() {
  try {
    dispatchWorkflow_();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  try {
    startWatch_();
  } catch (err) {
    const msg = 'Không theo dõi được trạng thái: ' + err.message;
    setProgress_(msg, ACTIONS_URL, 'error', { phase: 'error', message: msg });
  }
  return { ok: true };
}

function sentMessage_(from) {
  return 'Đã gửi yêu cầu chạy' + (from || '') + ' lúc ' +
    Utilities.formatDate(new Date(), 'Asia/Ho_Chi_Minh', 'HH:mm dd/MM/yyyy') + '. Xem dòng "Trạng thái".';
}

function dispatchWorkflow_() {
  const res = githubFetch_('/actions/workflows/' + WORKFLOW_FILE + '/dispatches', { ref: GITHUB_REF });
  if (res.getResponseCode() !== 204) throw githubError_(res);
}

function githubFetch_(path, body) {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('chưa nhập GitHub token (menu IPTV Monitor → Quản trị → Nhập GitHub token).');
  const options = {
    method: body ? 'post' : 'get',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    muteHttpExceptions: true,
  };
  if (body) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(body);
  }
  return UrlFetchApp.fetch('https://api.github.com/repos/' + GITHUB_REPO + path, options);
}

function githubError_(res) {
  const code = res.getResponseCode();
  if (code === 401) return new Error('GitHub token sai hoặc đã hết hạn — tạo token mới và nhập lại.');
  if (code === 403) return new Error('GitHub token thiếu quyền "Actions: Read and write".');
  if (code === 404) return new Error('không tìm thấy workflow ' + WORKFLOW_FILE + ' trên nhánh ' + GITHUB_REF + '.');
  return new Error('GitHub trả về ' + code + ': ' + res.getContentText().slice(0, 200));
}

// ---------------------------------------------------------------- status (dòng 8 của Config)

// Returns the run that is queued/running now, or null. Reads GitHub, so it also
// sees the scheduled runs. Right after a dispatch GitHub may not list the new
// run yet: the pending watch covers that gap.
function activeRun_() {
  let runs;
  try {
    runs = recentRuns_();
  } catch (err) {
    return null; // e.g. no token yet: let the dispatch report the problem
  }
  const active = runs.find(function (r) { return r.status !== 'completed'; });
  if (active) return active;
  const watch = readWatch_();
  if (watch && !watch.runId && Date.now() - watch.since < JUST_SENT_MS &&
      !runs.some(function (r) { return createdAt_(r) >= watch.since - 60 * 1000; })) {
    return { status: 'queued', html_url: ACTIONS_URL };
  }
  return null;
}

// After "Chạy ngay": check GitHub every minute and mirror the run's status.
function startWatch_() {
  const now = Date.now();
  saveWatch_({ since: now });
  setProgress_('⏳ Đang chờ GitHub bắt đầu chạy…', ACTIONS_URL, 'busy', { phase: 'queued', since: now });
  ensureWatchTrigger_();
}

// Follow a run that is already known (e.g. a scheduled run found in progress).
function watchRun_(run) {
  const watch = { since: run.created_at ? createdAt_(run) : Date.now() };
  if (run.id) watch.runId = run.id;
  saveWatch_(watch);
  showRun_(run);
  ensureWatchTrigger_();
}

function watchRun() {
  const watch = readWatch_();
  if (!watch || Date.now() - watch.since > WATCH_MAX_MS) {
    if (watch) {
      const msg = 'Quá 3 giờ chưa thấy kết quả lần chạy — báo người quản lý kiểm tra';
      setProgress_(msg, ACTIONS_URL, 'error', { phase: 'error', message: msg });
    }
    stopWatch_();
    return;
  }
  let runs;
  try {
    runs = recentRuns_();
  } catch (err) {
    const msg = 'Không đọc được trạng thái từ GitHub: ' + err.message;
    setProgress_(msg, ACTIONS_URL, 'error', { phase: 'error', message: msg });
    return;
  }
  const run = watch.runId
    ? runs.find(function (r) { return r.id === watch.runId; })
    : runs.find(function (r) { return createdAt_(r) >= watch.since - 60 * 1000; });
  if (!run) {
    if (Date.now() - watch.since > 15 * 60 * 1000) {
      const msg = 'GitHub chưa bắt đầu chạy sau 15 phút — thử Chạy ngay lại sau ít phút';
      setProgress_(msg, ACTIONS_URL, 'error', { phase: 'error', message: msg });
      stopWatch_();
    }
    return;
  }
  if (!watch.runId && run.id) {
    watch.runId = run.id;
    saveWatch_(watch);
  }
  showRun_(run);
  if (run.status === 'completed') stopWatch_();
}

function showRun_(run) {
  const started = new Date(run.run_started_at || run.created_at || Date.now());
  if (run.status !== 'completed') {
    if (run.status === 'in_progress') {
      const minutes = Math.max(0, Math.round((Date.now() - started.getTime()) / 60000));
      setProgress_('⏳ Đang chạy… (bắt đầu ' + hhmm_(started) + ', đã ' + minutes + ' phút)', run.html_url, 'busy',
        { phase: 'running', startedAt: started.getTime() });
    } else {
      setProgress_('⏳ Đang chờ GitHub bắt đầu chạy…', run.html_url, 'busy', { phase: 'queued', since: started.getTime() });
    }
    return;
  }
  const finished = new Date(run.updated_at || Date.now());
  const at = hhmm_(finished);
  const times = { startedAt: started.getTime(), finishedAt: finished.getTime() };
  if (run.conclusion === 'success') {
    setProgress_('✓ Xong lúc ' + at + ' — có thể bấm Chạy ngay lại', run.html_url, 'ok', Object.assign({ phase: 'success' }, times));
  } else if (run.conclusion === 'cancelled') {
    setProgress_('Đã huỷ lúc ' + at, run.html_url, 'idle', Object.assign({ phase: 'cancelled' }, times));
  } else {
    setProgress_('✗ Lỗi lúc ' + at + ' — thử Chạy ngay lại; nếu vẫn lỗi, báo người quản lý', run.html_url, 'error',
      Object.assign({ phase: 'failure' }, times));
  }
}

function ensureWatchTrigger_() {
  const watching = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'watchRun'; });
  if (!watching) ScriptApp.newTrigger('watchRun').timeBased().everyMinutes(1).create();
}

function stopWatch_() {
  PropertiesService.getScriptProperties().deleteProperty('RUN_WATCH');
  deleteTriggers_('watchRun');
}

function readWatch_() {
  return JSON.parse(PropertiesService.getScriptProperties().getProperty('RUN_WATCH') || 'null');
}

function saveWatch_(watch) {
  PropertiesService.getScriptProperties().setProperty('RUN_WATCH', JSON.stringify(watch));
}

// Newest first, manual and scheduled runs alike.
function recentRuns_() {
  const res = githubFetch_('/actions/workflows/' + WORKFLOW_FILE + '/runs?per_page=5');
  if (res.getResponseCode() !== 200) throw githubError_(res);
  return JSON.parse(res.getContentText()).workflow_runs || [];
}

function createdAt_(run) {
  return new Date(run.created_at).getTime();
}

// Run status: Config row 8 for the Sheet, RUN_STATE (phase + times) for the dashboard.
// phase: idle | queued | running | success | failure | cancelled | error. The GitHub
// run link is kept in RUN_STATE for the owner, but not shown to MKT.
function setProgress_(text, url, tone, state) {
  PropertiesService.getScriptProperties().setProperty('RUN_STATE',
    JSON.stringify(Object.assign({ phase: 'idle' }, state, { url: url || ACTIONS_URL, at: Date.now() })));
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.config);
  if (!sh) return;
  sh.getRange(PROGRESS_ROW, 1, 1, 2).setValues([['Trạng thái', text]]);
  sh.getRange(PROGRESS_ROW, 2).setBackground(STATE_COLORS[tone] || STATE_COLORS.idle).setFontWeight('bold');
}

function hhmm_(date) {
  return Utilities.formatDate(date, 'Asia/Ho_Chi_Minh', 'HH:mm');
}

function setMessage_(msg) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.config);
  if (sh) sh.getRange(CELL.message).setValue(msg);
}

// ---------------------------------------------------------------- lịch tự chạy

function readSchedule_() {
  const raw = PropertiesService.getScriptProperties().getProperty('SCHEDULE');
  const s = raw ? JSON.parse(raw) : DEFAULT_SCHEDULE;
  return {
    enabled: s.enabled !== false,
    everyHours: SCHEDULE_HOURS.indexOf(Number(s.everyHours)) >= 0 ? Number(s.everyHours) : DEFAULT_SCHEDULE.everyHours,
    startHour: validHour_(s.startHour) ? Number(s.startHour) : DEFAULT_SCHEDULE.startHour,
  };
}

function validHour_(h) {
  const n = Number(h);
  return h !== '' && h !== null && n >= 0 && n <= 23 && Math.floor(n) === n;
}

function validSchedule_(input) {
  input = input || {};
  if (SCHEDULE_HOURS.indexOf(Number(input.everyHours)) < 0) throw new Error('Chu kỳ chạy không hợp lệ.');
  if (!validHour_(input.startHour)) throw new Error('Giờ bắt đầu không hợp lệ.');
  return { enabled: input.enabled !== false, everyHours: Number(input.everyHours), startHour: Number(input.startHour) };
}

function saveSchedule_(input) {
  const s = validSchedule_(input);
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SCHEDULE', JSON.stringify(s));
  // The new plan starts at its next time, not with a catch-up run right now.
  props.setProperty('AUTO_SLOT', String(slotAt_(s, Date.now(), false)));
  ensureScheduleTrigger_();
  showSchedule_();
  setMessage_('Lịch tự chạy: ' + scheduleText_(s) + ' (đổi lúc ' + hhmm_(new Date()) + ').');
  return s;
}

// Hours of the day (Việt Nam) with a run, e.g. every 3 h from 01:00 → [1, 4, 7, …, 22].
function slotHours_(s) {
  const hours = [];
  for (let h = s.startHour % s.everyHours; h < 24; h += s.everyHours) hours.push(h);
  return hours;
}

// Start (ms) of the latest run time at or before `now`, or (after = true) the first one after it.
function slotAt_(s, now, after) {
  const hours = slotHours_(s);
  const hour = Math.floor((now + VN_OFFSET_MS) / HOUR_MS); // whole hours since 1970, Việt Nam time
  for (let i = 0; i <= 24; i++) {
    const h = after ? hour + 1 + i : hour - i;
    if (hours.indexOf(h % 24) >= 0) return h * HOUR_MS - VN_OFFSET_MS;
  }
  return 0;
}

// When the next scheduled run should start: the current time if the trigger has not served it yet.
function nextRunAt_(s, now) {
  if (!s.enabled) return null;
  const slot = slotAt_(s, now, false);
  const served = Number(PropertiesService.getScriptProperties().getProperty('AUTO_SLOT') || 0);
  return slot > served && now - slot <= HOUR_MS ? slot : slotAt_(s, now, true);
}

function scheduleText_(s) {
  if (!s.enabled) return 'đang tắt';
  const hours = slotHours_(s).map(function (h) { return ('0' + h).slice(-2) + ':00'; });
  return 'mỗi ' + s.everyHours + ' giờ' + (hours.length <= 8 ? ' (' + hours.join(', ') + ')' : ', từ ' + hours[0]);
}

// Idempotent; also drops duplicates (several dashboards opened at once right after an update).
function ensureScheduleTrigger_() {
  const mine = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'autoRun'; });
  if (!mine.length) ScriptApp.newTrigger('autoRun').timeBased().everyMinutes(TICK_MINUTES).create();
  mine.slice(1).forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

// Time trigger (every TICK_MINUTES): starts each scheduled run once. If the
// previous run is still going, that time is skipped rather than queued.
function autoRun() {
  const s = readSchedule_();
  if (!s.enabled) return;
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  const slot = slotAt_(s, now, false);
  if (!slot || slot <= Number(props.getProperty('AUTO_SLOT') || 0)) return;
  props.setProperty('AUTO_SLOT', String(slot));
  if (now - slot > HOUR_MS) return; // trigger was off for a while: wait for the next time
  const at = hhmm_(new Date(slot));
  const r = tryRun_();
  if (r.ok) {
    setMessage_('Tự chạy theo lịch (lượt ' + at + ').');
  } else if (r.busy) {
    setMessage_('Bỏ qua lượt tự chạy ' + at + ' vì lần chạy trước chưa xong.');
  } else {
    const msg = 'Không tự chạy được lượt ' + at + ': ' + r.error;
    setMessage_(msg);
    setProgress_('✗ ' + msg, ACTIONS_URL, 'error', { phase: 'error', message: msg });
  }
}

// ---------------------------------------------------------------- dashboard

// Public (no code): what the dashboard shows. Reads properties only — no GitHub
// call — so viewers polling it cost nothing against the UrlFetch quota.
function statusPayload_() {
  const props = PropertiesService.getScriptProperties();
  const s = readSchedule_();
  const now = Date.now();
  return {
    ok: true,
    now: now,
    run: JSON.parse(props.getProperty('RUN_STATE') || '{"phase":"idle"}'),
    schedule: {
      enabled: s.enabled,
      everyHours: s.everyHours,
      startHour: s.startHour,
      hours: slotHours_(s),
      next: nextRunAt_(s, now),
    },
    everyHoursOptions: SCHEDULE_HOURS,
    config: { level: currentLevel_() },
    levelOptions: LEVEL_OPTIONS,
    ready: { github: !!props.getProperty('GITHUB_TOKEN'), code: !!props.getProperty('DASHBOARD_CODE') },
  };
}

// Config!B6, the level the next run uses.
function currentLevel_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.config);
  return sh ? String(sh.getRange('B6').getValue()) : '';
}

function handleControl_(req) {
  const denied = checkCode_(req.code);
  if (denied) return { ok: false, error: denied.error, message: denied.message };
  if (req.action === 'run') {
    const r = tryRun_();
    if (r.ok) setMessage_(sentMessage_(' từ dashboard'));
    return {
      ok: !!r.ok,
      error: r.ok ? null : r.busy ? 'busy' : 'dispatch',
      message: r.ok ? 'Đã gửi yêu cầu chạy.'
        : r.busy ? 'Đang có một lần chạy — đợi xong rồi hãy bấm lại.'
          : 'Không gửi được yêu cầu chạy: ' + r.error,
      status: statusPayload_(),
    };
  }
  // "settings": level and/or schedule ("schedule" from older dashboards). All is
  // checked before anything is saved; only what changed is saved.
  let schedule = null;
  let level = null;
  try {
    if (req.schedule) {
      schedule = validSchedule_(req.schedule);
      if (JSON.stringify(schedule) === JSON.stringify(readSchedule_())) schedule = null;
    }
    if (req.level !== undefined && req.level !== null && req.level !== '') {
      if (LEVEL_OPTIONS.indexOf(String(req.level)) < 0) throw new Error('Mức kiểm tra không hợp lệ.');
      if (String(req.level) !== currentLevel_()) level = String(req.level);
    }
  } catch (err) {
    return { ok: false, error: 'invalid', message: err.message };
  }
  if (schedule) saveSchedule_(schedule);
  if (level) {
    // Same as editing B6 in the Sheet: one run with the new level in about a minute.
    SpreadsheetApp.getActive().getSheetByName(SHEET.config).getRange('B6').setValue(level);
    scheduleRun_();
    setMessage_('Mức kiểm tra đổi thành "' + level + '" từ dashboard lúc ' + hhmm_(new Date()) +
      ' — sẽ tự chạy lại sau khoảng 1–2 phút.');
  }
  const message = level ? 'Đã lưu. Sẽ tự chạy lại với mức kiểm tra mới sau khoảng 1–2 phút.'
    : schedule ? 'Đã lưu lịch tự chạy.' : 'Không có gì thay đổi.';
  return { ok: true, message: message, status: statusPayload_() };
}

// The checker calls "load" when a run starts. A run not started from the
// Sheet/dashboard (e.g. "Run workflow" on GitHub) is picked up here, so its
// status shows too.
function noteRunStarted_() {
  if (readWatch_() || !PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN')) return;
  const now = Date.now();
  saveWatch_({ since: now - 10 * 60 * 1000 });
  setProgress_('⏳ Đang chạy…', ACTIONS_URL, 'busy', { phase: 'running', startedAt: now });
  ensureWatchTrigger_();
}

// ---------------------------------------------------------------- web app (bridge)

function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'status') {
    try {
      ensureScheduleTrigger_(); // first dashboard visit after an update turns the schedule on
    } catch (err) {
      // status is still worth returning
    }
    return json_(statusPayload_());
  }
  return json_({ ok: true, service: 'iptv-monitor' });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (req.action === 'run' || req.action === 'schedule' || req.action === 'settings') return json_(handleControl_(req));
    const expected = String(PropertiesService.getScriptProperties().getProperty('BRIDGE_TOKEN') || '').trim();
    const given = String(req.token || '').trim();
    if (!expected) {
      return json_({ ok: false, error: 'unauthorized: Apps Script ở link này chưa có bridge token — link trong ' +
        'SHEET_BRIDGE_URL không thuộc Sheet đang dùng, hoặc chưa chạy "Cài đặt ban đầu"' });
    }
    if (given !== expected) {
      return json_({ ok: false, error: 'unauthorized: Sheet ở link này chờ token mã ' + tokenCode_(expected) +
        ', nhưng nhận được ' + (given ? 'token mã ' + tokenCode_(given) + ' dài ' + given.length + ' ký tự' : 'token rỗng') });
    }
    if (req.action === 'load') return json_(handleLoad_());
    if (req.action === 'save') {
      const lock = LockService.getScriptLock();
      lock.waitLock(30000);
      try {
        return json_(handleSave_(req));
      } finally {
        lock.releaseLock();
      }
    }
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function handleLoad_() {
  const ss = SpreadsheetApp.getActive();
  const cfg = ss.getSheetByName(SHEET.config);
  if (!cfg) throw new Error('chưa có sheet Config — chạy menu IPTV Monitor → Quản trị → Cài đặt ban đầu');
  const v = cfg.getRange(INPUT_FIRST_ROW, 2, INPUT_LAST_ROW - INPUT_FIRST_ROW + 1, 1).getDisplayValues()
    .map(function (r) { return r[0]; });

  const ex = ss.getSheetByName(SHEET.exclude);
  const exclude = ex && ex.getLastRow() > 1
    ? ex.getRange(2, 1, ex.getLastRow() - 1, 1).getDisplayValues()
      .map(function (r) { return String(r[0]).trim(); }).filter(String)
    : [];

  const dataSheet = ss.getSheetByName(SHEET.data);
  let data = null;
  if (dataSheet && dataSheet.getLastRow() > 1) {
    const values = dataSheet.getDataRange().getValues();
    data = { header: values[0], rows: values.slice(1) };
  }
  const lastRun = JSON.parse(PropertiesService.getScriptProperties().getProperty('LAST_RUN') || '{}');
  try {
    ensureScheduleTrigger_();
    noteRunStarted_();
  } catch (err) {
    // status tracking must never block a run
  }
  return {
    ok: true,
    config: { countries: v[0], languages: v[1], categories: v[2], level: v[3] },
    exclude: exclude,
    data: data,
    lastRun: lastRun,
  };
}

function handleSave_(req) {
  const ss = SpreadsheetApp.getActive();
  const dataSheet = ss.getSheetByName(SHEET.data) || ss.insertSheet(SHEET.data);
  const streamsSheet = ss.getSheetByName(SHEET.streams) || ss.insertSheet(SHEET.streams);
  writeTable_(dataSheet, req.data.header, req.data.rows, {});
  writeTable_(streamsSheet, req.streams.header, req.streams.rows, { dateColumn: req.streams.dateColumn, keepFilter: true });
  writeSummary_(ss, req.summary);
  if (req.exclude) writeExcludeReport_(ss, req.exclude);
  PropertiesService.getScriptProperties().setProperty('LAST_RUN', JSON.stringify({
    sourceCount: req.summary.sourceCount,
    configHash: req.summary.configHash,
  }));
  SpreadsheetApp.flush();
  return { ok: true, rows: req.data.rows.length };
}

// Exclude!C: next to each line, what it removed in this run ("2 link: ANTV, …").
function writeExcludeReport_(ss, report) {
  const sh = ss.getSheetByName(SHEET.exclude);
  if (!sh || sh.getLastRow() < 2) return;
  const byEntry = {};
  report.forEach(function (r) { byEntry[String(r.entry)] = String(r.text); });
  const n = sh.getLastRow() - 1;
  const values = sh.getRange(2, 1, n, 1).getDisplayValues().map(function (row) {
    const entry = String(row[0]).trim();
    return [entry && byEntry[entry] !== undefined ? cell_(byEntry[entry], false) : ''];
  });
  sh.getRange(2, 3, n, 1).setValues(values);
}

// Whole table in one setValues; keeps the MKT filter criteria on Streams.
function writeTable_(sh, header, rows, opts) {
  const width = header.length;
  const height = rows.length + 1;
  const criteria = {};
  const filter = opts.keepFilter ? sh.getFilter() : null;
  if (filter) {
    for (let c = 1; c <= width; c++) {
      const cr = filter.getColumnFilterCriteria(c);
      if (cr) criteria[c] = cr;
    }
    filter.remove();
  }
  if (sh.getMaxRows() < height + 1) sh.insertRowsAfter(sh.getMaxRows(), height + 1 - sh.getMaxRows());
  if (sh.getMaxColumns() < width) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
  sh.getRange(1, 1, sh.getMaxRows(), Math.max(width, sh.getLastColumn(), 1)).clearContent();

  const values = [header.map(function (h) { return cell_(h, false); })].concat(rows.map(function (row) {
    return header.map(function (_, i) { return cell_(row[i], i === opts.dateColumn); });
  }));
  sh.getRange(1, 1, height, width).setValues(values);
  if (opts.dateColumn !== undefined && rows.length) {
    sh.getRange(2, opts.dateColumn + 1, rows.length, 1).setNumberFormat('dd/MM/yyyy HH:mm');
  }
  if (sh.getMaxRows() > height + 1) sh.deleteRows(height + 2, sh.getMaxRows() - height - 1);
  if (opts.keepFilter) {
    const f = sh.getRange(1, 1, Math.max(height, 2), width).createFilter();
    Object.keys(criteria).forEach(function (c) { f.setColumnFilterCriteria(Number(c), criteria[c]); });
  }
}

function writeSummary_(ss, s) {
  const sh = ss.getSheetByName(SHEET.config);
  if (!sh) return;
  const lines = [['Thời điểm', new Date(s.runAt)]].concat(s.lines || []);
  const values = lines.map(function (l) {
    return [cell_(l[0], false), l[1] instanceof Date ? l[1] : cell_(l[1], false)];
  });
  sh.getRange(SUMMARY_ROW, 1, 20, 2).clearContent();
  sh.getRange(SUMMARY_ROW, 1, values.length, 2).setValues(values);
  sh.getRange(SUMMARY_ROW, 2).setNumberFormat('dd/MM/yyyy HH:mm');
}

// Text that starts like a formula is stored as plain text.
function cell_(v, isDate) {
  if (v === null || v === undefined) return '';
  if (isDate) return typeof v === 'number' && v > 0 ? new Date(v) : '';
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function alert_(msg) {
  try {
    SpreadsheetApp.getUi().alert(msg);
  } catch (err) {
    Logger.log(msg); // run from the editor: no UI
  }
}
