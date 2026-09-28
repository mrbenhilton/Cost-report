/**
 * Receipts & bills — server-side code (Google Apps Script).
 *
 * Email intake: receipts and supplier invoices sent to plus-addresses of the
 * owner's mailbox (e.g. ben+receipts@film.works) are picked up from Gmail,
 * stored in a Google Drive folder, and read by Claude, which extracts the
 * supplier, date, amounts, VAT and who the document is addressed to. Each
 * becomes a row in the Documents tab; the web app then matches documents to
 * bank / card transactions, chases missing receipts and builds the monthly
 * pack for the accountant.
 *
 * The Claude API key lives in Script Properties (never in the sheet).
 */

var SHEET_DOCUMENTS = 'Documents';
var DOC_HEADERS = [
  'ID', 'Received', 'Source', 'Kind', 'Company ID', 'From', 'Subject', 'Message ID',
  'File ID', 'File URL', 'File Name', 'Supplier', 'Date', 'Due Date', 'Invoice No',
  'Currency', 'Net', 'VAT', 'Gross', 'VAT Number', 'Billed To', 'Description',
  'Spender', 'Status', 'Txn Hash', 'Flags', 'Error'
];
// Status: 'new' (read, not yet matched) · 'matched' (linked to a transaction)
// · 'paid' (bill marked paid by hand) · 'ignored' (not a receipt/bill) · 'error'

var CLAUDE_MODEL = 'claude-opus-5';
var CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
var API_KEY_PROPERTY = 'CLAUDE_API_KEY';
var PROCESSED_LABEL = 'Accounts/Processed';
var DRIVE_ROOT_NAME = 'Accounts — receipts & invoices';

/** Document types Claude can read directly. */
var READABLE_TYPES = {
  'application/pdf': 'document',
  'image/jpeg': 'image', 'image/png': 'image', 'image/gif': 'image', 'image/webp': 'image'
};
/** Default people and their email addresses (Settings: people). */
var DEFAULT_PEOPLE_SETTING = 'Ben <ben@film.works>, Glen <glen@film.works>, Domante <domante@film.works>';

// --------------------------------------------------------------- Settings

/** Stores the Claude API key in Script Properties (not visible in the sheet). */
function setClaudeApiKey(key) {
  var k = String(key || '').trim();
  if (k && !/^sk-ant-/.test(k)) throw new Error('That doesn’t look like a Claude API key (they start with sk-ant-).');
  var props = PropertiesService.getScriptProperties();
  if (k) props.setProperty(API_KEY_PROPERTY, k); else props.deleteProperty(API_KEY_PROPERTY);
  return getIntakeInfo_();
}

/** [{name, email}] from the `people` setting ("Ben <ben@x>, Glen <glen@x>"). */
function people_() {
  var raw = getSettings_().people || DEFAULT_PEOPLE_SETTING;
  return String(raw).split(',').map(function (part) {
    var m = part.match(/^\s*([^<]*?)\s*(?:<\s*([^>]+)\s*>)?\s*$/);
    return m ? { name: m[1].trim(), email: String(m[2] || '').trim().toLowerCase() } : null;
  }).filter(function (p) { return p && p.name; });
}

/**
 * The addresses documents are sent to. The shared accounts address
 * (Settings: sharedInbox, default accounts@<your domain>) takes anything:
 * Claude decides receipt vs bill and which company it's addressed to. The
 * plus-addresses force the type and company: the default company uses
 * <you>+receipts / <you>+invoices, others add their ID, e.g.
 * <you>+allotment-receipts. Plus-addresses come first so they win when an
 * email is sent to both.
 */
function intakeAddresses_() {
  var settings = getSettings_();
  var base = String(settings.intakeEmail || Session.getEffectiveUser().getEmail() || '').toLowerCase();
  var at = base.indexOf('@');
  if (at < 1) return [];
  var local = base.slice(0, at).split('+')[0];
  var domain = base.slice(at + 1);
  var shared = settings.sharedInbox != null && settings.sharedInbox !== ''
    ? String(settings.sharedInbox).trim().toLowerCase()
    : (/^(gmail|googlemail)\.com$/.test(domain) ? '' : 'accounts@' + domain);
  var out = [];
  listCompanies_().forEach(function (c) {
    var tag = c.id === DEFAULT_COMPANY_ID ? '' : c.id + '-';
    out.push({ address: local + '+' + tag + 'receipts@' + domain, kind: 'receipt', companyId: c.id });
    out.push({ address: local + '+' + tag + 'invoices@' + domain, kind: 'invoice', companyId: c.id });
  });
  if (shared && shared !== 'none') out.push({ address: shared, kind: 'auto', companyId: '', shared: true });
  return out;
}

