/**
 * @OnlyCurrentDoc  Script chỉ được truy cập chính Google Sheet này, không đụng tới file khác trong Drive.
 *
 * IPTV Monitor — Apps Script gắn với Google Sheet.
 *
 * - Cấu hình (phạm vi, mức kiểm tra, danh sách bỏ qua, lịch) nằm trong Script
 *   Properties và chỉ sửa trên dashboard; sheet Config chỉ để xem.
 * - Web app (doPost): GitHub Actions đọc cấu hình + trạng thái cũ ("load")
 *   và ghi kết quả ("save"). Mọi request phải có đúng BRIDGE_TOKEN.
 * - Menu IPTV Monitor → Chạy ngay (hoặc nút trên dashboard): gọi GitHub API
 *   để chạy workflow ngay.
 * - Lịch tự chạy: trigger autoRun (mỗi 10 phút) chạy workflow đúng các giờ đã hẹn.
 * - Dashboard: xem trạng thái + cấu hình (doGet ?action=status, ai cũng xem được);
 *   "Chạy ngay" và đổi cấu hình (doPost run / settings) cần mã thao tác. Đổi
 *   phạm vi / mức / danh sách bỏ qua → tự chạy lại sau khoảng 1 phút.
 *
 * Cài đặt từng bước: docs/setup.md trong repo.
 */

const GITHUB_REPO = 'TienBeta/iptv_monitor';
const WORKFLOW_FILE = 'check.yml';
const GITHUB_REF = 'main';

// "Exclude" only exists in Sheets set up before settings moved to the dashboard.
const SHEET = { config: 'Config', streams: 'Streams', data: '_data', oldExclude: 'Exclude' };
// Config is a read-only view the script writes: B2 cấu hình hiện tại · B3 lịch tự
// chạy · B4 trạng thái · B5 thông báo · A7 "LẦN CHẠY GẦN NHẤT" · summary from row 8.
const CELL = { config: 'B2', schedule: 'B3', message: 'B5' };
const PROGRESS_ROW = 4;
const SUMMARY_HEADER_ROW = 7;
const STATE_COLORS = { busy: '#fff4cc', ok: '#d9f2e3', error: '#f8d4d4', idle: '#ffffff' };
const JUST_SENT_MS = 2 * 60 * 1000; // after a dispatch, GitHub may take a few seconds to list the run
const SUMMARY_ROW = 8;
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
const DEFAULT_CONFIG = { countries: ['VN'], languages: [], categories: [], level: LEVEL_OPTIONS[2] };
const EXCLUDE_MAX = 300; // lines
const EXCLUDE_TEXT_MAX = 200; // characters per line / note
const SCOPE_MAX = 300; // codes per list
const CHUNK_CHARS = 2500; // Script Properties hold 9 kB per value; 2,500 characters fit even at 3 bytes each
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
  migrateSheetConfig_(); // before the Config sheet is laid out again
  setupConfigSheet_(ss);
  setupStreamsSheet_(ss);
  setupDataSheet_(ss);
  removeEmptyDefaultSheet_(ss);

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('BRIDGE_TOKEN')) props.setProperty('BRIDGE_TOKEN', newToken_());
  if (!props.getProperty('DASHBOARD_CODE')) saveNewCode_();
  deleteTriggers_('onConfigEdit'); // settings are no longer edited in the Sheet
  ensureScheduleTrigger_();
  showConfig_();
  ss.setActiveSheet(ss.getSheetByName(SHEET.config));

  alert_('Cài đặt xong.\n\nBridge token (dán vào GitHub secret SHEET_BRIDGE_TOKEN):\n\n' +
    props.getProperty('BRIDGE_TOKEN') +
    '\n\nMã thao tác dashboard (Chạy ngay / đổi cấu hình): ' + props.getProperty('DASHBOARD_CODE') +
    ' (tự đặt mã khác: menu IPTV Monitor → Quản trị → Đặt / đổi mã thao tác dashboard)' +
    '\nCấu hình (sửa trên dashboard, nút "Cài đặt"): ' + configText_() +
    '\nLịch tự chạy: ' + scheduleText_(readSchedule_()) +
    '\n\nBước tiếp theo: Deploy → New deployment → Web app (xem docs/setup.md).');
}

