/**
 * Main.gs
 * Purpose: Entry points only: the spreadsheet menu, menu handlers, the OAuth
 *          callback, and the two processes - run_fetchBills (bill lists) and
 *          run_downloadAttachments (attachments). No business logic here.
 * Depends on: Config.gs, Utils.gs, Service_*.gs
 * Last updated: 2026-10-02 (separate fetch / download)
 */

/**
 * Adds the Xero Bills menu.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Xero Bills")
    .addItem("Set up sheets", "setupSheets")
    .addSeparator()
    .addItem("Connect entity…", "connectEntity")
    .addItem("Check connection…", "checkConnection")
    .addItem("Disconnect entity…", "disconnectEntity")
    .addItem("Show redirect URI", "showRedirectUri")
    .addSeparator()
    .addItem("Fetch Xero bills", "fetchBillsNow")
    .addItem("Download attachments now", "downloadAttachmentsNow")
    .addSeparator()
    .addItem("Install attachment schedule", "installSchedule")
    .addItem("Remove schedules", "removeSchedule")
    .addToUi();
}

/**
 * Menu: creates or repairs the Jobs / Entities sheets and Drive folders.
 */
function setupSheets() {
  try {
    setupControlSheets_();
    SpreadsheetApp.getActiveSpreadsheet().toast(
      "Sheets and folders are ready.",
      "Xero Bills",
      5,
    );
  } catch (error) {
    logError_("setupSheets", error);
    SpreadsheetApp.getUi().alert(error.message);
  }
}

/**
 * Menu: asks for an entity key and opens the Xero consent link.
 */
function connectEntity() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    "Connect a Xero entity",
    "Entity key (e.g. FOBE):",
    ui.ButtonSet.OK_CANCEL,
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const entity = response.getResponseText().trim().toUpperCase();
  try {
    ui.showModalDialog(buildConnectDialog_(entity), `Connect ${entity}`);
  } catch (error) {
    logError_("connectEntity", error);
    ui.alert(error.message);
  }
}

/**
 * Menu: fills in an entity's Tenant ID from its saved token (no re-consent needed).
 */
function checkConnection() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    "Check a Xero connection",
    "Entity key (e.g. FOBE):",
    ui.ButtonSet.OK_CANCEL,
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const entity = response.getResponseText().trim().toUpperCase();
  try {
    ui.alert(refreshEntityTenant_(entity));
  } catch (error) {
    logError_("checkConnection", error);
    ui.alert(error.message);
  }
}

/**
 * Menu: disconnects one entity at Xero and forgets its tokens.
 */
function disconnectEntity() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    "Disconnect a Xero entity",
    "Entity key (e.g. SFJO):",
    ui.ButtonSet.OK_CANCEL,
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const entity = response.getResponseText().trim().toUpperCase();
  const confirm = ui.alert(
    `Disconnect ${entity}?`,
    "This removes the app's access to this organisation in Xero. Other organisations stay connected.",
    ui.ButtonSet.YES_NO,
  );
  if (confirm !== ui.Button.YES) return;
  try {
    ui.alert(disconnectXeroEntity_(entity));
  } catch (error) {
    logError_("disconnectEntity", error);
    ui.alert(error.message);
  }
}

/**
 * Menu: shows the redirect URI to add to the Xero app.
 */
function showRedirectUri() {
  SpreadsheetApp.getUi().alert(
    "Add this as an OAuth 2.0 redirect URI on your Xero app (developer.xero.com/myapps → Configuration):\n\n" +
      getXeroRedirectUri_(),
  );
}

/**
 * Menu: runs the "Fetch Xero bills" process now. Unfinished jobs continue
 * automatically through a one-off follow-up trigger.
 */
function fetchBillsNow() {
  SpreadsheetApp.getActiveSpreadsheet().toast(
    run_fetchBills(),
    "Fetch Xero bills",
    10,
  );
}

/**
 * Menu: runs one "Download attachments" pass now.
 */
function downloadAttachmentsNow() {
  SpreadsheetApp.getActiveSpreadsheet().toast(
    run_downloadAttachments(),
    "Download attachments",
    10,
  );
}

/**
 * Menu: (re)creates the recurring attachments trigger and removes old-style triggers.
 */
function installSchedule() {
  try {
    removeTriggersFor_(
      [TRIGGER_HANDLERS.DOWNLOAD_ATTACHMENTS].concat(TRIGGER_HANDLERS.LEGACY),
    );
    ScriptApp.newTrigger(TRIGGER_HANDLERS.DOWNLOAD_ATTACHMENTS)
      .timeBased()
      .everyMinutes(RUN.TRIGGER_INTERVAL_MINUTES)
      .create();
    SpreadsheetApp.getActiveSpreadsheet().toast(
      `Attachments are downloaded every ${RUN.TRIGGER_INTERVAL_MINUTES} minutes.`,
      "Xero Bills",
      5,
    );
  } catch (error) {
    logError_("installSchedule", error);
    SpreadsheetApp.getUi().alert(error.message);
  }
}

/**
 * Menu: removes the attachments schedule and any pending bill-fetch follow-ups.
 */