function getIntakeInfo_() {
  var settings = getSettings_();
  var triggerOn = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'processInbox';
  });
  var lastRun = null;
  try { lastRun = settings.intakeLastRun ? JSON.parse(settings.intakeLastRun) : null; } catch (e) { lastRun = null; }
  return {
    addresses: intakeAddresses_(),
    hasApiKey: !!PropertiesService.getScriptProperties().getProperty(API_KEY_PROPERTY),
    autoScan: triggerOn,
    lastRun: lastRun,
    people: people_(),
    accountantEmail: settings.accountantEmail || ''
  };
}

/** Turns hourly inbox scanning on or off. */
function setAutoScan(on) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processInbox') ScriptApp.deleteTrigger(t);
  });
  if (on) ScriptApp.newTrigger('processInbox').timeBased().everyHours(1).create();
  return getIntakeInfo_();
}

// ---------------------------------------------------------------- Storage

function listDocuments_() {
  var d = readRows_(SHEET_DOCUMENTS, DOC_HEADERS);
  return d.rows.filter(function (r) { return r.values[d.col['ID']]; }).map(function (r) {
    return docFromRow_(d.col, r.values);
  });
}

function docFromRow_(col, v) {
  function s(h) { return String(v[col[h]] == null ? '' : v[col[h]]); }
  function n(h) { return Number(v[col[h]]) || 0; }
  return {
    id: s('ID'), received: formatDate_(v[col['Received']]), source: s('Source'), kind: s('Kind'),
    // '' = not known yet (shared inbox, not addressed to a company)
    companyId: s('Company ID'), from: s('From'), subject: s('Subject'),
    messageId: s('Message ID'), fileId: s('File ID'), fileUrl: s('File URL'), fileName: s('File Name'),
    supplier: s('Supplier'), date: formatDate_(v[col['Date']]), dueDate: formatDate_(v[col['Due Date']]),
    invoiceNo: s('Invoice No'), currency: s('Currency') || 'GBP', net: n('Net'), vat: n('VAT'),
    gross: n('Gross'), vatNumber: s('VAT Number'), billedTo: s('Billed To'),
    description: s('Description'), spender: s('Spender'), status: s('Status') || 'new',
    txnHash: s('Txn Hash'), flags: s('Flags'), error: s('Error')
  };
}

function appendDocument_(doc) {
  var s = getSheet_(SHEET_DOCUMENTS, DOC_HEADERS);
  var obj = {};
  DOC_HEADERS.forEach(function (h) { obj[h] = ''; });
  Object.keys(doc).forEach(function (h) { obj[h] = doc[h]; });
  s.sheet.appendRow(rowArray_(s.col, DOC_HEADERS, obj));
}

/** Applies {header: value} changes to one document row. */
function updateDocumentRow_(docId, changes) {
  var d = readRows_(SHEET_DOCUMENTS, DOC_HEADERS);
  for (var i = 0; i < d.rows.length; i++) {
    if (String(d.rows[i].values[d.col['ID']]) === String(docId)) {
      Object.keys(changes).forEach(function (h) {
        d.sheet.getRange(d.rows[i].rowNumber, d.col[h] + 1).setValue(changes[h]);
      });
      return docFromRow_(d.col, d.sheet.getRange(d.rows[i].rowNumber, 1, 1, d.sheet.getLastColumn()).getValues()[0]);
    }
  }
  throw new Error('Document not found.');
}

function driveRoot_() {
  var id = getSettings_().driveFolderId;
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* folder gone — make a new one */ }
  }
  var folder = DriveApp.createFolder(DRIVE_ROOT_NAME);
  setSetting('driveFolderId', folder.getId());
  return folder;
}

function subfolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function companyFolder_(companyId) {
  var c = listCompanies_().filter(function (x) { return x.id === companyId; })[0];
  return subfolder_(driveRoot_(), c ? c.shortName : companyId);
}

// ----------------------------------------------------------------- Intake

/**
 * Reads new mail sent to the intake addresses. Runs hourly when auto-scan is
 * on, or from the app's "Check inbox now" button. Stops before Apps Script's
 * 6-minute limit; whatever is left is picked up next time.
 */
