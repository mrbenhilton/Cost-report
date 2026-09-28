# Project Cost Tracker

A small web app for reconciling project spending against the budgets you
quote:

1. **Upload a project budget** (PDF, like a FILMWORKS budget, or a CSV/text
   export of it). The app extracts the project name, client, budget version,
   production fee and total, and every **section and line item** — you check
   and correct everything on screen before saving.
2. Every month, **upload the bank statement** (CSV export from your online
   banking). The app walks through **each transaction one by one** and asks
   which project it belongs to and **which budget line it should reconcile
   against** — the categories are your own budget's sections and line items.
3. The **Cost report** shows, per project, a full reconciliation:
   **Budgeted / Actual / Remaining for every budget line**, section
   subtotals, overages flagged separately, and an overall
   spent-vs-budget meter. A **Company Overheads** project is maintained
   automatically: every budget's production fee flows into it as income,
   and company (non-project) expenses are recorded against it.
4. **Several companies and accounts in one place** — FILMWORKS LONDON LTD
   (Monzo + Amex) and ALLOTMENT FILMS LTD (Monzo) out of the box. A
   *Company* switcher in the header keeps each company's projects,
   statements and reports separate.
5. **Receipts & bills by email** — everyone sends receipts, photos and
   supplier invoices to `accounts@film.works`. Claude reads each one
   (supplier, date, amount, VAT, VAT number, which company it's for), it's
   filed in Google Drive, and matched to its card/bank transaction
   automatically. Missing receipts are chased by email, unpaid bills are
   listed with due dates, and at month end one click builds the
   accountant's spreadsheet (every transaction with project, VAT and a
   receipt link) and emails it to them.
6. Everything is stored **directly in a Google Sheet you own**, so nothing is
   ever lost between sessions — the spreadsheet *is* the database, and you can
   always open it and see (or edit) your data.

The app runs as a **Google Apps Script web app** — hosted free by Google,
private to your Google account, no servers or API keys to manage.

## Setup (about 10 minutes, one time)