function setupConfigSheet_(ss) {
  const sh = ss.getSheetByName(SHEET.config) || ss.insertSheet(SHEET.config, 0);
  if (sh.getRange('A2').getValue() !== 'Cấu hình' || sh.getRange('A' + PROGRESS_ROW).getValue() !== 'Trạng thái') {
    layoutConfigSheet_(sh, '');
  }
  if (sh.getRange(PROGRESS_ROW, 2).getValue() === '') setProgress_('Sẵn sàng', ACTIONS_URL, 'idle', { phase: 'idle' });
  sh.getRange('A1').setFontWeight('bold').setFontSize(13);
  sh.getRange('A' + SUMMARY_HEADER_ROW).setFontWeight('bold');
  sh.getRange('C2').setFontColor('#5f6368');
  sh.setColumnWidth(1, 170);
  sh.setColumnWidth(2, 520);
  sh.setColumnWidth(3, 260);
  if (!sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) {
    sh.protect().setDescription('Chỉ để xem — cấu hình sửa trên dashboard (nút "Cài đặt")').setWarningOnly(true);
  }
}

// The read-only layout. Also replaces the older ones (inputs in B3:B6, the run
// block below them), after migrateSheetConfig_() has copied the inputs.
function layoutConfigSheet_(sh, status) {
  const all = sh.getRange('A1:C40');
  all.clearContent();
  all.clearDataValidations(); // the old level dropdown / "Chạy ngay" checkbox
  all.setBackground(null);
  all.setFontWeight('normal');
  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) { p.remove(); }); // old range warnings
  sh.getRange('A1:C5').setValues([
    ['IPTV MONITOR', '', ''],
    ['Cấu hình', '', 'Sửa trên dashboard: nút "Cài đặt"'],
    ['Lịch tự chạy', '', ''],
    ['Trạng thái', status || '', ''],
    ['Thông báo', '', ''],
  ]);
  sh.getRange('A' + SUMMARY_HEADER_ROW).setValue('LẦN CHẠY GẦN NHẤT');
}

// B2 / B3: the settings in words (they are changed on the dashboard).
function showConfig_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.config);
  if (!sh) return;
  const s = readSchedule_();
  sh.getRange(CELL.config).setValue(configText_());
  sh.getRange(CELL.schedule).setValue(s.enabled
    ? 'Mỗi ' + scheduleText_(s).slice(4)
    : 'Đang tắt (chỉ chạy khi bấm Chạy ngay hoặc đổi cấu hình)');
}

function configText_() {
  const c = readConfig_();
  const list = function (label, values) { return label + ': ' + (values.length ? values.join(', ') : 'tất cả'); };
  const n = readExclude_().length;
  return [list('Quốc gia', c.countries), list('Ngôn ngữ', c.languages), list('Thể loại', c.categories),
    'Mức ' + c.level, 'Bỏ qua: ' + (n ? n + ' mục' : 'không')].join(' · ');
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

function newToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

// ---------------------------------------------------------------- run now / auto-run

// The installable edit trigger of older versions (settings were edited in the
// Sheet) may still exist until setup runs again: it only removes itself.
function onConfigEdit() {
  deleteTriggers_('onConfigEdit');
}

// Several saves in a row → one run: each save replaces the pending trigger.
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
  showConfig_();
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
    config: publicConfig_(),
    levelOptions: LEVEL_OPTIONS,
    ready: { github: !!props.getProperty('GITHUB_TOKEN'), code: !!props.getProperty('DASHBOARD_CODE') },
  };
}