function processInbox() {
  // a user lock (not the script lock the app's saves use), so a long scan
  // never blocks the app; it only stops two scans running at once
  var lock = LockService.getUserLock();
  if (!lock.tryLock(2000)) return { busy: true };
  var started = Date.now();
  var summary = { at: new Date().toISOString(), processed: 0, errors: 0, remaining: false };
  try {
    var routes = intakeAddresses_();
    if (!routes.length) throw new Error('Could not work out your email address.');
    if (!PropertiesService.getScriptProperties().getProperty(API_KEY_PROPERTY)) {
      throw new Error('Add your Claude API key on the Receipts tab first.');
    }
    var seen = {};
    listDocuments_().forEach(function (doc) { seen[doc.messageId] = true; });
    var label = GmailApp.getUserLabelByName(PROCESSED_LABEL) || GmailApp.createLabel(PROCESSED_LABEL);
    // No label filter: a reply can arrive later in an already-processed
    // thread (e.g. photos sent back after a chase email). Messages already
    // recorded are skipped by their ID; newest threads come first.
    var query = '{' + routes.map(function (r) { return 'to:' + r.address + ' deliveredto:' + r.address; }).join(' ') +
      '} newer_than:45d';
    var threads = GmailApp.search(query, 0, 50);
    var peopleList = people_();
    var me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();

    for (var t = 0; t < threads.length; t++) {
      var threadDone = true;
      var messages = threads[t].getMessages();
      for (var m = 0; m < messages.length; m++) {
        if (Date.now() - started > 4.5 * 60 * 1000) { threadDone = false; summary.remaining = true; break; }
        var msg = messages[m];
        var route = routeFor_(msg, routes);
        if (!route) continue;   // e.g. your own reply in the thread
        var from = emailOf_(msg.getFrom());
        var person = peopleList.filter(function (p) { return p.email && p.email === from; })[0];
        if (!person && from === me) person = peopleList.filter(function (p) { return p.email === me; })[0];
        var parts = messageParts_(msg);
        for (var p = 0; p < parts.length; p++) {
          var key = msg.getId() + '#' + p;
          if (seen[key]) continue;
          ingest_(parts[p], {
            messageKey: key, route: route, from: msg.getFrom(), subject: msg.getSubject(),
            received: msg.getDate(), spender: person ? person.name : '', source: 'email'
          });
          seen[key] = true;
          if (parts[p].error) summary.errors++; else summary.processed++;
        }
      }
      if (threadDone) threads[t].addLabel(label);
      else break;
    }
    if (threads.length === 50 && !summary.remaining) summary.moreThreads = true;
  } catch (e) {
    summary.error = String(e && e.message ? e.message : e);
  } finally {
    setSetting('intakeLastRun', JSON.stringify(summary));
    lock.releaseLock();
  }
  return summary;
}

/** App button: scan now, and hand back the refreshed data. */
function checkInboxNow() {
  var summary = processInbox();
  return { summary: summary, documents: listDocuments_(), intake: getIntakeInfo_() };
}

function emailOf_(fromHeader) {
  var m = String(fromHeader || '').match(/<([^>]+)>/);
  return String(m ? m[1] : fromHeader || '').trim().toLowerCase();
}

/** Which intake address a message was sent to (To, Cc or Delivered-To). */
function routeFor_(msg, routes) {
  var hay = [msg.getTo(), msg.getCc(), msg.getHeader('Delivered-To'), msg.getHeader('X-Original-To')]
    .join(' ').toLowerCase();
  for (var i = 0; i < routes.length; i++) {
    if (hay.indexOf(routes[i].address) !== -1) return routes[i];
  }
  return null;
}

/**
 * The documents inside one email: each PDF / image attachment, or — when
 * there are none — the email itself (e.g. an online-order receipt), saved
 * as a PDF with its text passed to Claude.
 */
function messageParts_(msg) {
  var parts = [];
  msg.getAttachments({ includeInlineImages: false }).forEach(function (a) {
    var type = String(a.getContentType() || '').toLowerCase().split(';')[0];
    var name = a.getName() || 'attachment';
    if (/heic|heif/.test(type) || /\.hei[cf]$/i.test(name)) {
      parts.push({ blob: a.copyBlob(), name: name, error: 'HEIC photos can’t be read — resend as JPG (iPhone: Settings → Camera → Formats → Most Compatible).' });
      return;
    }
    if (!READABLE_TYPES[type]) return;                              // calendar invites, signatures…
    if (READABLE_TYPES[type] === 'image' && a.getSize() < 8000) return;   // logos
    parts.push({ blob: a.copyBlob().setContentType(type), name: name });
  });
  if (!parts.length) {
    var html = msg.getBody();
    var name = (msg.getSubject() || 'email') + '.pdf';
    var pdf = null;
    try { pdf = Utilities.newBlob(html, 'text/html', 'email.html').getAs('application/pdf').setName(name); } catch (e) { pdf = null; }
    parts.push({ blob: pdf, name: name, text: msg.getPlainBody() });
  }
  return parts;
}

