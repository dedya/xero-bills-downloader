# Xero Bills & Attachments Downloader (Google Apps Script)

This is the Apps Script version of the Python tools. It runs from a **control Google Sheet**. It writes each bill list to a Google Sheet in a `bills` folder, downloads attachments into an `attachments` folder in Drive, and moves each bills file to `processed bills` once every row is done.

There are two separate processes:

```
Process 1 - Fetch Xero bills          (menu; continues itself until done)
Control sheet (Jobs row)  ──►  bills/<ENTITY>_xero_accpay_bills_<period>_<timestamp>   (Google Sheet)
                                        │
Process 2 - Download attachments       (menu, or the schedule every 10 min)
                                        ▼
                               attachments/<bills file name>/<yymmdd>_<amount>_<contact>/…
                                        │  every row marked Yes / Failed
                                        ▼
                               processed bills/<bills file>
```

## Files

| File                     | Job                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `Main.gs`                | Menu, OAuth callback, the two processes `run_fetchBills` and `run_downloadAttachments` |
| `Config.gs`              | All constants, column layouts, statuses, Script Property getters                       |
| `Utils.gs`               | Logging, emails, time budget, rate limiter, error types, date/text helpers             |
| `Service_Xero.gs`        | OAuth2 per entity, connect/disconnect, fetch wrapper, bills and attachments endpoints  |
| `Service_Control.gs`     | Jobs and Entities sheets                                                               |
| `Service_Bills.gs`       | Bills download jobs, Job Info sheet                                                    |
| `Service_Attachments.gs` | Attachment queue, row marking, final move                                              |
| `Service_Drive.gs`       | Folders and file moves                                                                 |
| `Tests.gs`               | Manual checks run from the editor                                                      |

## Setup (once)

1. Create a Google Sheet in the Drive folder where the `bills`, `attachments` and `processed bills` folders should live. Then open **Extensions → Apps Script**.
2. In **Project Settings**, tick _Show "appsscript.json"_. Paste in `appsscript.json` and add every `.gs` file.
   - The `OAuth2` library is Google's `apps-script-oauth2`. If saving complains about the version, remove the library entry, add it again under **Libraries** with the ID in the manifest, and pick the latest version.
3. In **Project Settings → Script Properties**, add:
   - `XERO_CLIENT_ID` and `XERO_CLIENT_SECRET`. You can reuse the Python tool's Xero app. If one entity needs a different app, set `XERO_CLIENT_ID_<ENTITY>` and `XERO_CLIENT_SECRET_<ENTITY>`.
   - `ROOT_FOLDER_ID` (optional): use a folder other than the control sheet's own.
   - `NOTIFY_EMAIL` (optional): where failure and completion emails go. The default is the script owner.
4. Reload the sheet and run **Xero Bills → Set up sheets**.
5. Run **Xero Bills → Show redirect URI**. Add that URI to the Xero app at developer.xero.com/myapps → Configuration. It sits alongside `http://localhost:8080/callback`, so the Python tool keeps working.
6. Run **Xero Bills → Connect entity…** for each entity (FOBE, SFHK, SFJO). After consent, the script reads Xero's connections and writes the **Tenant ID** to the Entities sheet:
   - If exactly one organisation is connected, it's used.
   - If several are connected, put the organisation name in **Tenant Name**, or paste the ID straight into **Tenant ID** (for example from the Python `xero_config.json`). Then run **Xero Bills → Check connection…**. This fills in the Tenant ID from the saved token, with no new consent needed.
7. Run **Xero Bills → Install attachment schedule** if you want attachments downloaded automatically. If you used an earlier version, run it once anyway: it removes the old `run_scheduledTick` trigger.

## Using it

Add a row to **Jobs**:

| Column              | Example                     | Notes                                                                             |
| ------------------- | --------------------------- | --------------------------------------------------------------------------------- |
| Entity              | `FOBE`                      | Dropdown from Entities                                                            |
| Period              | `2026` or `2026-03`         | Or leave blank and use Date From / Date To. Leave all three blank for every bill. |
| Date From / Date To | `2025-01-01` / `2025-06-30` | Both or neither                                                                   |
| Tracking Category   | `Project`                   | Optional                                                                          |
| Tracking Options    | `Project A, Project B`      | Optional, comma-separated. A bill is kept if **any** line matches.                |
| Status              | blank or `Pending`          | The script fills in the rest                                                      |

Then:

