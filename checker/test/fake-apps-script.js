// A small in-memory stand-in for the Apps Script services Code.gs uses, so the
// real Code.gs runs under Node. It checks the same things Sheets would reject
// (setValues size mismatch, writing outside the sheet) and mimics Sheets'
// quote-prefix handling. It is not a full emulator.

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';

const colToNum = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

class FakeProtection {
  constructor(type, sheet) { this.type = type; this.sheet = sheet; this.warningOnly = false; }
  remove() { this.sheet.protections = this.sheet.protections.filter((p) => p !== this); }
  setDescription(d) { this.description = d; return this; }
  getDescription() { return this.description || ''; }
  setWarningOnly(w) { this.warningOnly = w; return this; }
  addEditor() { return this; }
  removeEditors() { return this; }
  getEditors() { return []; }
  canDomainEdit() { return false; }
  setDomainEdit() { return this; }
}

class FakeFilter {
  constructor(sheet, range) { this.sheet = sheet; this.range = range; this.criteria = {}; }
  getRange() { return this.range; }
  getColumnFilterCriteria(c) {
    if (c < this.range.col || c > this.range.getLastColumn()) throw new Error(`cột ${c} nằm ngoài vùng lọc`); // Code.gs must only ask inside the filter
    return this.criteria[c] || null;
  }
  setColumnFilterCriteria(c, cr) { this.criteria[c] = cr; return this; }
  remove() { this.sheet.filter = null; }
}

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getSheet() { return this.sheet; }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getLastRow() { return this.row + this.numRows - 1; }
  getLastColumn() { return this.col + this.numCols - 1; }
  getNumRows() { return this.numRows; }
  getNumColumns() { return this.numCols; }
  getA1Notation() { return `${String.fromCharCode(64 + this.col)}${this.row}`; }
  getValues() {
    return Array.from({ length: this.numRows }, (_, i) =>
      Array.from({ length: this.numCols }, (_, j) => this.sheet.get(this.row + i, this.col + j)));
  }
  getDisplayValues() {
    return this.getValues().map((r) => r.map((v) => (v instanceof this.sheet.ctx.Date ? v.toISOString() : String(v))));
  }
  getValue() { return this.sheet.get(this.row, this.col); }
  setValue(v) { this.sheet.set(this.row, this.col, v); return this; }
  setValues(values) {
    if (values.length !== this.numRows || values.some((r) => r.length !== this.numCols)) {
      throw new Error(`setValues: data ${values.length}x${values[0]?.length} ≠ range ${this.numRows}x${this.numCols}`);
    }
    values.forEach((r, i) => r.forEach((v, j) => this.sheet.set(this.row + i, this.col + j, v)));
    return this;
  }
  clearContent() {
    for (let i = 0; i < this.numRows; i++) for (let j = 0; j < this.numCols; j++) this.sheet.clear(this.row + i, this.col + j);
    return this;
  }
  setNumberFormat(f) { this.sheet.formats.push({ row: this.row, col: this.col, numRows: this.numRows, format: f }); return this; }
  setDataValidation(v) { this.sheet.validation = v; return this; }
  setRichTextValue(v) { this.setValue(v.text); this.sheet.links[`${this.row},${this.col}`] = v.url; return this; }
  insertCheckboxes() { if (this.getValue() === '') this.setValue(false); return this; }
  clearDataValidations() { this.sheet.validations = (this.sheet.validations || []).filter((v) => v !== this.getA1Notation()); return this; }
  createFilter() { this.sheet.filter = new FakeFilter(this.sheet, this); return this.sheet.filter; }
  protect() { const p = new FakeProtection('RANGE', this.sheet); this.sheet.protections.push(p); return p; }
  setFontWeight() { return this; }
  setFontColor() { return this; }
  setFontSize() { return this; }
  setBackground(c) { this.sheet.backgrounds[`${this.row},${this.col}`] = c; return this; }
}

