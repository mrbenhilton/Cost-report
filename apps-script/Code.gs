/**
 * Project Cost Tracker — server-side code (Google Apps Script).
 *
 * This script is bound to a Google Sheet. All data lives in four tabs of
 * that sheet (Projects, Budget Lines, Transactions, Settings), so nothing
 * is ever lost between sessions — the spreadsheet IS the database.
 *
 * Columns are looked up by header name, so extra columns can be added to
 * a tab without breaking the app, and upgrades add any missing columns
 * automatically.
 */

var SHEET_PROJECTS = 'Projects';
var SHEET_LINES = 'Budget Lines';
var SHEET_TRANSACTIONS = 'Transactions';
var SHEET_SETTINGS = 'Settings';

var PROJECT_HEADERS = ['ID', 'Name', 'Client', 'Budget', 'Fee', 'Version', 'Notes', 'Created'];

/**
 * The Company Overheads project has a fixed ID so the app can recognise it.
 * Production fees from every project budget are treated as its income, and
 * company (non-project) expenses are recorded against it.
 */
var OVERHEADS_ID = 'company-overheads';
var LINE_HEADERS = ['ID', 'Project ID', 'Section', 'Item', 'Description', 'Qty', 'Rate', 'Amount', 'Order'];
// Amount is always the ex-VAT (net) figure — the one reconciled against
// budgets. Gross is what actually left the bank; VAT is the difference.
var TXN_HEADERS = [
  'Hash', 'Date', 'Description', 'Amount', 'Gross', 'VAT', 'Project ID',
  'Project Name', 'Line ID', 'Line Name', 'Category', 'Purpose', 'Statement', 'Recorded'
];
var SETTINGS_HEADERS = ['Key', 'Value'];

/** Serves the web app UI. */
function doGet() {
  var template = HtmlService.createTemplateFromFile('Index');
  template.spreadsheetUrl = ss_().getUrl();
  return template
    .evaluate()
    .setTitle('Project Cost Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * Returns {sheet, col} for the named sheet, creating it (or any missing
 * header columns, e.g. after an app upgrade) as needed. `col` maps header
 * name -> 0-based column index.
 */
function getSheet_(name, headers) {
  var ss = ss_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  var lastCol = Math.max(1, sheet.getLastColumn());
  var existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  var missing = headers.filter(function (h) { return existing.indexOf(h) === -1; });
  if (missing.length) {
    sheet.getRange(1, existing.length + 1, 1, missing.length)
      .setValues([missing]).setFontWeight('bold');
    existing = existing.concat(missing);
  }
  var col = {};
  existing.forEach(function (h, i) { if (h) col[h] = i; });
  return { sheet: sheet, col: col };
}

function readRows_(name, headers) {
  var s = getSheet_(name, headers);
  var values = s.sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    rows.push({ rowNumber: i + 1, values: values[i] });
  }
  return { sheet: s.sheet, col: s.col, rows: rows };
}

