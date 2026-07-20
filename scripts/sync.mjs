// Node.js port of fetch_manga_stats.vbs — same logic, same file format,
// meant to run in GitHub Actions instead of Windows Task Scheduler.

import fs from 'node:fs';
import path from 'node:path';
import { createProvider } from './providers.mjs';

const DATA_FILE = path.join(process.cwd(), 'manga_history_data.js');
const ERROR_LOG = path.join(process.cwd(), 'sync_errors.log');
const STATUS_FILE = path.join(process.cwd(), 'sync_status.json');
const DAILY_BACKUP_DIR = path.join(process.cwd(), 'daily_backup');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const ANOMALY_THRESHOLD = 500; // flag jumps of this many chapters or more instead of trusting them
const KEEP_DAILY_BACKUPS = 30; // days of dated backups to retain before auto-deleting older ones

/* ── Provider configuration ────────────────────────────────────────────────
   Which site to read your chapter count from. Either edit the defaults here
   or set the matching repo variable (Settings → Secrets and variables →
   Actions → Variables) to override without touching this file.

     PROVIDER = 'kitsu'      → documented, stable public API. Recommended.
     PROVIDER = 'mangabaka'  → undocumented internal endpoint. Works, but see
                               the long warning at the top of providers.mjs:
                               it can break on any MangaBaka deploy.

   MANGABAKA_REMOTE_HASH is the part of the URL that goes stale. If MangaBaka
   redeploys, the sync tries to re-discover it automatically and tells you (in
   sync_errors.log and on the dashboard) to paste the new one in here. ------ */
const PROVIDER = (process.env.PROVIDER || 'mangabaka').toLowerCase().trim();
const KITSU_USER_ID = process.env.KITSU_USER_ID || '1699796';
const MANGABAKA_USERNAME = process.env.MANGABAKA_USERNAME || 'k_y';
const MANGABAKA_REMOTE_HASH = process.env.MANGABAKA_REMOTE_HASH || 'tweimu';

/* Switching providers changes the absolute chapter number (the two sites count
   differently), which looks exactly like a corrupt spike to the anomaly guard.
   Set ALLOW_PROVIDER_SWITCH=1 for the single run where you change PROVIDER,
   then remove it. ------------------------------------------------------- */
const ALLOW_PROVIDER_SWITCH = process.env.ALLOW_PROVIDER_SWITCH === '1';

function logError(msg) {
  const line = `[${new Date().toString()}] ${msg}\n`;
  fs.appendFileSync(ERROR_LOG, line);
  console.error(msg);
}