/** Stores one document in Drive, has Claude read it, and records it. */
function ingest_(part, ctx) {
  var row = {
    'ID': Utilities.getUuid(), 'Received': ctx.received, 'Source': ctx.source,
    'Kind': ctx.route.kind === 'auto' ? 'receipt' : ctx.route.kind,
    'Company ID': ctx.route.companyId, 'From': ctx.from, 'Subject': ctx.subject,
    'Message ID': ctx.messageKey, 'File Name': part.name,
    'Spender': ctx.spender, 'Status': 'new', 'Currency': 'GBP'
  };
  if (part.error) {
    row['Status'] = 'error';
    row['Error'] = part.error;
  } else {
    try {
      applyExtraction_(row, extractDocument_(part, ctx), ctx.route);
    } catch (e) {
      row['Status'] = 'error';
      row['Error'] = String(e && e.message ? e.message : e);
    }
  }
  if (part.blob) {
    var file = documentFolder_(row['Company ID'], ctx.received).createFile(part.blob);
    if (row['Status'] !== 'error') file.setName(documentFileName_(row, part.name));
    row['File ID'] = file.getId();
    row['File URL'] = file.getUrl();
    row['File Name'] = file.getName();
  }
  appendDocument_(row);
}

/** Drive folder for a document: <company>/<yyyy-MM>, or Unsorted/<yyyy-MM> until its company is known. */
function documentFolder_(companyId, date) {
  var parent = companyId ? companyFolder_(companyId) : subfolder_(driveRoot_(), 'Unsorted');
  return subfolder_(parent, Utilities.formatDate(date || new Date(), Session.getScriptTimeZone(), 'yyyy-MM'));
}

/** Moves a document's file when its company changes (so each company's folder has only its own). */
function refileDocument_(doc, companyId) {
  if (!doc.fileId) return;
  try {
    var when = doc.date ? new Date(doc.date + 'T12:00:00') : new Date();
    DriveApp.getFileById(doc.fileId).moveTo(documentFolder_(companyId, isNaN(when) ? new Date() : when));
  } catch (e) { /* file removed from Drive — nothing to move */ }
}

/** Fills a Documents row from Claude's reading of the document. */
function applyExtraction_(row, x, route) {
  row['Supplier'] = x.supplier;
  row['Date'] = x.documentDate;
  row['Due Date'] = x.dueDate;
  row['Invoice No'] = x.invoiceNumber;
  row['Currency'] = (x.currency || 'GBP').toUpperCase();
  row['Gross'] = round2_(x.gross);
  row['VAT'] = round2_(x.vat);
  row['Net'] = round2_(x.net || (x.gross - x.vat));
  row['VAT Number'] = x.vatNumber;
  row['Billed To'] = x.billedTo;
  row['Description'] = x.description;
  var flags = [];
  var addressedTo = x.billedToCompany && x.billedToCompany !== 'unknown' ? x.billedToCompany : '';
  if (x.kind === 'other') {
    row['Status'] = 'ignored';
    flags.push('Not a receipt or bill');
  } else {
    // trust the document over the address it was sent to (a paid invoice is a receipt)
    row['Kind'] = x.kind;
  }
  if (!route.companyId) {
    // shared inbox: the company it's addressed to; if it doesn't say, the
    // transaction it's matched to decides
    row['Company ID'] = addressedTo;
  } else if (addressedTo && addressedTo !== route.companyId) {
    flags.push('Addressed to ' + (x.billedTo || addressedTo) + ' — check which company it belongs to');
  }
  if (x.vat > 0 && !x.vatNumber) flags.push('VAT shown but no VAT number — may not be reclaimable');
  row['Flags'] = flags.join(' · ');
}

