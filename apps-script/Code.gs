/**
 * Project Cost Tracker — server-side code (Google Apps Script).
 *
 * This script is bound to a Google Sheet. All data lives in tabs of that
 * sheet (Companies, Accounts, Projects, Budget Lines, Transactions,
 * Settings), so nothing is ever lost between sessions — the spreadsheet IS
 * the database.
 *
 * Columns are looked up by header name, so extra columns can be added to
 * a tab without breaking the app, and upgrades add any missing columns
 * automatically.
 */

var SHEET_PROJECTS = 'Projects';
var SHEET_LINES = 'Budget Lines';
var SHEET_TRANSACTIONS = 'Transactions';
var SHEET_SETTINGS = 'Settings';
var SHEET_COMPANIES = 'Companies';
var SHEET_ACCOUNTS = 'Accounts';

var COMPANY_HEADERS = ['ID', 'Name', 'Short Name', 'VAT Number'];
// Kind drives statement handling: 'bank' (Monzo etc.) or 'amex' (charges
// are positive, the monthly repayment arrives as a credit).
var ACCOUNT_HEADERS = ['ID', 'Company ID', 'Name', 'Kind'];

/**
 * Seeded on first run; edit names / VAT numbers / add accounts directly in
 * the Companies and Accounts tabs. Rows recorded before companies existed
 * have no company or account and belong to the first company's first bank
 * account (DEFAULT_COMPANY_ID / DEFAULT_ACCOUNT_ID).
 */
var DEFAULT_COMPANIES = [
  { 'ID': 'filmworks', 'Name': 'FILMWORKS LONDON LTD', 'Short Name': 'Filmworks', 'VAT Number': '' },
  { 'ID': 'allotment', 'Name': 'ALLOTMENT FILMS LTD', 'Short Name': 'Allotment', 'VAT Number': '' }
];
var DEFAULT_ACCOUNTS = [
  { 'ID': 'fw-monzo', 'Company ID': 'filmworks', 'Name': 'Filmworks Monzo', 'Kind': 'bank' },
  { 'ID': 'fw-amex', 'Company ID': 'filmworks', 'Name': 'Filmworks Amex', 'Kind': 'amex' },
  { 'ID': 'al-monzo', 'Company ID': 'allotment', 'Name': 'Allotment Monzo', 'Kind': 'bank' }
];
var DEFAULT_COMPANY_ID = 'filmworks';
var DEFAULT_ACCOUNT_ID = 'fw-monzo';

var PROJECT_HEADERS = ['ID', 'Name', 'Client', 'Budget', 'Fee', 'Version', 'Notes', 'Created', 'Company ID'];

/**
 * Each company has a Company Overheads project with a fixed ID so the app
 * can recognise it: 'company-overheads' for the default company (kept for
 * existing data), 'company-overheads-<company id>' for the others.
 * Production fees from the company's project budgets are treated as its
 * income, and company (non-project) expenses are recorded against it.
 */
var OVERHEADS_ID = 'company-overheads';

function overheadsIdFor_(companyId) {
  return companyId === DEFAULT_COMPANY_ID ? OVERHEADS_ID : OVERHEADS_ID + '-' + companyId;
}

function isOverheadsId_(id) {
  return String(id).indexOf(OVERHEADS_ID) === 0;
}
var LINE_HEADERS = ['ID', 'Project ID', 'Section', 'Item', 'Description', 'Qty', 'Rate', 'Amount', 'Order'];
// Amount is always the ex-VAT (net) figure — the one reconciled against
// budgets. Gross is what actually left the bank; VAT is the difference.
var TXN_HEADERS = [
  'Hash', 'Date', 'Description', 'Amount', 'Gross', 'VAT', 'Project ID',
  'Project Name', 'Line ID', 'Line Name', 'Category', 'Purpose', 'Statement', 'Recorded',
  'Account ID', 'Company ID', 'Spender'
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
  ensureCompaniesAndAccounts_();
  ensureOverheadsProjects_();
  return {
    companies: listCompanies_(),
    accounts: listAccounts_(),
    projects: listProjects_(),
    budgetLines: listLines_(),
    transactions: listTransactions_(),
    settings: getSettings_()
  };
}