function rowArray_(col, headers, obj) {
  var width = 0;
  headers.forEach(function (h) { width = Math.max(width, col[h] + 1); });
  var arr = new Array(width).fill('');
  headers.forEach(function (h) { arr[col[h]] = obj[h]; });
  return arr;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** Everything the UI needs, in one call. */
function getAppData() {
  ensureOverheadsProject_();
  return {
    projects: listProjects_(),
    budgetLines: listLines_(),
    transactions: listTransactions_(),
    settings: getSettings_()
  };
}

// ---------------------------------------------------------------- Projects

function ensureOverheadsProject_() {
  var d = readRows_(SHEET_PROJECTS, PROJECT_HEADERS);
  for (var i = 0; i < d.rows.length; i++) {
    if (String(d.rows[i].values[d.col['ID']]) === OVERHEADS_ID) return;
  }
  d.sheet.appendRow(rowArray_(d.col, PROJECT_HEADERS, {
    'ID': OVERHEADS_ID, 'Name': 'Company Overheads', 'Client': '',
    'Budget': 0, 'Fee': 0, 'Version': '',
    'Notes': 'Funded by production fees; holds company (non-project) expenses.',
    'Created': new Date()
  }));
}

function listProjects_() {
  var d = readRows_(SHEET_PROJECTS, PROJECT_HEADERS);
  return d.rows.filter(function (r) { return r.values[d.col['ID']]; }).map(function (r) {
    var v = r.values;
    return {
      id: String(v[d.col['ID']]),
      name: String(v[d.col['Name']] || ''),
      client: String(v[d.col['Client']] || ''),
      budget: Number(v[d.col['Budget']]) || 0,
      fee: Number(v[d.col['Fee']]) || 0,
      version: String(v[d.col['Version']] || ''),
      notes: String(v[d.col['Notes']] || ''),
      created: formatDate_(v[d.col['Created']])
    };
  });
}

function listLines_() {
  var d = readRows_(SHEET_LINES, LINE_HEADERS);
  return d.rows.filter(function (r) { return r.values[d.col['ID']]; }).map(function (r) {
    var v = r.values;
    return {
      id: String(v[d.col['ID']]),
      projectId: String(v[d.col['Project ID']] || ''),
      section: String(v[d.col['Section']] || ''),
      item: String(v[d.col['Item']] || ''),
      description: String(v[d.col['Description']] || ''),
      qty: String(v[d.col['Qty']] || ''),
      rate: String(v[d.col['Rate']] || ''),
      amount: Number(v[d.col['Amount']]) || 0,
      order: Number(v[d.col['Order']]) || 0
    };
  }).sort(function (a, b) { return a.order - b.order; });
}

/**
 * Creates a project together with its budget lines (from an uploaded
 * budget). meta: {name, client, budget, fee, version, notes};
 * lines: [{section, item, description, qty, rate, amount}]
 */
function saveProjectWithBudget(meta, lines) {
  return withLock_(function () {
    var name = String(meta.name || '').trim();
    if (!name) throw new Error('Project name is required.');
    var p = getSheet_(SHEET_PROJECTS, PROJECT_HEADERS);
    var id = Utilities.getUuid();
    p.sheet.appendRow(rowArray_(p.col, PROJECT_HEADERS, {
      'ID': id, 'Name': name, 'Client': String(meta.client || ''),
      'Budget': Number(meta.budget) || 0, 'Fee': Number(meta.fee) || 0,
      'Version': String(meta.version || ''), 'Notes': String(meta.notes || ''),
      'Created': new Date()
    }));
    writeLines_(id, lines || [], {});
    return { projects: listProjects_(), budgetLines: listLines_() };
  });
}

/**
 * Replaces a project's budget (new budget version). Lines whose
 * section+item match an existing line keep their ID, so transactions
 * already reconciled against them stay attached.
 */
function replaceProjectBudget(projectId, meta, lines) {
  return withLock_(function () {
    var p = readRows_(SHEET_PROJECTS, PROJECT_HEADERS);
    var found = null;
    p.rows.forEach(function (r) {
      if (String(r.values[p.col['ID']]) === String(projectId)) found = r;
    });
    if (!found) throw new Error('Project not found.');
    ['Name', 'Client', 'Budget', 'Fee', 'Version', 'Notes'].forEach(function (h, i) {
      var vals = [String(meta.name || '').trim(), String(meta.client || ''),
        Number(meta.budget) || 0, Number(meta.fee) || 0,
        String(meta.version || ''), String(meta.notes || '')];
      p.sheet.getRange(found.rowNumber, p.col[h] + 1).setValue(vals[i]);
    });
    syncTxnProjectName_(projectId, String(meta.name || '').trim());

    // remember old line IDs by section+item so they can be preserved
    var keep = {};
    listLines_().forEach(function (l) {
      if (l.projectId === String(projectId)) {
        keep[(l.section + '||' + l.item).toLowerCase()] = l.id;
      }
    });
    deleteLinesForProject_(projectId);
    writeLines_(projectId, lines || [], keep);
    return { projects: listProjects_(), budgetLines: listLines_() };
  });
}

function writeLines_(projectId, lines, keepIds) {
  if (!lines.length) return;
  var s = getSheet_(SHEET_LINES, LINE_HEADERS);
  var rows = lines.map(function (l, i) {
    var key = (String(l.section || '') + '||' + String(l.item || '')).toLowerCase();
    return rowArray_(s.col, LINE_HEADERS, {
      'ID': keepIds[key] || Utilities.getUuid(),
      'Project ID': String(projectId),
      'Section': String(l.section || ''),
      'Item': String(l.item || ''),
      'Description': String(l.description || ''),
      'Qty': String(l.qty || ''),
      'Rate': String(l.rate || ''),
      'Amount': Number(l.amount) || 0,
      'Order': i + 1
    });
  });
  var width = Math.max.apply(null, rows.map(function (r) { return r.length; }));
  rows = rows.map(function (r) { while (r.length < width) r.push(''); return r; });
  s.sheet.getRange(s.sheet.getLastRow() + 1, 1, rows.length, width).setValues(rows);
}

function deleteLinesForProject_(projectId) {
  var d = readRows_(SHEET_LINES, LINE_HEADERS);
  for (var i = d.rows.length - 1; i >= 0; i--) {
    if (String(d.rows[i].values[d.col['Project ID']]) === String(projectId)) {
      d.sheet.deleteRow(d.rows[i].rowNumber);
    }
  }
}

/** Manual project creation (no uploaded budget). */
function addProject(name, budget, notes) {
  return saveProjectWithBudget({ name: name, budget: budget, notes: notes }, []).projects;
}

function updateProject(id, name, budget, notes) {
  return withLock_(function () {
    var p = readRows_(SHEET_PROJECTS, PROJECT_HEADERS);
    for (var i = 0; i < p.rows.length; i++) {
      var r = p.rows[i];
      if (String(r.values[p.col['ID']]) === String(id)) {
        p.sheet.getRange(r.rowNumber, p.col['Name'] + 1).setValue(String(name || '').trim());
        p.sheet.getRange(r.rowNumber, p.col['Budget'] + 1).setValue(Number(budget) || 0);
        p.sheet.getRange(r.rowNumber, p.col['Notes'] + 1).setValue(String(notes || ''));
        syncTxnProjectName_(id, String(name || '').trim());
        return listProjects_();
      }
    }
    throw new Error('Project not found.');
  });
}

function deleteProject(id) {
  if (String(id) === OVERHEADS_ID) {
    throw new Error('The Company Overheads project can’t be deleted — it collects your production fees and company expenses.');
  }
  return withLock_(function () {
    var p = readRows_(SHEET_PROJECTS, PROJECT_HEADERS);
    for (var i = 0; i < p.rows.length; i++) {
      var r = p.rows[i];
      if (String(r.values[p.col['ID']]) === String(id)) {
        p.sheet.deleteRow(r.rowNumber);
        deleteLinesForProject_(id);
        return { projects: listProjects_(), budgetLines: listLines_() };
      }
    }
    throw new Error('Project not found.');
  });
}

/** Keeps the denormalised project-name column on transactions in sync after a rename. */
function syncTxnProjectName_(projectId, newName) {
  var d = readRows_(SHEET_TRANSACTIONS, TXN_HEADERS);
  d.rows.forEach(function (r) {
    if (String(r.values[d.col['Project ID']]) === String(projectId)) {
      d.sheet.getRange(r.rowNumber, d.col['Project Name'] + 1).setValue(newName);
    }
  });
}

// ------------------------------------------------------------ Transactions

function listTransactions_() {
  var d = readRows_(SHEET_TRANSACTIONS, TXN_HEADERS);
  return d.rows.filter(function (r) { return r.values[d.col['Hash']]; }).map(function (r) {
    var v = r.values;
    return {
      hash: String(v[d.col['Hash']]),
      date: formatDate_(v[d.col['Date']]),
      description: String(v[d.col['Description']] || ''),
      amount: Number(v[d.col['Amount']]) || 0,
      gross: Number(v[d.col['Gross']]) || 0,
      vat: Number(v[d.col['VAT']]) || 0,
      projectId: String(v[d.col['Project ID']] || ''),
      projectName: String(v[d.col['Project Name']] || ''),
      lineId: String(v[d.col['Line ID']] || ''),
      lineName: String(v[d.col['Line Name']] || ''),
      category: String(v[d.col['Category']] || ''),
      purpose: String(v[d.col['Purpose']] || ''),
      statement: String(v[d.col['Statement']] || ''),
      recorded: formatDate_(v[d.col['Recorded']])
    };
  });
}

/**
 * Appends transactions, skipping any whose hash is already stored
 * (so re-uploading the same statement never creates duplicates).
 * Each txn: {hash, date, description, amount, projectId, projectName,
 *            lineId, lineName, category, purpose, statement}
 */
function saveTransactions(txns) {
  if (!txns || !txns.length) return { saved: 0, duplicates: 0 };
  return withLock_(function () {
    var d = readRows_(SHEET_TRANSACTIONS, TXN_HEADERS);
    var existing = {};
    d.rows.forEach(function (r) {
      if (r.values[d.col['Hash']]) existing[String(r.values[d.col['Hash']])] = true;
    });
    var rows = [];
    var duplicates = 0;
    var now = new Date();
    txns.forEach(function (t) {
      if (existing[String(t.hash)]) { duplicates++; return; }
      existing[String(t.hash)] = true;
      rows.push(rowArray_(d.col, TXN_HEADERS, {
        'Hash': String(t.hash), 'Date': String(t.date || ''),
        'Description': String(t.description || ''), 'Amount': Number(t.amount) || 0,
        'Gross': Number(t.gross) || Number(t.amount) || 0, 'VAT': Number(t.vat) || 0,
        'Project ID': String(t.projectId || ''), 'Project Name': String(t.projectName || ''),
        'Line ID': String(t.lineId || ''), 'Line Name': String(t.lineName || ''),
        'Category': String(t.category || ''), 'Purpose': String(t.purpose || ''),
        'Statement': String(t.statement || ''), 'Recorded': now
      }));
    });
    if (rows.length) {
      var width = Math.max.apply(null, rows.map(function (r) { return r.length; }));
      rows = rows.map(function (r) { while (r.length < width) r.push(''); return r; });
      d.sheet.getRange(d.sheet.getLastRow() + 1, 1, rows.length, width).setValues(rows);
    }
    return { saved: rows.length, duplicates: duplicates };
  });
}

function deleteTransaction(hash) {
  return withLock_(function () {
    var d = readRows_(SHEET_TRANSACTIONS, TXN_HEADERS);
    for (var i = 0; i < d.rows.length; i++) {
      if (String(d.rows[i].values[d.col['Hash']]) === String(hash)) {
        d.sheet.deleteRow(d.rows[i].rowNumber);
        break;
      }
    }
    return listTransactions_();
  });
}

// ---------------------------------------------------------------- Settings

function getSettings_() {
  var d = readRows_(SHEET_SETTINGS, SETTINGS_HEADERS);
  var settings = { currency: '£' };
  d.rows.forEach(function (r) {
    if (r.values[d.col['Key']]) {
      settings[String(r.values[d.col['Key']])] = String(r.values[d.col['Value']]);
    }
  });
  return settings;
}

function setSetting(key, value) {
  return withLock_(function () {
    var d = readRows_(SHEET_SETTINGS, SETTINGS_HEADERS);
    for (var i = 0; i < d.rows.length; i++) {
      if (String(d.rows[i].values[d.col['Key']]) === String(key)) {
        d.sheet.getRange(d.rows[i].rowNumber, d.col['Value'] + 1).setValue(String(value));
        return getSettings_();
      }
    }
    d.sheet.appendRow([String(key), String(value)]);
    return getSettings_();
  });
}

// ------------------------------------------------------------------- Utils

/** Dates read from Sheets may come back as Date objects — normalise to yyyy-MM-dd. */
function formatDate_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(value || '');
}