class FakeSheet {
  constructor(name, ctx) {
    Object.assign(this, { name, ctx, cells: [], maxRows: 1000, maxCols: 26, hidden: false, filter: null, protections: [], formats: [], links: {}, backgrounds: {}, plainText: new Set() });
  }
  getName() { return this.name; }
  get(r, c) { const v = this.cells[r - 1]?.[c - 1]; return v === undefined ? '' : v; }
  set(r, c, v) {
    if (r < 1 || c < 1 || r > this.maxRows || c > this.maxCols) throw new Error(`${this.name}: ô (${r},${c}) nằm ngoài sheet ${this.maxRows}x${this.maxCols}`);
    // Sheets stores a leading apostrophe as "plain text" and hides it.
    const quoted = typeof v === 'string' && v.startsWith("'");
    if (quoted) this.plainText.add(`${r},${c}`); else this.plainText.delete(`${r},${c}`); // test helper
    (this.cells[r - 1] ||= [])[c - 1] = quoted ? v.slice(1) : v;
  }
  clear(r, c) { if (this.cells[r - 1]) this.cells[r - 1][c - 1] = ''; }
  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const m = /^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/.exec(a);
      const c1 = colToNum(m[1]);
      const r1 = m[2] ? Number(m[2]) : 1;
      if (!m[3]) return new FakeRange(this, r1, c1, 1, 1);
      const r2 = m[4] ? Number(m[4]) : this.maxRows;
      return new FakeRange(this, r1, c1, r2 - r1 + 1, colToNum(m[3]) - c1 + 1);
    }
    return new FakeRange(this, a, b, c ?? 1, d ?? 1);
  }
  getLastRow() {
    let last = 0;
    this.cells.forEach((row, i) => { if (row?.some((v) => v !== '' && v !== undefined)) last = i + 1; });
    return last;
  }
  getLastColumn() {
    let last = 0;
    this.cells.forEach((row) => row?.forEach((v, j) => { if (v !== '' && v !== undefined) last = Math.max(last, j + 1); }));
    return last;
  }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertRowsAfter(_after, n) { this.maxRows += n; return this; }
  insertColumnsAfter(_after, n) { this.maxCols += n; return this; }
  deleteRows(start, n) {
    if (start + n - 1 > this.maxRows) throw new Error('deleteRows ngoài sheet');
    this.cells.splice(start - 1, n);
    this.maxRows -= n;
  }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  getFilter() { return this.filter; }
  getProtections(type) { return this.protections.filter((p) => !type || p.type === type); }
  protect() { const p = new FakeProtection('SHEET', this); this.protections.push(p); return p; }
  hideSheet() { this.hidden = true; return this; }
  setFrozenRows(n) { this.frozenRows = n; return this; }
  setFrozenColumns(n) { this.frozenColumns = n; return this; }
  setColumnWidth(c, w) { (this.widths ||= {})[c] = w; return this; }
  setRowHeights(start, n, h) { this.rowHeights = { start, n, h }; return this; }
  setConditionalFormatRules(rules) { this.cfRules = rules; return this; }
  // test helper: values as plain rows
  rows() { return this.getDataRange().getValues(); }
}