function documentFileName_(row, originalName) {
  var ext = (String(originalName).match(/\.[A-Za-z0-9]{2,5}$/) || ['.pdf'])[0].toLowerCase();
  var bits = [row['Date'] || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    String(row['Supplier'] || 'Unknown').replace(/[\\\/:*?"<>|]+/g, ' ').trim().slice(0, 40),
    (row['Currency'] && row['Currency'] !== 'GBP' ? row['Currency'] + ' ' : '£') + Number(row['Gross'] || 0).toFixed(2)];
  return bits.join('_') + ext;
}

function round2_(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/** Upload from the app (a photo or PDF picked on screen). */
function uploadDocument(fileName, mimeType, base64, companyId, kind) {
  var type = String(mimeType || '').toLowerCase();
  var blob = Utilities.newBlob(Utilities.base64Decode(base64), type, fileName);
  var part = { blob: blob, name: fileName };
  if (/heic|heif/.test(type) || /\.hei[cf]$/i.test(fileName)) {
    part.error = 'HEIC photos can’t be read — export it as JPG first.';
  } else if (!READABLE_TYPES[type]) {
    throw new Error('Upload a PDF, JPG, PNG, GIF or WebP file.');
  }
  var me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  var person = people_().filter(function (p) { return p.email === me; })[0];
  var lock = LockService.getUserLock();
  lock.waitLock(30000);
  try {
    ingest_(part, {
      messageKey: 'upload-' + Utilities.getUuid(),
      route: { kind: kind === 'invoice' ? 'invoice' : 'receipt', companyId: companyId || DEFAULT_COMPANY_ID },
      from: me, subject: fileName, received: new Date(), spender: person ? person.name : '', source: 'upload'
    });
  } finally {
    lock.releaseLock();
  }
  return listDocuments_();
}

// ----------------------------------------------------------------- Claude

function extractionSchema_() {
  var companyIds = listCompanies_().map(function (c) { return c.id; }).concat(['unknown']);
  var str = { type: 'string' };
  var num = { type: 'number' };
  return {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['receipt', 'invoice', 'other'] },
      supplier: str, documentDate: str, dueDate: str, invoiceNumber: str, currency: str,
      gross: num, vat: num, net: num, vatNumber: str, billedTo: str,
      billedToCompany: { type: 'string', enum: companyIds },
      description: str
    },
    required: ['kind', 'supplier', 'documentDate', 'dueDate', 'invoiceNumber', 'currency',
      'gross', 'vat', 'net', 'vatNumber', 'billedTo', 'billedToCompany', 'description'],
    additionalProperties: false
  };
}

function extractionPrompt_(ctx) {
  var companies = listCompanies_().map(function (c) { return c.name + ' (id: ' + c.id + ')'; }).join('; ');
  return [
    'This document arrived in the accounts inbox of a UK film production business.',
    'Our companies: ' + companies + '.',
    (ctx.route.kind === 'auto' ? 'It was sent to our general accounts address.'
      : 'It was sent to the ' + ctx.route.kind + 's address.') + ' Email subject: "' + (ctx.subject || '') +
      '". From: ' + (ctx.from || '') + '.',
    '',
    'Read it and fill in every field:',
    '- kind: "receipt" if it shows a payment already made (till receipt, card slip, paid order',
    '  confirmation, invoice marked paid); "invoice" if it asks us to pay (amount due, due date,',
    '  bank details); "other" if it is not a receipt or bill (quote, estimate, statement,',
    '  newsletter, marketing, delivery note without prices).',
    '- supplier: the business that issued it, as they name themselves (short, no "Ltd" needed).',
    '- documentDate / dueDate: YYYY-MM-DD, or "" if not shown.',
    '- currency: ISO code, e.g. GBP, EUR, USD.',
    '- gross: the total paid or payable including VAT. vat: the VAT amount shown, 0 if none is',
    '  shown. net: gross minus vat. Plain numbers, no currency symbols.',
    '- vatNumber: the supplier\'s VAT registration number if printed (e.g. GB123456789), else "".',
    '- invoiceNumber: invoice / receipt / order number, else "".',
    '- billedTo: the customer name or company it is addressed to, else "".',
    '- billedToCompany: which of our companies it is addressed to, or "unknown" if it doesn\'t say.',
    '- description: what was bought, in at most 8 words.',
    'If the document is unreadable, use kind "other" and describe the problem in description.'
  ].join('\n');
}

/** Sends one document to Claude and returns the extracted fields. */
function extractDocument_(part, ctx) {
  var content = [];
  var type = part.blob ? String(part.blob.getContentType() || '').toLowerCase() : '';
  if (part.text) {
    content.push({ type: 'text', text: 'Email content:\n\n' + String(part.text).slice(0, 60000) });
  } else if (READABLE_TYPES[type] === 'document') {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf',
      data: Utilities.base64Encode(part.blob.getBytes()) } });
  } else if (READABLE_TYPES[type] === 'image') {
    content.push({ type: 'image', source: { type: 'base64', media_type: type,
      data: Utilities.base64Encode(part.blob.getBytes()) } });
  } else {
    throw new Error('Unsupported file type: ' + type);
  }
  content.push({ type: 'text', text: extractionPrompt_(ctx) });
  return callClaude_(content, extractionSchema_());
}

/**
 * One Messages API call returning JSON that matches `schema`. Retries once
 * on rate limits / server errors. Refusal fallbacks are enabled so a
 * declined request is re-run on Anthropic's recommended fallback model.
 */