function removeSchedule() {
  removeTriggersFor_(
    [
      TRIGGER_HANDLERS.DOWNLOAD_ATTACHMENTS,
      TRIGGER_HANDLERS.FETCH_BILLS,
    ].concat(TRIGGER_HANDLERS.LEGACY),
  );
  SpreadsheetApp.getActiveSpreadsheet().toast(
    "All schedules and follow-ups removed.",
    "Xero Bills",
    5,
  );
}

/**
 * Deletes every project trigger whose handler is in the list.
 * @param {Array<string>} handlerNames - Function names.
 */
function removeTriggersFor_(handlerNames) {
  ScriptApp.getProjectTriggers()
    .filter((t) => handlerNames.includes(t.getHandlerFunction()))
    .forEach((t) => ScriptApp.deleteTrigger(t));
}

/**
 * Replaces any pending bill-fetch follow-up with one at the given time.
 * @param {Date} when - When the follow-up should run.
 */
function scheduleBillsContinuation_(when) {
  removeTriggersFor_([TRIGGER_HANDLERS.FETCH_BILLS]);
  ScriptApp.newTrigger(TRIGGER_HANDLERS.FETCH_BILLS)
    .timeBased()
    .at(when)
    .create();
  logInfo_(
    "scheduleBillsContinuation_",
    `Bill fetch continues at ${when.toISOString()}`,
  );
}

/**
 * OAuth2 library callback (name is referenced by setCallbackFunction).
 * @param {Object} request - Callback request.
 * @return {GoogleAppsScript.HTML.HtmlOutput} Result page.
 */
function authCallback(request) {
  try {
    return handleXeroAuthCallback_(request);
  } catch (error) {
    logError_("authCallback", error);
    return HtmlService.createHtmlOutput(
      `Connection failed: ${escapeHtml_(error.message)}`,
    );
  }
}

/**
 * Process 1 - Fetch Xero bills: turns queued Jobs rows into bills spreadsheets.
 * Called from the menu and by its own one-off follow-up triggers, which keep
 * it going until every queued job is listed (or waiting on Xero's daily limit).
 * @return {string} Short summary for the toast.
 */
function run_fetchBills() {
  const outcome = runWithLock_("run_fetchBills", (ctx) => runBillJobs_(ctx));

  if (outcome.busy) {
    scheduleBillsContinuation_(
      new Date(Date.now() + BILLS.CONTINUATION_DELAY_MS),
    );
    return "Another run is active, so fetching starts automatically in about a minute.";
  }
  if (outcome.failed) {
    removeTriggersFor_([TRIGGER_HANDLERS.FETCH_BILLS]);
    return "Fetching stopped with an unexpected error: see the email or Executions log.";
  }

  const pages = `${outcome.ctx.stats.billPages} Xero page(s) fetched.`;
  if (outcome.moreWork) {
    scheduleBillsContinuation_(
      new Date(Date.now() + BILLS.CONTINUATION_DELAY_MS),
    );
    return `${pages} More to do: continuing automatically in about a minute.`;
  }
  if (outcome.resumeAt) {
    scheduleBillsContinuation_(outcome.resumeAt);
    return `${pages} Waiting for Xero's daily limit; resumes around ${outcome.resumeAt.toLocaleString()}.`;
  }
  removeTriggersFor_([TRIGGER_HANDLERS.FETCH_BILLS]);
  return `${pages} All queued jobs are listed: see the Jobs sheet.`;
}

/**
 * Process 2 - Download attachments: works through completed bills files in the
 * "bills" folder. Called from the menu and by the recurring schedule.
 * @return {string} Short summary for the toast.
 */
function run_downloadAttachments() {
  const outcome = runWithLock_("run_downloadAttachments", (ctx) => {
    runAttachmentQueue_(ctx);
  });
  if (outcome.busy) return "Another run is active; try again in a few minutes.";
  const stats = outcome.ctx.stats;
  return (
    `Bills processed: ${stats.billsProcessed}, files saved: ${stats.filesDownloaded}, ` +
    `errors: ${outcome.ctx.errors.length}.`
  );
}

/**
 * Runs one process under the shared script lock (so the two processes never
 * overlap or race on Xero tokens), then sends failure / completion emails.
 * @param {string} name - Process name for logs.
 * @param {function(Object): Object} work - Receives the run context; may return extra fields.
 * @return {Object} {busy, failed, ctx, ...fields returned by work}.
 */
function runWithLock_(name, work) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(RUN.LOCK_WAIT_MS)) {
    logInfo_(name, "Another run is still active; skipping.");
    return { busy: true };
  }

  const ctx = buildRunContext_();
  let result = {};
  let failed = false;
  try {
    result = work(ctx) || {};
  } catch (error) {
    logError_(name, error);
    ctx.errors.push(`Unexpected error in ${name}: ${error.message}`);
    failed = true;
  } finally {
    lock.releaseLock();
  }

  if (ctx.errors.length) notifyAdminOnFailure_(ctx.errors.join("\n"));
  sendCompletionSummary_(ctx.completed);
  logInfo_(name, JSON.stringify(ctx.stats));
  return Object.assign({ busy: false, failed: failed, ctx: ctx }, result);
}
