/**
 * Project Cost Tracker — server-side code (Google Apps Script).
 *
 * This script is bound to a Google Sheet. All data lives in three tabs of
 * that sheet (Projects, Transactions, Settings), so nothing is ever lost
 * between sessions — the spreadsheet IS the database.
 */

var SHEET_PROJECTS = 'Projects';
var SHEET_TRANSACTIONS = 'Transactions';
var SHEET_SETTINGS = 'Settings';

var PROJECT_HEADERS = ['ID', 'Name', 'Budget', 'Notes', 'Created'];
var TXN_HEADERS = [
  'Hash', 'Date', 'Description', 'Amount', 'Project ID', 'Project Name',
  'Purpose', 'Category', 'Statement', 'Recorded'
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

/** Returns the named sheet, creating it with headers if it doesn't exist yet. */
function getSheet_(name, headers) {
  var ss = ss_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Everything the UI needs, in one call. */
function getAppData() {
  return {
    projects: listProjects_(),
    transactions: listTransactions_(),
    settings: getSettings_()
  };
}

// ---------------------------------------------------------------- Projects

function listProjects_() {
  var sheet = getSheet_(SHEET_PROJECTS, PROJECT_HEADERS);
  var values = sheet.getDataRange().getValues();
  var projects = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[0]) continue;
    projects.push({
      id: String(row[0]),
      name: String(row[1]),
      budget: Number(row[2]) || 0,
      notes: String(row[3] || ''),
      created: formatDate_(row[4])
    });
  }
  return projects;
}

function addProject(name, budget, notes) {
  name = String(name || '').trim();
  if (!name) throw new Error('Project name is required.');
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet_(SHEET_PROJECTS, PROJECT_HEADERS);
    var id = Utilities.getUuid();
    sheet.appendRow([id, name, Number(budget) || 0, String(notes || ''), new Date()]);
    return listProjects_();
  } finally {
    lock.releaseLock();
  }
}

function updateProject(id, name, budget, notes) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet_(SHEET_PROJECTS, PROJECT_HEADERS);
    var values = sheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][0]) === String(id)) {
        sheet.getRange(i + 1, 2, 1, 3)
          .setValues([[String(name || '').trim(), Number(budget) || 0, String(notes || '')]]);
        syncTxnProjectName_(id, String(name || '').trim());
        return listProjects_();
      }
    }
    throw new Error('Project not found.');
  } finally {
    lock.releaseLock();
  }
}

function deleteProject(id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet_(SHEET_PROJECTS, PROJECT_HEADERS);
    var values = sheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][0]) === String(id)) {
        sheet.deleteRow(i + 1);
        return listProjects_();
      }
    }
    throw new Error('Project not found.');
  } finally {
    lock.releaseLock();
  }
}

/** Keeps the denormalised project-name column on transactions in sync after a rename. */
function syncTxnProjectName_(projectId, newName) {
  var sheet = getSheet_(SHEET_TRANSACTIONS, TXN_HEADERS);
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][4]) === String(projectId)) {
      sheet.getRange(i + 1, 6).setValue(newName);
    }
  }
}

// ------------------------------------------------------------ Transactions

function listTransactions_() {
  var sheet = getSheet_(SHEET_TRANSACTIONS, TXN_HEADERS);
  var values = sheet.getDataRange().getValues();
  var txns = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[0]) continue;
    txns.push({
      hash: String(row[0]),
      date: formatDate_(row[1]),
      description: String(row[2]),
      amount: Number(row[3]) || 0,
      projectId: String(row[4] || ''),
      projectName: String(row[5] || ''),
      purpose: String(row[6] || ''),
      category: String(row[7] || ''),
      statement: String(row[8] || ''),
      recorded: formatDate_(row[9])
    });
  }
  return txns;
}

/**
 * Appends transactions, skipping any whose hash is already stored
 * (so re-uploading the same statement never creates duplicates).
 * Each txn: {hash, date, description, amount, projectId, projectName,
 *            purpose, category, statement}
 */
function saveTransactions(txns) {
  if (!txns || !txns.length) return { saved: 0, duplicates: 0 };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet_(SHEET_TRANSACTIONS, TXN_HEADERS);
    var existing = {};
    var values = sheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      if (values[i][0]) existing[String(values[i][0])] = true;
    }
    var rows = [];
    var duplicates = 0;
    var now = new Date();
    txns.forEach(function (t) {
      if (existing[String(t.hash)]) {
        duplicates++;
        return;
      }
      existing[String(t.hash)] = true;
      rows.push([
        String(t.hash), String(t.date || ''), String(t.description || ''),
        Number(t.amount) || 0, String(t.projectId || ''), String(t.projectName || ''),
        String(t.purpose || ''), String(t.category || ''), String(t.statement || ''), now
      ]);
    });
    if (rows.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, TXN_HEADERS.length)
        .setValues(rows);
    }
    return { saved: rows.length, duplicates: duplicates };
  } finally {
    lock.releaseLock();
  }
}

function deleteTransaction(hash) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet_(SHEET_TRANSACTIONS, TXN_HEADERS);
    var values = sheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][0]) === String(hash)) {
        sheet.deleteRow(i + 1);
        return listTransactions_();
      }
    }
    return listTransactions_();
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- Settings

function getSettings_() {
  var sheet = getSheet_(SHEET_SETTINGS, SETTINGS_HEADERS);
  var values = sheet.getDataRange().getValues();
  var settings = { currency: '£' };
  for (var i = 1; i < values.length; i++) {
    if (values[i][0]) settings[String(values[i][0])] = String(values[i][1]);
  }
  return settings;
}

function setSetting(key, value) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet_(SHEET_SETTINGS, SETTINGS_HEADERS);
    var values = sheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][0]) === String(key)) {
        sheet.getRange(i + 1, 2).setValue(String(value));
        return getSettings_();
      }
    }
    sheet.appendRow([String(key), String(value)]);
    return getSettings_();
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------------- Utils

/** Dates read from Sheets may come back as Date objects — normalise to yyyy-MM-dd. */
function formatDate_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(value || '');
}