function callClaude_(content, schema) {
  var key = PropertiesService.getScriptProperties().getProperty(API_KEY_PROPERTY);
  if (!key) throw new Error('No Claude API key — add it on the Receipts tab.');
  var payload = JSON.stringify({
    model: CLAUDE_MODEL,
    max_tokens: 8000,
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: schema } },
    messages: [{ role: 'user', content: content }]
  });
  var options = {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: payload,
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01'
    }
  };
  var res, code;
  for (var attempt = 0; attempt < 2; attempt++) {
    res = UrlFetchApp.fetch(CLAUDE_URL, options);
    code = res.getResponseCode();
    if (code !== 429 && code < 500) break;
    Utilities.sleep(8000);
  }
  var body;
  try { body = JSON.parse(res.getContentText()); } catch (e) { body = null; }
  if (code !== 200) {
    var msg = body && body.error ? body.error.message : res.getContentText().slice(0, 200);
    if (code === 401) msg = 'the API key was rejected — check it on the Receipts tab';
    throw new Error('Claude API error ' + code + ': ' + msg);
  }
  if (body.stop_reason === 'refusal') throw new Error('Claude declined to read this document.');
  if (body.stop_reason === 'max_tokens') throw new Error('Claude’s answer was cut off — try again.');
  var text = body.content.filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; }).join('');
  return JSON.parse(text);
}

/** Re-reads a document that failed (e.g. after adding the API key). */
function retryDocument(docId) {
  return withLock_(function () {
    var doc = listDocuments_().filter(function (d) { return d.id === docId; })[0];
    if (!doc || !doc.fileId) throw new Error('Nothing to re-read for that document.');
    var blob = DriveApp.getFileById(doc.fileId).getBlob();
    var ctx = { route: { kind: doc.companyId ? (doc.kind || 'receipt') : 'auto', companyId: doc.companyId }, subject: doc.subject, from: doc.from };
    var type = String(blob.getContentType() || '').toLowerCase();
    if (!READABLE_TYPES[type]) throw new Error('That file type can’t be read.');
    var x = extractDocument_({ blob: blob, name: doc.fileName }, ctx);
    var row = { 'Status': 'new', 'Error': '', 'Kind': doc.kind || 'receipt', 'Company ID': doc.companyId };
    applyExtraction_(row, x, ctx.route);
    updateDocumentRow_(docId, row);
    if (row['Company ID'] !== doc.companyId) refileDocument_(doc, row['Company ID']);
    return listDocuments_();
  });
}

// --------------------------------------------------------------- Matching

/**
 * Links documents to transactions: [{docId, txnHash}]. When a receipt
 * shows VAT and the transaction was recorded without any, the VAT is taken
 * from the receipt (the ex-VAT amount is what counts against budgets).
 */
function linkDocuments(pairs) {
  return withLock_(function () {
    var t = readRows_(SHEET_TRANSACTIONS, TXN_HEADERS);
    var txnRow = {};
    t.rows.forEach(function (r) { txnRow[String(r.values[t.col['Hash']])] = r; });
    var docs = {};
    listDocuments_().forEach(function (d) { docs[d.id] = d; });
    (pairs || []).forEach(function (p) {
      var doc = docs[p.docId];
      var r = txnRow[String(p.txnHash)];
      if (!doc || !r) return;
      var changes = { 'Txn Hash': String(p.txnHash), 'Status': 'matched' };
      var txnCompany = String(r.values[t.col['Company ID']] || '') || DEFAULT_COMPANY_ID;
      if (doc.companyId !== txnCompany) {
        changes['Company ID'] = txnCompany;
        refileDocument_(doc, txnCompany);
      }
      var gross = Number(r.values[t.col['Gross']]) || Number(r.values[t.col['Amount']]) || 0;
      var vat = Number(r.values[t.col['VAT']]) || 0;
      if (doc.vat > 0 && !vat && gross > 0 && doc.currency === 'GBP' && Math.abs(gross - doc.gross) < 0.02) {
        t.sheet.getRange(r.rowNumber, t.col['Amount'] + 1).setValue(round2_(gross - doc.vat));
        t.sheet.getRange(r.rowNumber, t.col['VAT'] + 1).setValue(doc.vat);
        changes['Flags'] = [doc.flags, 'VAT taken from receipt'].filter(Boolean).join(' · ');
      }
      if (!doc.spender) {
        var spender = String(r.values[t.col['Spender']] || '');
        if (spender) changes['Spender'] = spender;
      }
      updateDocumentRow_(doc.id, changes);
    });
    return { documents: listDocuments_(), transactions: listTransactions_() };
  });
}

