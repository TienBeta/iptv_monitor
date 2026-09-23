/**
 * IPTV Monitor — Apps Script gắn với Google Sheet.
 *
 * - Web app (doPost): GitHub Actions đọc cấu hình + trạng thái cũ ("load")
 *   và ghi kết quả ("save"). Mọi request phải có đúng BRIDGE_TOKEN.
 * - Ô tick "Chạy ngay" trong Config, hoặc menu IPTV Monitor → Chạy ngay:
 *   gọi GitHub API để chạy workflow ngay.
 * - Sửa Config / Exclude: tự hẹn chạy lại sau khoảng 1 phút.
 *
 * Cài đặt từng bước: docs/setup.md trong repo.
 */

const GITHUB_REPO = 'TienBeta/iptv_monitor';
const WORKFLOW_FILE = 'check.yml';
const GITHUB_REF = 'main';

const SHEET = { config: 'Config', exclude: 'Exclude', streams: 'Streams', data: '_data' };
const CELL = { runNow: 'B7', message: 'C7' };
const INPUT_FIRST_ROW = 3; // B3:B6 = Quốc gia, Ngôn ngữ, Thể loại, Mức kiểm tra
const INPUT_LAST_ROW = 6;
const SUMMARY_ROW = 10;
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

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('IPTV Monitor')
    .addItem('Chạy ngay', 'runNow')
    .addSeparator()
    .addItem('Cài đặt ban đầu', 'setup')
    .addItem('Nhập GitHub token', 'setGithubToken')
    .addItem('Xem bridge token', 'showBridgeToken')
    .addToUi();
}

function runNow() {
  const msg = dispatchSafe_();
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
  ui.alert('Đã lưu GitHub token. Thử tick ô "Chạy ngay" trong sheet Config.');
}

function showBridgeToken() {
  const token = PropertiesService.getScriptProperties().getProperty('BRIDGE_TOKEN');
  alert_(token
    ? 'Bridge token (dán vào GitHub secret SHEET_BRIDGE_TOKEN):\n\n' + token
    : 'Chưa có token — chạy menu IPTV Monitor → Cài đặt ban đầu.');
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
  installEditTrigger_(ss);
  ss.setActiveSheet(ss.getSheetByName(SHEET.config));

  alert_('Cài đặt xong.\n\nBridge token (dán vào GitHub secret SHEET_BRIDGE_TOKEN):\n\n' +
    props.getProperty('BRIDGE_TOKEN') +
    '\n\nBước tiếp theo: Deploy → New deployment → Web app (xem docs/setup.md).');
}

function setupConfigSheet_(ss) {
  const sh = ss.getSheetByName(SHEET.config) || ss.insertSheet(SHEET.config, 0);
  if (sh.getRange('A3').getValue() !== 'Quốc gia') {
    sh.getRange('A1:C7').setValues([
      ['IPTV MONITOR — CẤU HÌNH', '', ''],
      ['Mục', 'Giá trị', 'Hướng dẫn'],
      ['Quốc gia', 'VN', 'Mã 2 chữ cái, cách nhau dấu phẩy. VD: VN, TH. Để trống = tất cả quốc gia'],
      ['Ngôn ngữ', '', 'Mã 3 chữ cái. VD: vie, eng. Để trống = không lọc'],
      ['Thể loại', '', 'VD: news, sports, movies, kids, music. Để trống = không lọc'],
      ['Mức kiểm tra', LEVEL_OPTIONS[2], 'Mức càng cao càng chắc chắn nhưng chạy lâu hơn'],
      ['Chạy ngay', false, 'Tick vào ô bên trái để chạy kiểm tra ngay'],
    ]);
    sh.getRange('A9').setValue('LẦN CHẠY GẦN NHẤT');
  }
  sh.getRange('B6').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(LEVEL_OPTIONS, true).setAllowInvalid(false).build());
  sh.getRange(CELL.runNow).insertCheckboxes();
  sh.getRange('A1').setFontWeight('bold').setFontSize(13);
  sh.getRange('A2:C2').setFontWeight('bold').setBackground('#f1f3f4');
  sh.getRange('A9').setFontWeight('bold');
  sh.getRange('B3:B6').setBackground('#fff8e1');
  sh.setColumnWidth(1, 170);
  sh.setColumnWidth(2, 260);
  sh.setColumnWidth(3, 460);
  if (!sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).length) {
    // Warnings only: MKT edits column B, labels and the run summary stay intact.
    sh.getRange('A1:A30').protect().setDescription('Nhãn cấu hình').setWarningOnly(true);
    sh.getRange('B10:B30').protect().setDescription('Kết quả lần chạy (script tự ghi)').setWarningOnly(true);
  }
}