// What the dashboard shows and edits (public, like the results).
function publicConfig_() {
  const c = readConfig_();
  const report = readBig_('EXCLUDE_REPORT', {});
  return {
    countries: c.countries,
    languages: c.languages,
    categories: c.categories,
    level: c.level,
    exclude: readExclude_().map(function (e) { return { entry: e.entry, note: e.note, report: report[e.entry] || '' }; }),
    rev: configRev_(),
  };
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
  // "settings" ("schedule" from older dashboards): scope, level, exclude list and
  // schedule, each optional. Refused if someone else saved since the page loaded
  // (rev). Everything is checked before anything is saved; only changes are saved.
  if (req.rev !== undefined && req.rev !== null && Number(req.rev) !== configRev_()) {
    return {
      ok: false, error: 'conflict', status: statusPayload_(),
      message: 'Cấu hình vừa được đổi ở nơi khác — đã tải lại cấu hình mới nhất, hãy xem và sửa lại.',
    };
  }
  const current = readConfig_();
  const changes = {};
  try {
    if (req.schedule) {
      const schedule = validSchedule_(req.schedule);
      if (JSON.stringify(schedule) !== JSON.stringify(readSchedule_())) changes.schedule = schedule;
    }
    if (req.level !== undefined && req.level !== null && req.level !== '') {
      if (LEVEL_OPTIONS.indexOf(String(req.level)) < 0) throw new Error('Mức kiểm tra không hợp lệ.');
      if (String(req.level) !== current.level) changes.level = String(req.level);
    }
    if (req.scope) {
      const scope = validScope_(req.scope);
      if (JSON.stringify(scope) !== JSON.stringify(
        { countries: current.countries, languages: current.languages, categories: current.categories })) changes.scope = scope;
    }
    if (req.exclude) {
      const exclude = validExclude_(req.exclude);
      if (JSON.stringify(exclude) !== JSON.stringify(readExclude_())) changes.exclude = exclude;
    }
  } catch (err) {
    return { ok: false, error: 'invalid', message: err.message };
  }
  const what = [];
  if (changes.scope) what.push('phạm vi');
  if (changes.level) what.push('mức kiểm tra');
  if (changes.exclude) what.push('danh sách bỏ qua');
  if (changes.schedule) what.push('lịch tự chạy');
  if (!what.length) return { ok: true, message: 'Không có gì thay đổi.', status: statusPayload_() };

  if (changes.schedule) saveSchedule_(changes.schedule);
  if (changes.scope || changes.level) {
    const next = Object.assign({}, current, changes.scope || {}, changes.level ? { level: changes.level } : {});
    PropertiesService.getScriptProperties().setProperty('CONFIG', JSON.stringify(next));
  }
  if (changes.exclude) writeBig_('EXCLUDE', changes.exclude);
  bumpConfigRev_();
  showConfig_();
  const rerun = !!(changes.scope || changes.level || changes.exclude);
  if (rerun) scheduleRun_(); // one run with the new settings in about a minute
  if (rerun) { // (a schedule-only change keeps saveSchedule_'s message, which lists the new times)
    setMessage_('Cấu hình đổi từ dashboard lúc ' + hhmm_(new Date()) + ' (' + what.join(', ') + ')' +
      ' — sẽ tự chạy lại sau khoảng 1–2 phút.');
  }
  return {
    ok: true,
    message: 'Đã lưu ' + what.join(', ') + '.' + (rerun ? ' Sẽ tự chạy lại sau khoảng 1–2 phút.' : ''),
    status: statusPayload_(),
  };
}

function validScope_(scope) {
  const list = function (values, re, fix, label) {
    if (values === undefined || values === null) return [];
    if (!Array.isArray(values)) throw new Error(label + ' không hợp lệ.');
    const out = [];
    values.forEach(function (v) {
      const code = fix(String(v).trim());
      if (!re.test(code)) throw new Error(label + ' không hợp lệ: ' + String(v).slice(0, 40));
      if (out.indexOf(code) < 0) out.push(code);
    });
    if (out.length > SCOPE_MAX) throw new Error(label + ': tối đa ' + SCOPE_MAX + ' mục.');
    return out;
  };
  const upper = function (v) { return v.toUpperCase() === 'GB' ? 'UK' : v.toUpperCase(); }; // iptv-org says UK
  const lower = function (v) { return v.toLowerCase(); };
  return {
    countries: list(scope.countries, /^[A-Z]{2}$/, upper, 'Mã quốc gia'),
    languages: list(scope.languages, /^[a-z]{3}$/, lower, 'Mã ngôn ngữ'),
    categories: list(scope.categories, /^[a-z][a-z0-9-]{1,30}$/, lower, 'Thể loại'),
  };
}

function validExclude_(lines) {
  if (!Array.isArray(lines)) throw new Error('Danh sách bỏ qua không hợp lệ.');
  const out = [];
  const seen = {};
  lines.forEach(function (line) {
    const entry = String((line && line.entry) || '').trim();
    const note = String((line && line.note) || '').trim();
    if (!entry || seen[entry]) return;
    if (entry.length > EXCLUDE_TEXT_MAX || note.length > EXCLUDE_TEXT_MAX) {
      throw new Error('Mỗi mục bỏ qua / ghi chú tối đa ' + EXCLUDE_TEXT_MAX + ' ký tự.');
    }
    seen[entry] = true;
    out.push({ entry: entry, note: note });
  });
  if (out.length > EXCLUDE_MAX) throw new Error('Danh sách bỏ qua tối đa ' + EXCLUDE_MAX + ' mục.');
  return out;
}

// ---------------------------------------------------------------- settings storage

// Settings live in Script Properties. The exclude list and its report can pass
// the 9 kB-per-value limit, so they are stored in chunks (KEY_N, KEY_0, KEY_1…).
function writeBig_(key, value) {
  const props = PropertiesService.getScriptProperties();
  const text = JSON.stringify(value);
  const old = Number(props.getProperty(key + '_N') || 0);
  const n = Math.max(1, Math.ceil(text.length / CHUNK_CHARS));
  for (let i = 0; i < n; i++) props.setProperty(key + '_' + i, text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS));
  props.setProperty(key + '_N', String(n));
  for (let i = n; i < old; i++) props.deleteProperty(key + '_' + i);
}

