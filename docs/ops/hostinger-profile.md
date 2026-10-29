# Hostinger host profile — capacity budget (56-32)

The shared-hosting capacity budget of spec 56 §12.2: what the plan allows, what TManage may use
of it, how each train proves it stayed inside, and when we move to a VPS.

- **Readings:** the API samples itself every 30 s and stores a `sample` reading every 5 minutes
  and a `nightly` reading at 03:30 UTC in `host_capacity_readings` (90 days kept).
- **Ceilings:** `platform_settings.host_profile_json`, written from hPanel with
  `node scripts/ops/host-profile.mjs --set '<json>'` (migration credential). Until it is written
  the API uses the planning values below and reports `profile.source: "planning"`.
- **Read:** `GET /v1/platform/health/capacity` (platform admins with `platform.activity.view`).

## PERF-H-01 — baseline (R0 day)

Fill the `measured` cells at the R0 live check, then write the plan figures with
`host-profile.mjs --set`. Status is `planning` until a row is measured, then `ok` / `over budget`.

| Resource                           | hPanel source                                 | Plan figure (planning value)    | Measured idle | Measured under smoke | Budget (max steady use) | Status   |
| ---------------------------------- | --------------------------------------------- | ------------------------------- | ------------- | -------------------- | ----------------------- | -------- |
| RAM, Node process (`ramMb`)        | Websites → Node.js → resources                | 1024 MB (typically 1–2 GB)      | —             | —                    | 60 % of the figure      | planning |
| CPU (`loopLagMs`)                  | none (LiteSpeed throttles a shared CPU share) | 100 ms p95 event-loop lag       | —             | —                    | p95 lag ≤ 100 ms        | planning |
| Concurrent connections (`sockets`) | LiteSpeed proxy limit per vhost (verify)      | 500 sockets                     | —             | —                    | 500 incl. realtime      | planning |
| Inodes (`inodes`)                  | Hosting → plan details → inodes               | 400 000 (hundreds of thousands) | —             | —                    | 50 % of the figure      | planning |
| Disk (`diskMb`)                    | Hosting → plan details → disk space           | 51 200 MB                       | —             | —                    | 60 % of the figure      | planning |
| DB connections (`dbConnections`)   | Databases → MySQL → user connection limit     | 25 per user                     | —             | —                    | 70 % of the cap         | planning |
| DB size                            | Databases → MySQL → size                      | plan figure                     | —             | —                    | reported, no gauge yet  | planning |

Gauge colours on every line: **green** under 60 % of the ceiling, **amber** under 80 %, **red**
beyond.

Example, after reading hPanel:

```sh
node scripts/ops/host-profile.mjs --set '{"plan":"Business","ramMb":1536,"sockets":500,"inodes":600000,"diskMb":204800,"dbConnections":25,"measuredAt":"2026-11-02"}'
node scripts/ops/host-profile.mjs --show
```

## PERF-H-02 — every train

1. After the train's live checks, read `GET /v1/platform/health/capacity` and copy the six gauges
   into the train's `SWITCH-<sha>.md`.
2. Run a **10-minute synthetic load** on the staging copy:
   - 200 concurrent sockets held open (realtime);
   - one import of 5 000 rows;
   - 3 PDF renders;
   - 1 database dump (`scripts/ops/backup.mjs --db-only --no-record`).
3. Every gauge must stay under its budget for the whole run. If one does not, the heaviest new item
   of the train ships with its flag off.

## PERF-H-03 — inode growth

The inode count under the app root may not grow more than **5 % per train** from code and assets
alone. Customer data is left out by path: list the storage and backup directories in
`TMANAGE_INODE_EXCLUDE` so the nightly walk counts only what a deploy adds.

## Move when

**Move to KVM when any gauge is red for 7 consecutive daily readings.**

Move the Node app (and later MariaDB) to a Hostinger KVM1/KVM2 VPS (about $5–8 a month) when any
of these holds:

- a gauge is red (over 80 % of its ceiling) on 7 consecutive daily readings — the API reports this
  as `redStreakDays` and `trigger.due`;
- `auth_mail_deferred` or socket refusals are above 0 on 3 days in a week;
- 53-10 co-editing is enabled for any organization;
- paid plans exist.

A red gauge also mails `ALERT_EMAILS` once per UTC day per gauge (`capacity:red:<gauge>`).