1. **Create the spreadsheet.** Go to [sheets.new](https://sheets.new) and name
   the spreadsheet something like `Project Cost Tracker`. Leave it empty — the
   app creates its own tabs (`Companies`, `Accounts`, `Projects`,
   `Budget Lines`, `Transactions`, `Documents`, `Settings`) on first run.

2. **Open the script editor.** In that spreadsheet, choose
   **Extensions → Apps Script**. A script project opens in a new tab.

3. **Add the code.**
   - In the editor, select the `Code.gs` file, delete its contents, and paste
     in everything from [`apps-script/Code.gs`](apps-script/Code.gs).
   - Click **＋ (Add a file) → Script**, name it `Receipts`, and paste in
     everything from [`apps-script/Receipts.gs`](apps-script/Receipts.gs).
   - Click **＋ (Add a file) → HTML**, name it exactly `Index`, delete the
     placeholder contents, and paste in everything from
     [`apps-script/Index.html`](apps-script/Index.html).
   - Click the **Save** icon (or Ctrl/Cmd-S).

4. **Deploy it as a web app.**
   - Click **Deploy → New deployment**.
   - Click the gear next to "Select type" and choose **Web app**.
   - Set *Execute as*: **Me**, and *Who has access*: **Only myself**.
   - Click **Deploy**, then **Authorize access** and approve the permissions:
     your spreadsheets, Gmail (to read the accounts inbox and send chase /
     accountant emails), Drive (to file receipts), and external requests
     (to send documents to the Claude API for reading). Google shows an
     "unverified app" warning for your own scripts — click *Advanced → Go
     to … (unsafe)*; it's your code running in your account.
   - Copy the **Web app URL** it gives you and **bookmark it** — that URL is
     your app.

That's it. Open the URL and upload your first budget.

## Starting a project: upload its budget

On the **Projects** tab, choose the budget file, or — **if your budget lives
in Google Sheets or Excel, the easiest way**: select the budget cells in the
sheet, copy, and paste into the *paste the budget* box. The tab-separated
cells paste cleanly, including blank columns, a DATES block, `TBC` amounts
and note-only rows. PDFs are read in the browser too (the PDF reader library
loads from a CDN, so this needs an internet connection), as are CSV exports.
Screenshots/photos of a budget can't be read — copy the cells or export
instead. The app understands budgets laid out like:

```
Client:  <client name>
Project: <project name>
Budget Version: V1 - 23/03/2026

1 SECTION NAME
Item name    description    days    rate    total
...
SUBTOTAL     57,100.00
PRODUCTION FEE 8,565.00
TOTAL        65,665.00
```

Whatever it extracts is shown in an **editable table before anything is
saved** — fix a misread amount, rename a section, delete junk rows, or add
missing lines. Lines with `TBC` amounts are kept at 0 so they still appear
in the reconciliation.

The **production fee** is included in the project's budget total but isn't a
cost line — bank spending reconciles against the cost lines (the subtotal).
The fee itself is posted as **income to the Company Overheads project**, so
your margin across all projects funds the company's own running costs. If
you upload a revised budget with a different fee, the overheads income
updates automatically.

**Budget revisions:** every project card has *Upload new budget version*.
Lines that keep the same section + item name keep their identity, so
transactions you've already reconciled stay attached to them; the amounts,
version label and total update.

## Companies and accounts

The first run seeds two companies and three accounts:

| Account | Company | Kind |
|---|---|---|
| Filmworks Monzo | FILMWORKS LONDON LTD | bank |
| Filmworks Amex | FILMWORKS LONDON LTD | amex |
| Allotment Monzo | ALLOTMENT FILMS LTD | bank |

Rename them, add VAT numbers, or add accounts directly in the `Companies`
and `Accounts` tabs (an account's *Kind* is `bank` or `amex`). Every
project belongs to the company that was selected in the header when it
was created, and each company has its own **Company Overheads**. Data
recorded before companies existed belongs to Filmworks / Filmworks Monzo.

**Inter-company money** — a transfer between the two companies' accounts,
or one company paying the other's bill — has its own option on every
review card (*Inter-company — Allotment (loan / transfer)*). It's kept out
of project costs and income, and the report shows the net amount owed
between the companies. Transactions that mention the other company's name
are pre-selected as inter-company.

**Spenders.** Every expense can be tagged with who spent it (*Who spent
it?* on the review card) so missing receipts can be chased with the right
person later. The list is Ben, Glen, Domante — change it with a `people`
row in the `Settings` tab (e.g. `people | Ben, Glen, Domante`). On Amex
statements the cardmember is filled in automatically; on Monzo the app
suggests whoever you tagged last time for the same merchant.

## Monthly routine: reconcile the statements

1. Export each account's statement: **CSV** from Monzo (both companies);
   for Amex, either the **PDF statement** as downloaded, or a CSV export
   from the Amex website — pick one format per account and stick to it,
   because the same transaction reads differently in each and wouldn't be
   recognised as a duplicate.
2. Open the app → **Reconcile statement** → pick the **account**, choose the
   file; the label is filled in (e.g. `Filmworks Amex — Aug–Sep 2026`).
3. Check the column mapping (the app guesses date / description / amount and
   handles UK & US date formats, separate money-in/money-out columns, etc.).
   **Amex PDFs** are read directly: each cardmember section (Ben's card,
   Glen's card…) becomes the transaction's spender, credits marked `CR`
   come in as money in, foreign-spend amounts and detail lines become the
   statement note, and the monthly *PAYMENT RECEIVED* is skipped as an
   internal transfer. Amex amounts are positive for charges, which the
   column step sets automatically for an Amex account.
   **The Amex repayment on the Monzo side** (a payment to American
   Express) is skipped the same way, so the money is never counted twice.
   Bank-specific niceties, verified against a real Monzo Business export:
   - **Internal pot/savings transfers are skipped in bulk** — a checkbox
     shows how many rows are pot-to-pot moves (via the statement's Type
     column) so you never review them one by one.
   - A **notes/reference column** (e.g. Monzo's "Notes and #tags") is
     picked up automatically: the note is shown on each card and prefills
     the "what was this for?" field — handy when it holds invoice numbers.
   - Card-payment **refunds** are money-in rows too — they get the income
     card; allocate them to the project they refund.
4. Step through each transaction: pick the project, pick the **budget line**
   (grouped by your budget's sections), optionally add a note, **Save & next**.

   **VAT:** budgets are ex-VAT, so every card has an *Amount includes VAT*
   tick-box (default rate 20%, editable per transaction). Tick it and the
   **ex-VAT figure is what's recorded against the budget line** — the gross
   amount and the VAT are stored alongside it in the sheet, and the
   by-statement view totals the VAT excluded from costs each month. The same
   toggle appears on income cards (allocate the ex-VAT amount) and manual
   expenses. To change the default rate, add a `vatRate` row to the
   `Settings` tab (e.g. `vatRate | 20`).
   **Incoming payments get an income card instead**: allocate the payment to a
   project — or **split it across several projects** with the built-in split
   editor (a live counter shows the unallocated remainder). Income can also go
   to Company Overheads (e.g. bank interest) or be ignored (VAT refunds,
   personal top-ups). Tick *Skip incoming payments* in the mapping step if you
   don't want to review income at all.
   - Costs that weren't in the budget → **Overage — not in this budget**
     (give them a category); they're flagged in an *Overages* section of
     the report.
   - Company costs (rent, software, insurance…) → **Company Overheads**.
   - Personal payments or transfers between accounts → **Ignore**.
   - Unsure? **Skip for now** — it will be offered again next time you upload
     that statement.

**Re-uploading is safe.** Every transaction gets a fingerprint (date +
description + amount), so uploading the same statement twice never creates
duplicates — already-recorded transactions are silently skipped.

## The cost report

Budgets are per project, but each monthly bank statement crosses all of
them — so the report opens with a **By statement** breakdown showing where
each month's money went: statement by statement, split across the projects
(and overheads) its transactions were assigned to, with ignored
personal/transfer items listed separately.

Then per project: an overall budget meter, then the reconciliation — every budget
line with **Budgeted, Actual and Remaining**, subtotals per section,
over-spent lines and overages flagged with ⚠, and the full transaction list
(with delete, in case something was mis-assigned).

**Income is tracked per project**: each project card shows how much has been
received against its invoiced total (budget incl. fee) and what's still to
invoice. A *Received* tile totals it across projects, and each statement in
the by-statement view shows the income it brought in. Income never mixes with
the cost reconciliation — budget-line Actuals only ever contain spend.

The **Company Overheads** card lists the production-fee income from every
project (plus any other income allocated to it), company expenses by
category, and the net position — also shown as an *Overheads net* tile at
the top of the report.

**Costs with no bank transaction** — cash, a personal card, payroll, or
anything paid outside this bank account — can still be allocated to a budget
line: every project card in the report has **＋ Add an expense manually**.
Manual entries are stored like any other transaction (grouped under a
"Manual entry" statement in the by-statement view) and count toward the
line's Actual in the reconciliation.

## Receipts & bills

### One-time setup

1. **Claude API key.** At [console.anthropic.com](https://console.anthropic.com)
   sign in (or sign up), add a payment method under *Billing*, then
   *API keys → Create key*. Copy it (it starts `sk-ant-`), open the app's
   **Receipts & bills** tab and paste it into the key box. It's stored in
   the script's private properties, not in the spreadsheet. Documents are
   read with Claude Opus 5 at low effort.
2. **Tick "check every hour"** so new mail is picked up without you doing
   anything (or press *Check inbox now* whenever you like).
3. **Tell people where to send things.** The shared address is
   `accounts@film.works` (change it with a `sharedInbox` row in `Settings`).
   It must deliver into the mailbox the app runs as.

### Where documents come from

| Send to | What happens |
|---|---|
| `accounts@film.works` | Anything — Claude decides receipt vs bill, and which company it's addressed to. Receipts with no company on them (most till slips) get their company from the payment they match. |
| `ben+receipts@film.works`, `ben+invoices@film.works` | Forces Filmworks receipt / bill |
| `ben+allotment-receipts@…`, `ben+allotment-invoices@…` | Forces Allotment receipt / bill |
| *Upload a photo / PDF* on the tab | Same as emailing it |

Plus-addresses (`name+anything@`) need no setup — they land in the normal
inbox and the app reads the tag. Each email's PDFs and photos are read
separately; an email with no attachment (an Uber or Amazon receipt) is read
from its text and saved as a PDF. iPhone HEIC photos can't be read — set
*Settings → Camera → Formats → Most Compatible* on the phone, or send as JPG.
Emails from Glen / Domante / you are credited to that person (the list and
email addresses are the `people` setting:
`Ben <ben@film.works>, Glen <glen@film.works>, Domante <domante@film.works>`).

Files are stored in Drive under **Accounts — receipts & invoices /
&lt;company&gt; / &lt;month&gt;** (or *Unsorted* until the company is
known), renamed like `2026-09-05_Uber_£23.40.pdf`.

### Matching

Whenever you open the tab (or finish a statement), each receipt is matched
to the transaction with the **same amount** within a few days of its date
(bills: paid up to four months after the invoice). If there's exactly one
candidate, it's linked automatically; otherwise it's listed under
*Receipts to match* with the likely transactions first. When a receipt
shows VAT and the transaction was recorded without any, **the VAT is taken
from the receipt** — so budgets get the true ex-VAT cost.

- **Bills to pay** lists unpaid supplier invoices with due dates and
  overdue flags; each closes itself when its payment is matched.
- **Missing receipts** lists every card/bank payment without one, grouped
  by spender. *Email Glen* sends him the list (replies go to the accounts
  address, so his photos are filed automatically). Mark bank fees,
  salaries, HMRC etc. *not needed*.
- A **📎 receipt** link appears next to matched transactions in the cost report.

### Month end → accountant

Pick the month (or VAT quarter) and **Build accountant spreadsheet**. It
creates a Google Sheet in the company's Drive folder with:

- **Transactions** — date, account, spender, type, description, supplier,
  project, budget line, net, VAT, gross, supplier VAT number, a link to
  the receipt, and receipt status (✓ / MISSING / not needed)
- **Supplier bills** — paid (with date and account) or UNPAID
- **VAT summary** — output VAT on income, input VAT backed by a VAT
  receipt, input VAT with no valid receipt yet, and the net payable

**Email to accountant** shares the sheet and that company's receipts folder
with them (view only) and emails the link. Do it once per company.

## Where the data lives

Everything is in your Google Sheet:

| Tab | Contents |
|---|---|
| `Projects` | one row per project: name, client, budget total, fee, version |
| `Budget Lines` | one row per budget line: section, item, description, amount |
| `Companies` | one row per company: ID, name, short name, VAT number |
| `Accounts` | one row per bank/card account: ID, company, name, kind (`bank`/`amex`) |
| `Transactions` | one row per recorded transaction: date, description, amount (ex-VAT), gross, VAT, project, budget line, note, statement label, account, company, spender |
| `Documents` | one row per receipt / bill: kind, company, supplier, date, due date, amounts, VAT, VAT number, Drive link, matched transaction, status |
| `Settings` | app settings (currency symbol, `vatRate`, `people`, `sharedInbox`, `accountantEmail`) |

You can open the sheet any time (there's an *Open spreadsheet* link in the
app header), build your own pivot tables, or fix a typo directly in a cell.
Just don't rename the tabs or the header row.

## Updating the app later

If the code in this repository changes, paste the new contents into the same
two files in the script editor, then **Deploy → Manage deployments → ✏️ Edit →
Version: New version → Deploy**. The URL stays the same and your data is
untouched. New columns/tabs are added to your spreadsheet automatically.

## Repository layout

```
apps-script/
  Code.gs          server-side code (reads/writes the Google Sheet)
  Receipts.gs      email intake, Claude document reading, matching,
                   chase emails and the accountant pack
  Index.html       the web app UI (budget + statement parsing incl. Amex PDFs,
                   reconciliation, reports)
  appsscript.json  Apps Script manifest (only needed if you deploy with clasp)
README.md
```

Advanced: if you prefer deploying from the command line instead of
copy-pasting, [clasp](https://github.com/google/clasp) can push the
`apps-script/` folder straight to your script project.