function readBig_(key, fallback) {
  const props = PropertiesService.getScriptProperties();
  const n = Number(props.getProperty(key + '_N') || 0);
  if (!n) return fallback;
  let text = '';
  for (let i = 0; i < n; i++) text += props.getProperty(key + '_' + i) || '';
  try {
    return JSON.parse(text);
  } catch (err) {
    return fallback;
  }
}

function readConfig_() {
  migrateSheetConfig_();
  const c = JSON.parse(PropertiesService.getScriptProperties().getProperty('CONFIG') || 'null') || DEFAULT_CONFIG;
  return {
    countries: c.countries || [],
    languages: c.languages || [],
    categories: c.categories || [],
    level: LEVEL_OPTIONS.indexOf(c.level) >= 0 ? c.level : DEFAULT_CONFIG.level,
  };
}

// [{ entry, note }]
function readExclude_() {
  migrateSheetConfig_();
  return readBig_('EXCLUDE', []);
}

function configRev_() {
  return Number(PropertiesService.getScriptProperties().getProperty('CONFIG_REV') || 0);
}

function bumpConfigRev_() {
  PropertiesService.getScriptProperties().setProperty('CONFIG_REV', String(configRev_() + 1));
}

// Once, after updating from a version that kept settings in the Sheet: copy
// Config!B3:B6 and the "Exclude" sheet (lines, notes, report) into Script
// Properties, delete "Exclude" and turn Config into the read-only view. Runs
// from setup, load or the dashboard status — whichever comes first.
function migrateSheetConfig_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('CONFIG')) return;
  const ss = SpreadsheetApp.getActive();
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const sh = ss.getSheetByName(SHEET.config);
  const old = sh && sh.getRange('A3').getValue() === 'Quốc gia';
  let status = '';
  if (old) {
    const v = sh.getRange('B3:B6').getDisplayValues().map(function (r) { return String(r[0]).trim(); });
    const split = function (text) { return text.split(/[\s,;]+/).filter(String); };
    config.countries = split(v[0]).map(function (x) { return x.toUpperCase() === 'GB' ? 'UK' : x.toUpperCase(); });
    config.languages = split(v[1]).map(function (x) { return x.toLowerCase(); });
    config.categories = split(v[2]).map(function (x) { return x.toLowerCase(); });
    if (LEVEL_OPTIONS.indexOf(v[3]) >= 0) config.level = v[3];
    if (sh.getRange('A8').getValue() === 'Trạng thái') status = String(sh.getRange('B8').getValue());
  }
  const exclude = [];
  const report = {};
  const ex = ss.getSheetByName(SHEET.oldExclude);
  if (ex && ex.getLastRow() > 1) {
    ex.getRange(2, 1, ex.getLastRow() - 1, 3).getDisplayValues().forEach(function (r) {
      const entry = String(r[0]).trim().slice(0, EXCLUDE_TEXT_MAX);
      if (!entry || exclude.some(function (e) { return e.entry === entry; })) return;
      exclude.push({ entry: entry, note: String(r[1]).trim().slice(0, EXCLUDE_TEXT_MAX) });
      if (String(r[2]).trim()) report[entry] = String(r[2]).trim();
    });
  }
  props.setProperty('CONFIG', JSON.stringify(config));
  writeBig_('EXCLUDE', exclude.slice(0, EXCLUDE_MAX));
  writeBig_('EXCLUDE_REPORT', report);
  props.setProperty('CONFIG_REV', '1');
  if (ex && ss.getSheets().length > 1) ss.deleteSheet(ex);
  if (old) {
    layoutConfigSheet_(sh, status);
    showConfig_();
  }
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
  if (!ss.getSheetByName(SHEET.config)) throw new Error('chưa có sheet Config — chạy menu IPTV Monitor → Quản trị → Cài đặt ban đầu');
  const c = readConfig_();
  const exclude = readExclude_().map(function (e) { return e.entry; });

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
    config: { countries: c.countries.join(', '), languages: c.languages.join(', '), categories: c.categories.join(', '), level: c.level },
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
  if (req.exclude) saveExcludeReport_(req.exclude);
  PropertiesService.getScriptProperties().setProperty('LAST_RUN', JSON.stringify({
    sourceCount: req.summary.sourceCount,
    configHash: req.summary.configHash,
  }));
  SpreadsheetApp.flush();
  return { ok: true, rows: req.data.rows.length };
}

// What each exclude line removed in this run ("2 link: An Ninh TV"), shown on the dashboard.
function saveExcludeReport_(report) {
  const byEntry = {};
  (report || []).forEach(function (r) { byEntry[String(r.entry)] = String(r.text); });
  writeBig_('EXCLUDE_REPORT', byEntry);
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
