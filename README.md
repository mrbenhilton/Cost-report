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

On the **Projects** tab, choose the budget file. PDFs are read in the
browser (the PDF reader library loads from a CDN, so this needs an internet
connection); CSV exports and pasted text work too. The app understands
budgets laid out like:

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
3. Check the column mapping (the app guesses date / description / amount and
   handles UK & US date formats, separate money-in/money-out columns, etc.).
4. Step through each transaction: pick the project, pick the **budget line**
   (grouped by your budget's sections), optionally add a note, **Save & next**.
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

Per project: an overall budget meter, then the reconciliation — every budget
line with **Budgeted, Actual and Remaining**, subtotals per section,
over-spent lines and overages flagged with ⚠, and the full transaction list
(with delete, in case something was mis-assigned).

The **Company Overheads** card lists the production-fee income from every
project, company expenses by category, and the net position — also shown as
an *Overheads net* tile at the top of the report.

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
  Index.html       the web app UI (budget parsing, reconciliation, reports)
  appsscript.json  Apps Script manifest (only needed if you deploy with clasp)
README.md
```

Advanced: if you prefer deploying from the command line instead of
copy-pasting, [clasp](https://github.com/google/clasp) can push the
`apps-script/` folder straight to your script project.