class FakeSpreadsheet {
  constructor(ctx) { this.ctx = ctx; this.sheets = [new FakeSheet('Sheet1', ctx)]; this.toasts = []; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(name, index) {
    const s = new FakeSheet(name, this.ctx);
    if (index === undefined) this.sheets.push(s); else this.sheets.splice(index, 0, s);
    return s;
  }
  getSheets() { return [...this.sheets]; }
  deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
  setSpreadsheetTimeZone(tz) { this.tz = tz; }
  setActiveSheet() {}
  toast(msg) { this.toasts.push(msg); }
}

const chain = () => new Proxy({}, { get: (t, k) => (k === 'build' ? () => ({ built: true }) : () => chain()) });

export function loadAppsScript(file = new URL('../../apps-script/Code.gs', import.meta.url)) {
  const props = new Map();
  const triggers = [];
  const fetches = [];
  const logs = [];
  const sandbox = { console };
  const ctx = vm.createContext(sandbox);
  sandbox.Date = vm.runInContext('Date', ctx);
  const ss = new FakeSpreadsheet(sandbox);
  let fetchCode = 204;
  let runs = [];
  const dialogs = [];

  const trigger = (handler, kind) => {
    const t = { handler, kind, getHandlerFunction: () => handler };
    triggers.push(t);
    return t;
  };
  Object.assign(sandbox, {
    SpreadsheetApp: {
      getActive: () => ss,
      getActiveSpreadsheet: () => ss,
      getUi: () => {
        if (!sandbox.__ui) throw new Error('no UI in tests');
        return {
          alert: (a, b) => { dialogs.push(b === undefined ? { alert: a } : { title: a, alert: b }); return sandbox.__uiAnswer || 'OK'; },
          showModalDialog: (out, title) => {
            if (sandbox.__htmlDialogFails) throw new Error('Không mở được hộp thoại');
            dialogs.push({ title, html: out.html });
          },
          prompt: (title, text) => {
            dialogs.push({ prompt: title, text });
            const answer = sandbox.__prompt || { button: 'CANCEL', text: '' };
            return { getSelectedButton: () => answer.button, getResponseText: () => answer.text };
          },
          ButtonSet: { YES_NO: 'YES_NO', OK_CANCEL: 'OK_CANCEL' },
          Button: { YES: 'YES', NO: 'NO', OK: 'OK', CANCEL: 'CANCEL' },
        };
      },
      flush: () => {},
      newDataValidation: chain,
      newConditionalFormatRule: chain,
      newRichTextValue: () => {
        const v = {};
        const b = { setText: (t) => { v.text = t; return b; }, setLinkUrl: (u) => { v.url = u; return b; }, build: () => v };
        return b;
      },
      ProtectionType: { RANGE: 'RANGE', SHEET: 'SHEET' },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => {
          // Apps Script: 9 kB per value
          if (Buffer.byteLength(String(v), 'utf8') > 9 * 1024) throw new Error(`Property ${k} quá 9 kB`);
          props.set(k, String(v));
        },
        deleteProperty: (k) => props.delete(k),
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, tryLock: () => !sandbox.__lockBusy, releaseLock: () => {} }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => ({ content: s, setMimeType() { return this; }, getContent() { return s; } }),
    },
    UrlFetchApp: {
      fetch: (url, opts) => {
        fetches.push({ url, opts });
        if (opts.method === 'get') {
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ workflow_runs: runs }) };
        }
        return { getResponseCode: () => fetchCode, getContentText: () => '{"message":"x"}' };
      },
    },
    ScriptApp: {
      getProjectTriggers: () => [...triggers],
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/FAKE_ID/exec' }),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (handler) => ({
        timeBased: () => ({
          after: () => ({ create: () => trigger(handler, 'time') }),
          everyMinutes: (n) => ({ create: () => Object.assign(trigger(handler, 'every'), { minutes: n }) }),
        }),
        forSpreadsheet: () => ({ onEdit: () => ({ create: () => trigger(handler, 'edit') }) }),
      }),
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    HtmlService: {
      createHtmlOutput: (html) => ({ html, setWidth() { return this; }, setHeight() { return this; } }),
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      // Apps Script returns signed bytes (-128..127)
      computeDigest: (alg, value) => [...createHash(alg).update(String(value), 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
      getUuid: () => randomUUID(),
      formatDate: (d, _tz, fmt) => (fmt === 'HH:mm'
        ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(d))
        : new Date(d).toISOString()),
    },
    Logger: { log: (m) => logs.push(m) },
  });
  vm.runInContext(readFileSync(file, 'utf8'), ctx, { filename: 'Code.gs' });

  return {
    ctx: sandbox,
    ss,
    props,
    triggers,
    fetches,
    logs,
    setFetchCode: (c) => { fetchCode = c; },
    setRuns: (r) => { runs = r; },
    dialogs,
    withUi: () => { sandbox.__ui = true; },
    sheet: (name) => ss.getSheetByName(name),
    post: (body) => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(body) } }).getContent()),
    get: (parameter) => JSON.parse(sandbox.doGet({ parameter }).getContent()),
    edit: (sheetName, a1) => sandbox.onConfigEdit({ range: ss.getSheetByName(sheetName).getRange(a1) }),
  };
}

// An HTTP front for doPost that behaves like a deployed web app: the POST
// runs the script and answers 302; the redirect target serves the result.
export async function startWebApp(gas) {
  const results = new Map();
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const out = gas.ctx.doPost({ postData: { contents: body } }).getContent();
        const id = randomUUID();
        results.set(id, out);
        res.writeHead(302, { Location: `/echo?id=${id}` }).end();
      });
      return;
    }
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(results.get(id) || '{"ok":false}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/macros/s/fake/exec`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}