function unlinkDocument(docId) {
  return withLock_(function () {
    updateDocumentRow_(docId, { 'Txn Hash': '', 'Status': 'new' });
    return listDocuments_();
  });
}

/** Edits from the app: kind, company, status (ignored / paid / new). */
function updateDocument(docId, fields) {
  return withLock_(function () {
    var changes = {};
    if (fields.kind) changes['Kind'] = fields.kind;
    if (fields.companyId) {
      changes['Company ID'] = fields.companyId;
      var doc = listDocuments_().filter(function (d) { return d.id === docId; })[0];
      if (doc && doc.companyId !== fields.companyId) refileDocument_(doc, fields.companyId);
    }
    if (fields.status) changes['Status'] = fields.status;
    if (fields.status === 'ignored' || fields.status === 'new') changes['Txn Hash'] = '';
    updateDocumentRow_(docId, changes);
    return listDocuments_();
  });
}

/** Marks a transaction as needing no receipt (bank fees, salaries, HMRC…) or clears that. */
function setReceiptStatus(hash, status) {
  return withLock_(function () {
    var d = readRows_(SHEET_TRANSACTIONS, TXN_HEADERS);
    d.rows.forEach(function (r) {
      if (String(r.values[d.col['Hash']]) === String(hash)) {
        d.sheet.getRange(r.rowNumber, d.col['Receipt'] + 1).setValue(String(status || ''));
      }
    });
    return listTransactions_();
  });
}

// ----------------------------------------------------------------- Chasing

/**
 * Emails one person the list of their transactions with no receipt. Replies
 * go to the receipts address, so photos they send back are picked up
 * automatically.
 */
function sendReceiptChase(personName, hashes, companyId) {
  var person = people_().filter(function (p) { return p.name === personName; })[0];
  if (!person || !person.email) throw new Error('No email address for ' + personName + ' — add it to the people setting.');
  var addrs = intakeAddresses_();
  var route = addrs.filter(function (r) { return r.shared; })[0] ||
    addrs.filter(function (r) { return r.companyId === companyId && r.kind === 'receipt'; })[0];
  if (!route) throw new Error('No receipts address for that company.');
  var company = listCompanies_().filter(function (c) { return c.id === companyId; })[0];
  var accounts = {};
  listAccounts_().forEach(function (a) { accounts[a.id] = a.name; });
  var wanted = {};
  hashes.forEach(function (h) { wanted[h] = true; });
  var txns = listTransactions_().filter(function (t) { return wanted[t.hash]; })
    .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  if (!txns.length) throw new Error('Nothing to chase.');

  var cur = getSettings_().currency || '£';
  var lines = txns.map(function (t) {
    return t.date + '  ' + t.description + '  ' + cur + Math.abs(t.gross || t.amount).toFixed(2) +
      (accounts[t.accountId] ? '  (' + accounts[t.accountId] + ')' : '');
  });
  var rows = txns.map(function (t) {
    return '<tr><td style="padding:4px 12px 4px 0;">' + htmlEsc_(t.date) + '</td><td style="padding:4px 12px 4px 0;">' +
      htmlEsc_(t.description) + '</td><td style="padding:4px 12px 4px 0;text-align:right;">' + htmlEsc_(cur) +
      Math.abs(t.gross || t.amount).toFixed(2) + '</td><td style="padding:4px 0;color:#777;">' +
      htmlEsc_(accounts[t.accountId] || '') + '</td></tr>';
  }).join('');
  var subject = 'Receipts needed — ' + txns.length + ' item' + (txns.length === 1 ? '' : 's') +
    (company ? ' (' + company.shortName + ')' : '');
  var intro = 'Hi ' + person.name + ',\n\nI’m missing receipts for these' +
    (company ? ' ' + company.shortName : '') + ' card payments:\n\n';
  var outro = '\n\nCould you reply to this email with a photo or PDF of each? ' +
    'Anything sent to ' + route.address + ' is filed automatically.\n\nThanks!';
  GmailApp.sendEmail(person.email, subject, intro + lines.join('\n') + outro, {
    replyTo: route.address,
    htmlBody: '<p>Hi ' + htmlEsc_(person.name) + ',</p><p>I’m missing receipts for these' +
      (company ? ' ' + htmlEsc_(company.shortName) : '') + ' card payments:</p>' +
      '<table style="border-collapse:collapse;font-size:14px;">' + rows + '</table>' +
      '<p>Could you reply to this email with a photo or PDF of each? Anything sent to <b>' +
      htmlEsc_(route.address) + '</b> is filed automatically.</p><p>Thanks!</p>'
  });
  var now = new Date();
  return withLock_(function () {
    var d = readRows_(SHEET_TRANSACTIONS, TXN_HEADERS);
    d.rows.forEach(function (r) {
      if (wanted[String(r.values[d.col['Hash']])]) d.sheet.getRange(r.rowNumber, d.col['Chased'] + 1).setValue(now);
    });
    return listTransactions_();
  });
}

