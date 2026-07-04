# 📖 Manga Pace Ledger

A self-updating dashboard that tracks manga chapters read (via [Kitsu](https://kitsu.io)), synced automatically in the cloud and viewable from any device — no PC required to be on.

**[→ View the live tracker](https://iky0ff.github.io/manga-pace-ledger/manga-pace-ledger.html)**

---

## Table of contents

- [Introduction](#introduction)
- [How it works](#how-it-works)
- [Repo structure](#repo-structure)
- [The sync logic](#the-sync-logic)
- [⚠️ Warnings & things to know](#️-warnings--things-to-know)
- [Setup](#setup)
  - [Option A — GitHub Actions only](#option-a--github-actions-only-simplest)
  - [Option B — GitHub Actions + an external cron pinger](#option-b--github-actions--an-external-cron-pinger-more-frequent-updates)
  - [Option C — Manual (local) only](#option-c--manual-local-only-no-automation)
- [Switching sync modes](#switching-sync-modes)
- [Pointing it at your own Kitsu account](#pointing-it-at-your-own-kitsu-account)
- [Customizing](#customizing)
- [More / notes](#more--notes)

---

## Introduction

This project turns a Kitsu reading profile into a small, self-hosted analytics dashboard: streaks, pace, goals, and charts, rebuilt automatically every time your chapter count changes. There's no backend to run and no server to maintain — GitHub hosts the page and GitHub Actions does the polling, so the tracker keeps itself current even if your own computer is off.

It was ported from a Windows Task Scheduler + VBS script (`fetch_manga_stats.vbs`, still included) into a small Node script (`scripts/sync.mjs`) that runs on GitHub's infrastructure instead of a personal machine.

---

## How it works

```mermaid
flowchart TD
    A["Kitsu API<br/>(chapter stats)"] -- "polled on a schedule" --> B["GitHub Actions<br/>scripts/sync.mjs"]
    B -- "commits + pushes" --> C["manga_history_data.js"]
    C -- "served by" --> D["GitHub Pages<br/>manga-pace-ledger.html"]
    D --> E["💻 PC browser"]
    D --> F["📱 Phone browser"]
```

A scheduled GitHub Actions workflow polls the Kitsu API, compares the result to the last recorded chapter count, and commits an update to `manga_history_data.js` if anything changed. GitHub Pages serves the dashboard straight from the repo, so opening the same URL on a laptop or a phone always shows current data.

---

## Repo structure

| Path | Purpose |
|---|---|
| `manga-pace-ledger.html` | The dashboard — charts, streaks, goals, pace stats. Reads `manga_history_data.js` on load. |
| `manga_history_data.js` | The data file. An array of `{ date1, date2, chapters }` entries; overwritten in place by the sync. |
| `scripts/sync.mjs` | Node script that fetches Kitsu, parses the chapter count, and appends/updates an entry. |
| `.github/workflows/sync.yml` | Scheduled workflow that runs `sync.mjs` and commits the result. |
| `manga_history_data.bak` | Rolling backup — last version of the data file before the most recent write. Always overwritten in place, so it never grows. |
| `daily_backup/manga_history_data_YYYYMMDD.bak.js` | One dated backup per day, refreshed on same-day reruns. Auto-pruned after 30 days — see [below](#the-sync-logic). |
| `sync_errors.log` | Timestamped log of failed fetches, parse errors, or skipped anomalies. Empty/absent when everything's healthy. |
| `local-fallback/fetch_manga_stats.vbs` | Original Windows script this was ported from. Only relevant if you want to run the sync locally instead of via GitHub Actions — not needed for the automated flow. |
| `favicons/` | Site favicon set (browser tab / home-screen icon) — `favicon.ico` plus PNGs at several sizes. |
| `.nojekyll` | Empty marker file that tells GitHub Pages to skip Jekyll processing, since this is a plain static site. |
| `LICENSE` | MIT license — see the file itself for the full terms. |

---

## The sync logic

Each run:

1. Fetches `https://kitsu.io/api/edge/users/<KITSU_USER_ID>/stats` with a cache-busting query param, retrying up to **3 times** on failure.
2. Locates the `manga-amount-consumed` stat and extracts its `units` value.
3. Compares it to the last recorded chapter count:
   - **Same value** → just refreshes the "last checked" timestamp on the final entry.
   - **Higher value, normal jump** → backs up the data file (rolling `.bak` + a dated copy in `daily_backup/`), then appends a new entry.
   - **Jump of 500+ chapters** (configurable) → treated as a probable bad API response, not a real reading binge. Logged as an anomaly and **skipped** rather than written.
4. Prunes any file in `daily_backup/` older than `KEEP_DAILY_BACKUPS` (default **30 days**), so the folder doesn't grow forever.
5. Commits and pushes only if something actually changed — no empty commit spam. This step runs even if the fetch/parse failed above, so a failure still gets its explanation committed to `sync_errors.log` instead of being lost when the runner shuts down.

---

## ⚠️ Warnings & things to know

- **This is hardcoded to one Kitsu account by default.** See [Pointing it at your own Kitsu account](#pointing-it-at-your-own-kitsu-account) below — you must update the user ID in two places before forking, or you'll be tracking someone else's reading progress.
- **GitHub Actions' own schedule is not exact.** GitHub explicitly does not guarantee cron jobs run on time — during high load, a scheduled run can be delayed anywhere from a couple of minutes to much longer. If you need tighter timing, use [Option B](#option-b--github-actions--an-external-cron-pinger-more-frequent-updates) below.
- **Very short intervals aren't reliable either way.** GitHub won't run scheduled workflows more often than about every 5 minutes, and pushing much below that (via an external pinger or otherwise) increases the risk of overlapping/delayed runs. `sync.yml` already sets `concurrency` so overlapping runs queue instead of racing each other, but there's no reason to poll faster than your reading pace changes.
- **Never commit a token to the repo.** Whether you use GitHub's built-in scheduler or an external cron service, any Personal Access Token (PAT) belongs only in that external service's own secret/credential storage — never in a workflow file, a commit, or anywhere public. If you ever paste a token into a screenshot, chat, or issue by mistake, treat it as compromised and revoke it immediately from **GitHub → Settings → Developer settings → Personal access tokens**.
- **Scope tokens minimally.** A PAT used only to trigger this workflow needs at most `repo` (classic) or `Actions: Read and write` + `Contents: Read and write` (fine-grained) — it doesn't need full account access.
- **Public repo required for the free tier.** GitHub Pages and unlimited Actions minutes on the free plan require a public repository. Don't put anything you want private in this repo.
- **Running both GitHub's schedule and an external pinger at once means more total runs than either alone.** Not harmful (`concurrency` prevents overlap, and unchanged data just refreshes a timestamp), but it does burn more Actions minutes than necessary. If you only want one source of truth for timing, set `SYNC_MODE` accordingly — see [Switching sync modes](#switching-sync-modes).
- **A red ❌ run in the Actions tab doesn't necessarily mean something's broken.** The workflow intentionally fails (non-zero exit) when a fetch fails after all retries, or when an anomalous jump is detected and skipped — that's the script correctly refusing to write bad data, not a crash. Check `sync_errors.log` in the repo for the actual reason before assuming something needs fixing.

---

## Setup

There are two ways to run the sync. Both use the exact same workflow and script — the only difference is *what triggers it*.

### Option A — GitHub Actions only (simplest)

GitHub runs the workflow itself on the schedule defined in `.github/workflows/sync.yml`. No external service, no extra credentials to manage.

1. Push this repo to GitHub (public, so Pages + Actions minutes are free).
2. **Settings → Pages** → Source: `main` branch, `/ (root)` → Save. This gives you the public dashboard URL.
3. **Settings → Actions → General → Workflow permissions** → set to **Read and write permissions**, so the workflow is allowed to push commits.
4. **Actions tab → Sync Kitsu Manga Stats → Run workflow** to trigger a manual test run and confirm it commits successfully.
5. Sit back — it runs automatically from then on, on the cron schedule already defined in `sync.yml`.

This is enough for most people. Skip straight to [Pointing it at your own Kitsu account](#pointing-it-at-your-own-kitsu-account).

### Option B — GitHub Actions + an external cron pinger (more frequent updates)

Because GitHub's own scheduler can lag under load, you can instead have a third-party cron service call GitHub's API to trigger the workflow (`workflow_dispatch`) on its own schedule — independent of GitHub's queue. This is purely optional and only worth doing if you want tighter, more predictable timing. Any cron-as-a-service tool that can send an HTTP request works (e.g. [cron-job.org](https://cron-job.org)); the steps below use it as an example.

1. **Create a fine-scoped GitHub token** (don't reuse a broad personal token):
   - Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
   - Restrict it to **this repository only**.
   - Under permissions, grant **Contents: Read and write** and **Actions: Read and write** — nothing else.
   - Set an expiration date and copy the token somewhere safe (you'll only see it once).
2. **Create an account on your chosen cron service** (e.g. cron-job.org) and create a new cron job with:
   - **URL:** `https://api.github.com/repos/<your-username>/<your-repo>/actions/workflows/sync.yml/dispatches`
   - **Request method:** `POST`
   - **Request body:** `{"ref":"main"}`
   - **Headers:**
     | Key | Value |
     |---|---|
     | `Accept` | `application/vnd.github+json` |
     | `Authorization` | `Bearer <your-token-here>` |
     | `Content-Type` | `application/json` |
     | `X-GitHub-Api-Version` | `2022-11-28` |
   - **Schedule:** whatever interval you want (e.g. every 15 minutes). Don't go below ~5 minutes — see the warnings above.
3. Save and run the job once manually to confirm it returns a `204 No Content` response and that a new run appears in your repo's **Actions** tab.
4. Decide whether you want GitHub's own `schedule:` trigger to stay active alongside the external pinger, or to switch it off so only the cron service drives the sync — see [Switching sync modes](#switching-sync-modes) below.

> Paste your own token into the cron service's own credential field only — never into this repo, a commit, or anywhere that ends up public. If a token is ever exposed, revoke it immediately and generate a new one.

### Option C — Manual (local) only, no automation

If you'd rather not have anything running on GitHub's infrastructure at all, you can run the exact same script by hand:

1. Install [Node.js](https://nodejs.org) 18 or later (the script uses the built-in `fetch`, no `npm install` needed).
2. Clone the repo and, from its root, run:
   ```
   node scripts/sync.mjs
   ```
3. This updates `manga_history_data.js` (and its backups) locally, exactly like the GitHub Action would.
4. Commit and push the changes yourself: `git add -A && git commit -m "manual sync" && git push`.
5. Set the repo variable `SYNC_MODE` to `manual` (see [Switching sync modes](#switching-sync-modes)) so GitHub doesn't also try to run it automatically in parallel.

Note that with this option, GitHub Pages will only show updates whenever you remember to run the script and push — there's no "self-updating" without at least one of the automated options above.

---

## Switching sync modes

The workflow supports four modes, controlled by a single repository variable — no editing of `sync.yml` required to switch between them.

| Mode | What runs the sync | When to use it |
|---|---|---|
| **Manual (local)** | Nothing automatic — you run `node scripts/sync.mjs` on your own machine whenever you want | You don't want anything running on GitHub's infrastructure at all |
| **GitHub only** | GitHub's own `schedule:` trigger in `sync.yml` | Simplest cloud setup — no external service, accept GitHub's scheduling delays (see [warnings](#️-warnings--things-to-know)) |
| **Cron website only** | Only an external call to the `workflow_dispatch` API (e.g. from cron-job.org) | You've set up [Option B](#option-b--github-actions--an-external-cron-pinger-more-frequent-updates) and want tighter timing, without GitHub's own schedule also firing in parallel |
| **GitHub and cron** | Both — GitHub's schedule *and* the external pinger | Belt-and-suspenders: the external pinger provides consistent timing, GitHub's own schedule acts as a fallback if the external service ever goes down |

### How to set it

1. Go to your repo's **Settings → Secrets and variables → Actions → Variables tab → New repository variable**.
2. Name it `SYNC_MODE`.
3. Set the value to one of: `manual`, `github`, `cron`, `both`.
4. Save. The next time the workflow would run, it reads this variable and decides whether to actually execute.

If `SYNC_MODE` is never created, the workflow defaults to `both` — matching the original out-of-the-box behavior, so nothing breaks if you skip this step entirely.

### How it actually works

`sync.yml`'s `schedule:` trigger still fires on GitHub's cron no matter what — GitHub doesn't let you conditionally register a trigger. What changes based on `SYNC_MODE` is a job-level `if:` check at the very top of the job: when the mode says "don't run this trigger," the job is skipped instantly, before checkout or Node setup even happen. Skipped jobs cost effectively nothing in Actions minutes, so leaving the schedule trigger physically present in the file is harmless even when you're not using it.

For **Manual (local)** mode specifically, both the `schedule` and `workflow_dispatch` triggers are blocked — including the "Run workflow" button in the Actions tab. If you ever want to do a one-off cloud test run while in this mode, temporarily switch `SYNC_MODE` to something else, run it, then switch back.

Note: the **"⇅ Check Live"** button on the dashboard itself is a separate, unrelated feature — it does a one-off client-side check straight from your browser and only affects what you see locally in that browser tab. It works regardless of which `SYNC_MODE` you're in.

---

## Pointing it at your own Kitsu account

The Kitsu user ID is baked directly into the URL in **three places** — anyone forking this repo needs to change all of them, or it'll keep syncing the original owner's chapter count, not yours:

| File | Line |
|---|---|
| `scripts/sync.mjs` | `const KITSU_URL = 'https://kitsu.io/api/edge/users/<KITSU_USER_ID>/stats';` |
| `manga-pace-ledger.html` | inside `checkForUpdates()`: `fetch('https://kitsu.io/api/edge/users/<KITSU_USER_ID>/stats?cachebuster=...')` |
| `local-fallback/fetch_manga_stats.vbs` | `url = "https://kitsu.io/api/edge/users/<KITSU_USER_ID>/stats?cachebuster=" & timestamp` — only relevant if you plan to use the Windows fallback script |

**To point it at your own account:**

1. Find your Kitsu user ID — go to `https://kitsu.io/api/edge/users?filter[slug]=YOUR_USERNAME` in a browser (or check your profile URL/page source) and copy the numeric `id` field.
2. Replace the placeholder ID with that number in the files above (at minimum the first two; the third only if you use the VBS fallback).
3. Since your reading history will start from zero, either let `manga_history_data.js` reinitialize on the next sync (delete its contents and start fresh) or manually seed it with your own historical data in the same `{ date1, date2, chapters }` format.

Note: `scripts/sync.mjs` will auto-create `manga_history_data.js` with a single starting entry if the file doesn't exist yet, so deleting it entirely before the first run on a new account works fine.

---

## Customizing

### Adjusting the schedule

The cron in `sync.yml` controls how often GitHub itself checks for updates. Edit the `cron` line to change frequency — GitHub won't reliably run schedules more often than every ~5 minutes, and very short intervals increase the chance of overlapping/delayed runs. If you're using [Option B](#option-b--github-actions--an-external-cron-pinger-more-frequent-updates), the external service's own schedule is what actually determines real-world frequency; the workflow's `schedule:` trigger then just acts as a backup.

### Adjusting the anomaly threshold

`ANOMALY_THRESHOLD` in `scripts/sync.mjs` (default `500`) controls how big a single jump in chapter count can be before it's flagged instead of trusted. Raise it if you binge-read in large batches; lower it if you want tighter guardrails.

### Adjusting backup retention

`KEEP_DAILY_BACKUPS` in `scripts/sync.mjs` (default `30`) controls how many days of dated backups are kept in `daily_backup/` before older ones are automatically deleted. Raise it if you want a longer history of backups on disk; lower it to keep the repo leaner.

---

## More / notes

- The dashboard's data file is loaded with a cache-busting timestamp (`manga_history_data.js?v=...`), so browsers — mobile ones especially — always pull the latest synced data instead of a stale cached copy.
- The `local-fallback/fetch_manga_stats.vbs` script and its Windows Task Scheduler job are no longer required once the GitHub Actions workflow is running, but can be kept as a manual/offline fallback.
- Everything here — the workflow, the sync script, and the dashboard — reads from the same `manga_history_data.js` file, so Option A and Option B are fully interchangeable; you can switch between them at any time without touching your data.
- `manga-pace-ledger.html`'s `<head>` includes a description meta tag plus Open Graph / Twitter Card tags, so pasting the dashboard link into Discord, Slack, or similar shows a proper title, blurb, and thumbnail instead of a bare URL. If you fork this and change the GitHub Pages URL, update the `og:image` and `og:url` values in the `<head>` to match.
- This project is licensed under **MIT** (see `LICENSE`) — anyone can copy, modify, or reuse the code as long as the copyright notice is kept.
