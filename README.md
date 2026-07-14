# Project Cost Tracker

A small web app for tracking project spending against budgets:

1. **Create projects** with a budget (e.g. a film, a client job).
2. **Upload a monthly bank statement** (CSV export from your online banking).
3. The app walks you through **each transaction one by one** and asks what it
   was for and which project it belongs to.
4. Everything is stored **directly in a Google Sheet you own**, so nothing is
   ever lost between sessions — the spreadsheet *is* the database, and you can
   always open it and see (or edit) your data.
5. The **Cost report** tab shows, per project: budget vs. spent, remaining,
   a category breakdown, and the full transaction list.

The app runs as a **Google Apps Script web app** — hosted free by Google,
private to your Google account, no servers or API keys to manage.

## Setup (about 10 minutes, one time)

1. **Create the spreadsheet.** Go to [sheets.new](https://sheets.new) and name
   the spreadsheet something like `Project Cost Tracker`. Leave it empty — the
   app creates its own tabs (`Projects`, `Transactions`, `Settings`) on first
   run.

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

That's it. Open the URL, add your first project, and you're ready for your
first statement.

## Monthly routine

1. In your online banking, export the month's statement as **CSV** (most banks
   have "Export" or "Download" → CSV on the transactions page).
2. Open the app → **Review statement** → choose the file and give it a label
   like `July 2026`.
3. Check the column mapping (the app guesses the date / description / amount
   columns and lets you correct them), then step through each transaction:
   say what it was for, pick a category, pick the project, **Save & next**.
   Payments that aren't project costs can be marked **Not project-related**;
   anything you're unsure about can be **skipped** and it will be offered
   again next time you upload that statement.
4. Open **Cost report** for the up-to-date picture per project.

**Re-uploading is safe.** Every transaction gets a fingerprint (date +
description + amount), so uploading the same statement twice never creates
duplicates — already-recorded transactions are silently skipped.

## Where the data lives

Everything is in your Google Sheet:

| Tab | Contents |
|---|---|
| `Projects` | one row per project: name, budget, notes |
| `Transactions` | one row per recorded transaction: date, description, amount, project, purpose, category, statement label |
| `Settings` | app settings (currency symbol) |

You can open the sheet any time (there's an *Open spreadsheet* link in the
app header), build your own pivot tables, or fix a typo directly in a cell.
Just don't rename the tabs or the header row. To change which project a
transaction belongs to, edit its `Project ID` / `Project Name` cells in the
sheet (copy the ID from the `Projects` tab), or delete the row in the app's
report view and re-upload the statement to review it again.

## Updating the app later

If the code in this repository changes, paste the new contents into the same
two files in the script editor, then **Deploy → Manage deployments → ✏️ Edit →
Version: New version → Deploy**. The URL stays the same and your data is
untouched.

## Repository layout

```
apps-script/
  Code.gs          server-side code (reads/writes the Google Sheet)
  Index.html       the web app UI
  appsscript.json  Apps Script manifest (only needed if you deploy with clasp)
README.md
```

Advanced: if you prefer deploying from the command line instead of
copy-pasting, [clasp](https://github.com/google/clasp) can push the
`apps-script/` folder straight to your script project.
