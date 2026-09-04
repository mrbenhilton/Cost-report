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
4. Everything is stored **directly in a Google Sheet you own**, so nothing is
   ever lost between sessions — the spreadsheet *is* the database, and you can
   always open it and see (or edit) your data.

The app runs as a **Google Apps Script web app** — hosted free by Google,
private to your Google account, no servers or API keys to manage.

## Setup (about 10 minutes, one time)

1. **Create the spreadsheet.** Go to [sheets.new](https://sheets.new) and name
   the spreadsheet something like `Project Cost Tracker`. Leave it empty — the
   app creates its own tabs (`Projects`, `Budget Lines`, `Transactions`,
   `Settings`) on first run.

2. **Open the script editor.** In that spreadsheet, choose
   **Extensions → Apps Script**. A script project opens in a new tab.

3. **Add the code.**
   - In the editor, select the `Code.gs` file, delete its contents, and paste
     in everything from [`apps-script/Code.gs`](apps-script/Code.gs).
   - Click **＋ (Add a file) → HTML**, name it exactly `Index`, delete the
     placeholder contents, and paste in everything from
     [`apps-script/Index.html`](apps-script/Index.html).
   - Click the **Save** icon (or Ctrl/Cmd-S).

4. **Deploy it as a web app.**
   - Click **Deploy → New deployment**.
   - Click the gear next to "Select type" and choose **Web app**.
   - Set *Execute as*: **Me**, and *Who has access*: **Only myself**.
   - Click **Deploy**, then **Authorize access** and approve the permissions
     (it only asks for access to your spreadsheets — the data never leaves
     your Google account).
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

## Monthly routine: reconcile the statement

1. In your online banking, export the month's statement as **CSV**.
2. Open the app → **Reconcile statement** → choose the file and give it a
   label like `July 2026`.
3. Check the column mapping. The app guesses date / description / amount, and
   a banner under the preview tells you **how many rows it can actually read
   before you start** — if a column is wrong it names the value it choked on,
   so you can fix the mapping instead of hitting a wall halfway through.
   What it copes with, verified against real Monzo Business, Revolut, Tide,
   Starling and Barclays exports:
   - **Any common delimiter** — comma, semicolon, tab or pipe — detected by
     parsing the file each way and keeping whichever gives consistent columns.
   - **Title and totals lines** above or below the table (Barclays and others
     add them) are recognised and ignored rather than being mistaken for the
     header row.
   - **Dates with a time attached** (`05/03/2024 14:22:31`,
     `2026-03-05 14:22:31`, ISO timestamps), weekday prefixes, `5th March`,
     `20240305` and Excel serial numbers all read correctly, on top of the
     usual UK/US day-month ordering.
   - **Amounts in any dress**: `(49.99)`, `49.99-`, `49.99 DR/CR`, a Unicode
     minus, `£`/`$`/`€` symbols, and both `1,234.56` and `1.234,56` grouping.
   - If a header name misleads (a "Date" column holding something else), the
     guess is **checked against the rows themselves** and re-picked from
     whichever column actually holds dates or money.
   - **Pot / savings transfers are left out.** See below — they're internal
     cashflow, not spend.
   - A **notes/reference column** (e.g. Monzo's "Notes and #tags") is
     picked up automatically: the note is shown on each card and prefills
     the "what was this for?" field — handy when it holds invoice numbers.
   - Card-payment **refunds** are money-in rows too — they get the income
     card; allocate them to the project they refund.
4. Step through each transaction: pick the project, pick the **budget line**
   (grouped by your budget's sections), optionally add a note, **Save & next**.

   **Pot and savings transfers are skipped entirely.** Pots — plain or
   savings — are sub-accounts of the same account, so moving money in or out
   of one isn't spend, income, or anything worth analysing. Both kinds carry
   the same `Pot transfer` type on the statement and are treated identically.
   They're **dropped at import: never queued, never stored, never in the
   report**, and the mapping step just tells you how many it left out. In a
   typical month that's 118 pot moves versus 60 real transactions — so the
   review is 60 cards, and the £577k shuffled between pots never distorts a
   figure. Tick *Include pot / savings transfers* if you ever want to see
   them. `Internal transfer` is also an option on every card, including
   money-in cards, for a pot move the statement's Type column doesn't label.

   Detection reads the statement's **Type** column only. Category won't do:
   Monzo files pot moves and genuine payments to other companies both under
   "Transfers", so keying off it would silently drop real costs.

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

   **← Back** returns to the previous transaction and reopens it exactly as
   you left it — project, budget line, category, note and VAT rate all
   restored, an income split rebuilt row by row. The button then reads
   *Update & next*, and saving **replaces** what that card stored rather than
   adding a second copy: the reconciliation can't be double-counted by
   correcting a mistake. Server-side, a replacement is validated before
   anything is removed and the new rows are written before the old ones are
   deleted, so an interrupted edit can leave a visible duplicate but never
   a hole.

**Re-uploading is safe.** Every transaction gets a fingerprint (date +
description + amount), so uploading the same statement twice never creates
duplicates — already-recorded transactions are silently skipped.

**Starting over.** Both resets live under **Reconcile statement → …or start
the transactions over**:

- **Delete recorded transactions** — clears the imports and leaves projects,
  budget lines and settings untouched, so you keep every budget you've
  uploaded. Expenses added by hand are kept too unless you tick the box.
- **Wipe everything** — a clean break: every project, every budget and all
  its lines, and every transaction. Currency and VAT settings survive, and
  Company Overheads is recreated empty. It asks you to type `ERASE`, and the
  server refuses the call without it, so it can't happen by accident.

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

## Where the data lives

Everything is in your Google Sheet:

| Tab | Contents |
|---|---|
| `Projects` | one row per project: name, client, budget total, fee, version |
| `Budget Lines` | one row per budget line: section, item, description, amount |
| `Transactions` | one row per recorded transaction: date, description, amount, project, budget line, note, statement label |
| `Settings` | app settings (currency symbol) |

You can open the sheet any time (there's an *Open spreadsheet* link in the
app header), build your own pivot tables, or fix a typo directly in a cell.
Just don't rename the tabs or the header row. Deleting rows from
`Transactions` by hand is also fine — that's all the in-app reset does — but
leave `Projects` and `Budget Lines` alone unless you mean to lose a budget.

## Updating the app later

If the code in this repository changes, paste the new contents into the same
two files in the script editor, then **Deploy → Manage deployments → ✏️ Edit →
Version: New version → Deploy**. The URL stays the same and your data is
untouched. New columns/tabs are added to your spreadsheet automatically.

## Repository layout

```
apps-script/
  Code.gs          server-side code (reads/writes the Google Sheet)
  Index.html       the web app UI (budget parsing, reconciliation, reports)
  appsscript.json  Apps Script manifest (only needed if you deploy with clasp)
README.md
```

Advanced: if you prefer deploying from the command line instead of
copy-pasting, [clasp](https://github.com/google/clasp) can push the
`apps-script/` folder straight to your script project.