// Matches the VBS date format: "02-Jul-26 6:26:11 AM"
function formatVBSStyle(d) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dd = String(d.getDate()).padStart(2, '0');
  const mon = months[d.getMonth()];
  const yy = String(d.getFullYear()).slice(-2);
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${dd}-${mon}-${yy} ${h}:${mm}:${ss} ${ampm}`;
}

/* Written on EVERY run, success or failure, and committed by the workflow even
   when the sync step fails (the commit step is `if: always()`). The dashboard
   reads this file so a silently-broken provider shows up as a banner instead
   of just a chapter count that mysteriously stops moving. */
function writeStatus(fields) {
  const previous = readStatus();
  const status = {
    ok: true,
    provider: PROVIDER,
    lastRun: new Date().toISOString(),
    lastSuccess: previous.lastSuccess || null,
    error: null,
    hint: null,
    note: null,
    ...fields,
  };
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2) + '\n');
  } catch (err) {
    console.error(`WARNING: could not write ${STATUS_FILE} - ${err.message}`);
  }
}

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/* Fail loudly, but always leave a machine-readable breadcrumb behind first. */
function fail(message, hint) {
  logError(`SYNC FAILED - ${message}`);
  writeStatus({ ok: false, error: message, hint: hint || null });
  process.exit(1);
}

async function fetchChaptersWithRetry() {
  let provider;
  try {
    provider = createProvider({
      provider: PROVIDER,
      kitsuUserId: KITSU_USER_ID,
      mangabakaUsername: MANGABAKA_USERNAME,
      mangabakaHash: MANGABAKA_REMOTE_HASH,
    });
  } catch (err) {
    fail(err.message, 'Set PROVIDER to either "kitsu" or "mangabaka".');
  }

  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return { ...(await provider.fetchChapters()), provider };
    } catch (err) {
      lastError = err.message;
      logError(`Attempt ${attempt}/${MAX_RETRIES} failed (${provider.describe()}) - ${err.message}`);
    }
    if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }

  const hint =
    PROVIDER === 'mangabaka'
      ? 'MangaBaka uses an undocumented internal endpoint that moves whenever they ' +
        'redeploy. Open your profile page in a browser with DevTools → Network → ' +
        'Fetch/XHR, reload, click the getStatsOverview request, and copy the hash ' +
        'segment from its URL into MANGABAKA_REMOTE_HASH in scripts/sync.mjs. ' +
        'Switching PROVIDER back to "kitsu" also restores syncing immediately.'
      : 'Kitsu may be down or rate-limiting. This usually clears on its own; ' +
        'check that the Kitsu user ID is still correct if it persists.';

  fail(`after ${MAX_RETRIES} attempts - ${lastError}`, hint);
}

function loadExisting() {
  if (!fs.existsSync(DATA_FILE)) return [];
  const content = fs.readFileSync(DATA_FILE, 'utf8');
  const arrayMatch = content.match(/const mangaHistoryData\s*=\s*(\[[\s\S]*\]);/);
  if (!arrayMatch) return [];
  // The data file only ever contains data we generated ourselves, so this is safe.
  const build = new Function(`return ${arrayMatch[1]};`);
  return build();
}

function serialize(entries) {
  const lines = entries.map(
    (e) => `  { date1: "${e.date1}", date2: "${e.date2}", chapters: ${e.chapters} }`
  );
  return `const mangaHistoryData = [\n${lines.join(',\n')}\n];\n`;
}

function backup() {
  if (!fs.existsSync(DATA_FILE)) return;
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');

  if (!fs.existsSync(DAILY_BACKUP_DIR)) fs.mkdirSync(DAILY_BACKUP_DIR, { recursive: true });

  const dated = path.join(DAILY_BACKUP_DIR, `manga_history_data_${y}${m}${d}.bak.js`);
  const rolling = path.join(process.cwd(), 'manga_history_data.bak');
  try {
    fs.copyFileSync(DATA_FILE, rolling);
    fs.copyFileSync(DATA_FILE, dated);
  } catch (err) {
    logError(`WARNING: backup copy failed - ${err.message}`);
  }

  pruneOldBackups();
}

function pruneOldBackups() {
  if (!fs.existsSync(DAILY_BACKUP_DIR)) return;
  const cutoff = Date.now() - KEEP_DAILY_BACKUPS * 24 * 60 * 60 * 1000;
  const pattern = /^manga_history_data_(\d{4})(\d{2})(\d{2})\.bak\.js$/;

  for (const file of fs.readdirSync(DAILY_BACKUP_DIR)) {
    const match = file.match(pattern);
    if (!match) continue;
    const [, yy, mm, dd] = match;
    const fileDate = new Date(`${yy}-${mm}-${dd}T00:00:00`).getTime();
    if (fileDate < cutoff) {
      try {
        fs.unlinkSync(path.join(DAILY_BACKUP_DIR, file));
      } catch (err) {
        logError(`WARNING: failed to prune old backup ${file} - ${err.message}`);
      }
    }
  }
}

async function main() {
  const { chapters: units, note, provider } = await fetchChaptersWithRetry();
  const entries = loadExisting();
  const now = new Date();
  const fmt = formatVBSStyle(now);

  if (note) logError(`NOTICE - ${note}`);

  const succeed = (extra) => {
    writeStatus({
      ok: true,
      lastSuccess: new Date().toISOString(),
      chapters: units,
      note: note || null,
      ...extra,
    });
  };

  if (entries.length === 0) {
    entries.push({ date1: fmt, date2: fmt, chapters: units });
    fs.writeFileSync(DATA_FILE, serialize(entries));
    console.log(`Initialized data file with ${units} chapters from ${provider.describe()}.`);
    succeed();
    return;
  }

  const last = entries[entries.length - 1];
  const diff = units - last.chapters;

  if (diff >= ANOMALY_THRESHOLD && !ALLOW_PROVIDER_SWITCH) {
    fail(
      `ANOMALY - new value ${units} is ${diff} higher than last recorded ${last.chapters} ` +
        `(threshold ${ANOMALY_THRESHOLD}). Entry skipped - review manually before re-running.`,
      'If you just switched PROVIDER, this jump is expected: the two sites count ' +
        'differently. Re-run once with ALLOW_PROVIDER_SWITCH=1 to accept the new ' +
        'baseline, then remove it. Note that the jump will also show up as one ' +
        'huge reading day on your charts.'
    );
  }

  backup();

  if (units === last.chapters) {
    // Same number: just refresh the "last checked" timestamp on the final entry.
    last.date2 = fmt;
    console.log(`No new chapters. Updated last-checked time to ${fmt}.`);
  } else {
    entries.push({ date1: fmt, date2: fmt, chapters: units });
    console.log(`New entry: ${units} chapters at ${fmt}.`);
  }

  fs.writeFileSync(DATA_FILE, serialize(entries));
  succeed();
}

main().catch((err) => {
  // Nothing should reach here, but an unexpected crash must still leave a
  // status breadcrumb rather than freezing the dashboard silently.
  fail(`unexpected error - ${err && err.stack ? err.stack : err}`);
});