// ------------------------------------------------------ Companies & accounts

/** Seeds the Companies and Accounts tabs the first time (each only if empty). */
function ensureCompaniesAndAccounts_() {
  [[SHEET_COMPANIES, COMPANY_HEADERS, DEFAULT_COMPANIES],
   [SHEET_ACCOUNTS, ACCOUNT_HEADERS, DEFAULT_ACCOUNTS]].forEach(function (spec) {
    var d = readRows_(spec[0], spec[1]);
    var hasAny = d.rows.some(function (r) { return r.values[d.col['ID']]; });
    if (hasAny) return;
    spec[2].forEach(function (obj) { d.sheet.appendRow(rowArray_(d.col, spec[1], obj)); });
  });
}

function listCompanies_() {
  var d = readRows_(SHEET_COMPANIES, COMPANY_HEADERS);
  return d.rows.filter(function (r) { return r.values[d.col['ID']]; }).map(function (r) {
    var v = r.values;
    var name = String(v[d.col['Name']] || '');
    return {
      id: String(v[d.col['ID']]),
      name: name,
      shortName: String(v[d.col['Short Name']] || '') || name,
      vatNumber: String(v[d.col['VAT Number']] || '')
    };
  });
}

function listAccounts_() {
  var d = readRows_(SHEET_ACCOUNTS, ACCOUNT_HEADERS);
  return d.rows.filter(function (r) { return r.values[d.col['ID']]; }).map(function (r) {
    var v = r.values;
    return {
      id: String(v[d.col['ID']]),
      companyId: String(v[d.col['Company ID']] || '') || DEFAULT_COMPANY_ID,
      name: String(v[d.col['Name']] || ''),
      kind: String(v[d.col['Kind']] || 'bank').toLowerCase()
    };
  });
}

// ---------------------------------------------------------------- Projects

/** Every company gets its own Company Overheads project. */
function ensureOverheadsProjects_() {
  var d = readRows_(SHEET_PROJECTS, PROJECT_HEADERS);
  var have = {};
  d.rows.forEach(function (r) { have[String(r.values[d.col['ID']])] = true; });
  listCompanies_().forEach(function (c) {
    var id = overheadsIdFor_(c.id);
    if (have[id]) return;
    d.sheet.appendRow(rowArray_(d.col, PROJECT_HEADERS, {
      'ID': id, 'Name': 'Company Overheads', 'Client': '',
      'Budget': 0, 'Fee': 0, 'Version': '',
      'Notes': 'Funded by production fees; holds company (non-project) expenses.',
      'Created': new Date(), 'Company ID': c.id
    }));
  });
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
      created: formatDate_(v[d.col['Created']]),
      companyId: String(v[d.col['Company ID']] || '') || DEFAULT_COMPANY_ID
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
 * budget). meta: {name, client, budget, fee, version, notes, companyId};
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
      'Created': new Date(), 'Company ID': String(meta.companyId || '') || DEFAULT_COMPANY_ID
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
function addProject(name, budget, notes, companyId) {
  return saveProjectWithBudget({ name: name, budget: budget, notes: notes, companyId: companyId }, []).projects;
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
  if (isOverheadsId_(id)) {
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
      recorded: formatDate_(v[d.col['Recorded']]),
      accountId: String(v[d.col['Account ID']] || '') || DEFAULT_ACCOUNT_ID,
      companyId: String(v[d.col['Company ID']] || '') || DEFAULT_COMPANY_ID,
      spender: String(v[d.col['Spender']] || '')
    };
  });
}

/**
 * Appends transactions, skipping any whose hash is already stored
 * (so re-uploading the same statement never creates duplicates).
 * Each txn: {hash, date, description, amount, projectId, projectName,
 *            lineId, lineName, category, purpose, statement,
 *            accountId, companyId, spender}
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
        'Statement': String(t.statement || ''), 'Recorded': now,
        'Account ID': String(t.accountId || '') || DEFAULT_ACCOUNT_ID,
        'Company ID': String(t.companyId || '') || DEFAULT_COMPANY_ID,
        'Spender': String(t.spender || '')
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