function htmlEsc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// ------------------------------------------------------------ Accountant pack

/**
 * Builds the month-end spreadsheet for one company: every transaction in
 * the period with project, VAT and a link to its receipt; supplier bills;
 * and a VAT summary. Saved in the company's Drive folder (private until
 * emailed). `rows` comes from the app so the sheet matches what's on screen.
 */
function buildAccountantPack(companyId, periodLabel, rows, bills, vatSummary) {
  var company = listCompanies_().filter(function (c) { return c.id === companyId; })[0];
  var name = (company ? company.shortName : companyId) + ' — accounts pack ' + periodLabel;
  var ss = SpreadsheetApp.create(name);
  var file = DriveApp.getFileById(ss.getId());
  var packs = subfolder_(companyFolder_(companyId), 'Accountant packs');
  file.moveTo(packs);

  function writeTab(sheet, header, data) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    if (data.length) sheet.getRange(2, 1, data.length, header.length).setValues(data);
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, header.length);
  }
  function link(url, label) {
    return url ? '=HYPERLINK("' + String(url).replace(/"/g, '') + '","' + String(label || 'open').replace(/"/g, '') + '")' : '';
  }

  var tx = ss.getSheets()[0].setName('Transactions');
  writeTab(tx, ['Date', 'Account', 'Spender', 'Type', 'Description', 'Supplier', 'Project', 'Budget line / category',
    'Net', 'VAT', 'Gross', 'VAT no.', 'Receipt', 'Receipt status', 'Note'],
    rows.map(function (r) {
      return [r.date, r.account, r.spender, r.type, r.description, r.supplier, r.project, r.line,
        r.net, r.vat, r.gross, r.vatNumber, link(r.receiptUrl, r.receiptName || 'receipt'), r.status, r.note];
    }));
  tx.getRange(2, 9, Math.max(1, rows.length), 3).setNumberFormat('#,##0.00');

  writeTab(ss.insertSheet('Supplier bills'), ['Supplier', 'Invoice no.', 'Date', 'Due', 'Net', 'VAT', 'Gross',
    'VAT no.', 'Status', 'Paid by', 'Bill'],
    bills.map(function (b) {
      return [b.supplier, b.invoiceNo, b.date, b.dueDate, b.net, b.vat, b.gross, b.vatNumber, b.status,
        b.paidBy, link(b.fileUrl, 'bill')];
    }));

  writeTab(ss.insertSheet('VAT summary'), ['', 'Amount'], vatSummary.map(function (v) { return [v.label, v.amount]; }));
  return { url: ss.getUrl(), id: ss.getId(), name: name };
}

/**
 * Shares the pack (and the company's receipts folder, so the receipt links
 * open) with the accountant and emails them the link.
 */
function emailAccountantPack(packId, companyId, periodLabel, accountantEmail, note) {
  var to = String(accountantEmail || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error('Enter the accountant’s email address.');
  setSetting('accountantEmail', to);
  var company = listCompanies_().filter(function (c) { return c.id === companyId; })[0];
  var file = DriveApp.getFileById(packId);
  file.addViewer(to);
  companyFolder_(companyId).addViewer(to);
  var who = company ? company.name : companyId;
  var subject = who + ' — accounts pack ' + periodLabel;
  var body = 'Hi,\n\nHere’s the ' + periodLabel + ' pack for ' + who + ': every transaction with its project, ' +
    'VAT and a link to the receipt, plus supplier bills and a VAT summary.\n\n' + file.getUrl() + '\n\n' +
    (note ? note + '\n\n' : '') + 'Thanks!';
  GmailApp.sendEmail(to, subject, body);
  return { sentTo: to };
}

/** Tags who spent a transaction (from the missing-receipts list). */
function setTransactionSpender(hash, name) {
  return withLock_(function () {
    var d = readRows_(SHEET_TRANSACTIONS, TXN_HEADERS);
    d.rows.forEach(function (r) {
      if (String(r.values[d.col['Hash']]) === String(hash)) {
        d.sheet.getRange(r.rowNumber, d.col['Spender'] + 1).setValue(String(name || ''));
      }
    });
    return listTransactions_();
  });
}