1. **Xero Bills → Fetch Xero bills** creates the bills spreadsheet for every queued row. If a job needs longer than one run (about 4½ minutes), it schedules a one-off follow-up a minute later and keeps going until every queued row is listed. If it hits Xero's daily limit, the follow-up is set for when the limit resets. Rows you add later need another click.
2. **Xero Bills → Download attachments now**, or the attachment schedule, works through the finished bills files.

The two processes share a lock, so they never run at the same time. If you click one while the other is busy, Fetch Xero bills starts itself a minute later; Download attachments asks you to try again.

Status moves through:
`Downloading bills` → `Attachments queued` → `Downloading attachments` → `Done`
(`Paused (Xero daily limit)` and `Error` can appear along the way.)

**Bill list rules:**

- Bills with a total of **0 are excluded** (`BILLS.EXCLUDE_ZERO_AMOUNT`). The number excluded is recorded in Job Info and in the job's Message.
- **No bills found** isn't an error. The job goes straight to `Done` with a message such as _No bills found in Xero for FOBE, 2026-09._ The empty list is moved to `processed bills` as a record of the search.

**Bills file:** two sheets.

- **ACCPAY Bills** has the same columns as the Python output, plus _Xero Status_ and _Description_. Description holds the bill's line-item descriptions, one per line. Attachment tracking goes in columns K–P: Total Attachments (from Xero), Linked Files (Drive links found in the description), Attachments Processed (`Yes` / `Failed`), Attachments Folder, Attempts, Last Error.
- **Job Info** records the filters used and the download and attachment status. Only files whose Job Info says `Download Status = Complete` are picked up for attachments.

## Drive links in descriptions

Some bills have no Xero attachment and put the invoice link in the description instead, e.g. `Invoice : https://drive.google.com/open?id=…`. Any Google Drive or Docs link found there is copied into the bill's folder next to the Xero attachments:

- These link formats are recognised: `open?id=`, `uc?id=`, `/file/d/`, `/document/d/`, `/spreadsheets/d/` and `/presentation/d/`. Shortcuts are followed.
- Google Docs, Sheets and Slides are saved as **PDF** (`ATTACHMENTS.EXPORT_GOOGLE_FILES_AS_PDF`). Other files, such as PDFs and images, are copied as they are.
- The copy runs as the script owner, so **the owner must have access to the linked file**. If not, the row's Last Error says which file to share, and it's retried up to 3 times before being marked `Failed`.
- Folder links aren't downloaded. They're noted in Last Error, and the bill is still marked `Yes`.
- Turn the feature off with `ATTACHMENTS.DOWNLOAD_DESCRIPTION_LINKS = false`.

## How it handles Apps Script's limits

- **6-minute executions.** Each run stops itself after about 4½ minutes. Bill downloads save the next page number on the Jobs row. Attachment progress is saved on each bill row. The next run continues from there, so there's no `--resume` flag.
- **No overlapping runs.** A script lock means the trigger never runs twice at once. That protects the rotating refresh tokens and keeps calls under Xero's 60 per minute.
- **Xero daily limit (5,000 calls per organisation).** The entity is paused until Retry-After expires, and other entities carry on. Throughput is the same as the Python tool: about 1,500 bills with attachments per organisation per day.
- **Interrupted bills.** Files already in a bill's folder are skipped, so nothing downloads twice.
- **Persistent failures.** A bill is retried 3 times (`ATTACHMENTS.MAX_ROW_ATTEMPTS`), then marked `Failed` with the reason. This stops one broken bill from holding back the whole file. To retry it, clear its _Attachments Processed_ cell and move the file back to `bills`.
- **Google quotas.** On Workspace you get 6 hours of trigger runtime and 100,000 URL fetches a day, well above what Xero's limit allows. Attachments over 50 MB can't be fetched by Apps Script and end up `Failed`.

## Differences from the Python version

- Credentials and tokens live in Script Properties, not `xero_config.json`. Anyone with **edit access to the script** can read them, so keep the project's editors to the people who need it.
- Bills with no attachments don't get an empty folder: they show `0` in Total Attachments. Set `ATTACHMENTS.CREATE_EMPTY_FOLDERS = true` for the old behaviour.
- Attachments are grouped per bills file (`attachments/<bills file>/…`). Set `ATTACHMENTS.GROUP_BY_BILLS_FILE = false` for one flat folder.
- **Disconnect** removes only that organisation's connection (like `--connection-only`). It never revokes the whole grant, because the same app may also serve the Python tool.