function setupExcludeSheet_(ss) {
  const sh = ss.getSheetByName(SHEET.exclude) || ss.insertSheet(SHEET.exclude);
  if (sh.getRange('A1').getValue() === '') sh.getRange('A1:B1').setValues([['Link cần bỏ qua', 'Ghi chú']]);
  sh.getRange('A1:B1').setFontWeight('bold').setBackground('#f1f3f4');
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 520);
  sh.setColumnWidth(2, 300);
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
    const box = sh.getRange(CELL.runNow);
    if (range.getNumRows() === 1 && range.getNumColumns() === 1 &&
        range.getRow() === box.getRow() && range.getColumn() === box.getColumn()) {
      if (box.getValue() === true) {
        box.setValue(false);
        setMessage_(dispatchSafe_());
      }
      return;
    }
    const touchesInputs = range.getColumn() <= 2 && range.getLastColumn() >= 2 &&
      range.getRow() <= INPUT_LAST_ROW && range.getLastRow() >= INPUT_FIRST_ROW;
    if (touchesInputs) {
      scheduleRun_();
      setMessage_('Cấu hình vừa thay đổi — sẽ tự chạy lại sau khoảng 1–2 phút.');
    }
    return;
  }
  if (name === SHEET.exclude) {
    scheduleRun_();
    setMessage_('Danh sách loại trừ vừa thay đổi — sẽ tự chạy lại sau khoảng 1–2 phút.');
  }
}

// Many edits in a row → one run: each edit replaces the pending trigger.
function scheduleRun_() {
  deleteTriggers_('scheduledRun');
  ScriptApp.newTrigger('scheduledRun').timeBased().after(60 * 1000).create();
}

function scheduledRun() {
  deleteTriggers_('scheduledRun');
  setMessage_(dispatchSafe_());
}

function deleteTriggers_(handler) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
  });
}

function dispatchSafe_() {
  try {
    dispatchWorkflow_();
    return 'Đã gửi yêu cầu chạy lúc ' + Utilities.formatDate(new Date(), 'Asia/Ho_Chi_Minh', 'HH:mm dd/MM/yyyy') +
      '. Kết quả có sau vài phút.';
  } catch (err) {
    return 'Không gửi được yêu cầu chạy: ' + err.message;
  }
}

function dispatchWorkflow_() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('chưa nhập GitHub token (menu IPTV Monitor → Nhập GitHub token).');
  const url = 'https://api.github.com/repos/' + GITHUB_REPO + '/actions/workflows/' + WORKFLOW_FILE + '/dispatches';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    payload: JSON.stringify({ ref: GITHUB_REF }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code === 204) return;
  if (code === 401) throw new Error('GitHub token sai hoặc đã hết hạn — tạo token mới và nhập lại.');
  if (code === 403) throw new Error('GitHub token thiếu quyền "Actions: Read and write".');
  if (code === 404) throw new Error('không tìm thấy workflow ' + WORKFLOW_FILE + ' trên nhánh ' + GITHUB_REF + '.');
  throw new Error('GitHub trả về ' + code + ': ' + res.getContentText().slice(0, 200));
}

function setMessage_(msg) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.config);
  if (sh) sh.getRange(CELL.message).setValue(msg);
}

// ---------------------------------------------------------------- web app (bridge)

function doGet() {
  return json_({ ok: true, service: 'iptv-monitor' });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const expected = PropertiesService.getScriptProperties().getProperty('BRIDGE_TOKEN');
    if (!expected || req.token !== expected) return json_({ ok: false, error: 'unauthorized' });
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
  if (!cfg) throw new Error('chưa có sheet Config — chạy menu IPTV Monitor → Cài đặt ban đầu');
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
  PropertiesService.getScriptProperties().setProperty('LAST_RUN', JSON.stringify({
    sourceCount: req.summary.sourceCount,
    configHash: req.summary.configHash,
  }));
  SpreadsheetApp.flush();
  return { ok: true, rows: req.data.rows.length };
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
