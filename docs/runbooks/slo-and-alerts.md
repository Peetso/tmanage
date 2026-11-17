# Service targets (SLOs) and alerts

What "working" means for the private alpha on Hostinger, and how you hear when it is not. The
numbers come from `docs/planning/50-BOOTSTRAP-DEPLOYMENT-ON-ONE-PAID-PLAN.md` (§4, §6, §8) and the
latency/recovery targets in `docs/planning/01-MASTER-PLAN.md` and `27-TEST-CATALOG.md` (PERF-01–03).
The 99.5% alpha uptime figure is our own choice: doc 50 sets no number, and 99.9% is the GA
target. The alpha is **not SLA-backed** (doc 50 §1): these are not promises to customers.

## 1. The targets

| What                   | Target during the alpha                                       | How it is measured                       |
| ---------------------- | ------------------------------------------------------------- | ---------------------------------------- |
| Site is up             | 99.5% of each month (about 3.5 hours down at most)            | uptime monitor on `/healthz/deep` (§3)   |
| Common pages load fast | 95% of everyday reads answer in under 300 ms                  | API request log timings                  |
| Search                 | 95% of searches answer in under 500 ms                        | API request log timings                  |
| Background work        | queued mails and notices go out within 15 minutes             | `/healthz/deep` worker check (heartbeat) |
| Data loss at worst     | one day (daily backup), plus a backup right before any deploy | `docs/runbooks/backup-restore.md`        |
| Running after disaster | within 4 hours                                                | restore drill in `backup-restore.md`     |
| Errors                 | every server error mails the owner (at most once per 15 min)  | `ALERT_EMAILS` (§2)                      |

After the alpha (general availability) the master plan raises these to 99.9% up, at most 15
minutes of data loss and 4 hours to recover — that needs the paid upgrade in doc 50 §8.

### Capacity limits (doc 50) — check monthly, upgrade before they bite

- Database storage, connections and slow queries: alert at 60%, 75% and 85%. At 80% for more
  than a week, plan the move to a paid database.
- File storage (Cloudflare R2): warn at 5 GB in total, freeze review at 8 GB; 500 MB per company.
- Size: 3 companies (5 at most), 15 staff users (review at 25), 3 active projects per company.
- If any target in the table is missed two months running, that is an upgrade trigger (doc 50 §8).

## 2. Alert mails — `ALERT_EMAILS`

The app already mails the owner when something breaks: a server error (HTTP 5xx) or a background
job that fails. A worker that has stopped shows up in the uptime monitor (§3) instead. Each kind of problem mails at most once per 15 minutes;
the next mail says how many were held back. Mails carry no customer data — only the kind of
error, the time and a reference id to look up in the log.

In Hostinger (hPanel):

1. **Websites** → the TManage site → **Node.js** → **Environment variables**.
2. Add `ALERT_EMAILS` with the owner's address. Several addresses: separate with commas,
   e.g. `owner@example.com,second@example.com`.
3. Check the mail settings are present, because alerts use them: `SMTP_HOST`, `SMTP_PORT`,
   `SMTP_SECURE`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `EMAIL_FROM_ADDRESS`.
4. Set `OUTBOX_HEARTBEAT_FILE` to a file path the app can write to (for example
   `/home/u152275336/tmanage-data/heartbeat`) so the worker check in §3 is active. Leave
   `OUTBOX_HEARTBEAT_MAX_AGE_SECONDS` at its default of 900 (15 minutes).
5. **Save**, then **Restart** the app.
6. Test: open the site and confirm it works. Without `ALERT_EMAILS` the alerts are only written
   to the app log — nothing breaks, you just do not hear about it.

**Grouping (51-13a).** Errors of the same kind are grouped: the first one mails at once, the
rest are counted, and when the 15 minutes are over one summary mail says how many more happened
and on which routes (ids in addresses are shown as `:id`). A crash of the whole process (an error
nothing caught) also mails, once per 15 minutes even if the app keeps restarting; the next crash
mail says how many restarts were held back. These mails go straight through the SMTP settings,
not through the database, so "the database is down" still reaches you.

## 3. Uptime monitor on `/healthz/deep`

`/healthz/deep` answers **200** when the database, the migrations and the worker are fine, and
**503** when one is not. A monitor only needs to watch that status code. It must run somewhere
**other than** the Hostinger server — a check on the same server goes quiet when the server does.

### Option A — a free external monitor (recommended, no machine of yours needed)

1. Sign up for a free monitor (for example UptimeRobot free plan or Better Stack free tier). Do
   not enter payment details; the free plan is enough.
2. New monitor → type **HTTP(s)** → URL `https://tmanageapp.com/healthz/deep`.
3. Interval **5 minutes**. Alert when the status is not 200 (a "keyword" check is not needed).
4. Alert contact: the same address as `ALERT_EMAILS`.
5. Add a second monitor for `https://tmanageapp.com/healthz` — it tells "the app is down"
   apart from "the app is up but the database or worker is not".
6. The monitor's monthly uptime figure is the number to compare with the 99.5% target in §1.

### Option B — our own script from a home PC (nothing third-party)

`scripts/ops/uptime-check.mjs` checks both addresses and mails `ALERT_EMAILS` through the same
mail settings, at most once per 15 minutes, plus one "recovered" mail.

1. On a Windows PC that stays on: install Node.js, copy the `scripts/ops` folder.
2. Set the environment variables `UPTIME_URL=https://tmanageapp.com`, `ALERT_EMAILS` and the
   `SMTP_*` / `EMAIL_FROM_ADDRESS` values from §2.
3. Task Scheduler → **Create Basic Task** → repeat every 5 minutes → action
   `node C:\path\to\scripts\ops\uptime-check.mjs`. One run exits with code 1 while anything fails.
   Or leave a window open with `node scripts/ops/uptime-check.mjs --loop` (every 5 minutes).

### Public status link (51-12)

If the monitor offers a free public status page (UptimeRobot and Better Stack both do), copy its
`https://` address into hPanel as `STATUS_PAGE_URL` and Restart. It is then returned by
`GET /v1/public/site/status/summary` as `liveStatusUrl`, for the `/status` page's
"Live status →" link. That route is public and small — the overall state from published
incidents, the number still open, the link, and the time — and is cached for 30 seconds. Leave
`STATUS_PAGE_URL` unset and the link is simply `null`. Only a plain `https://` address without a
user name or password is accepted.

## 4. When an alert arrives

1. Open `https://tmanageapp.com/healthz/deep` — the body says which check is `fail`.
2. `database` fail: hPanel → Databases — is MariaDB up, is storage full?
3. `migrations` fail: the last deploy did not finish; follow the rollback in `backup-restore.md`.
4. `worker` fail: restart the Node.js app in hPanel; check the app log.
5. A 5xx alert: search the app log for the reference id in the mail.
