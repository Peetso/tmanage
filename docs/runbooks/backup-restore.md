# Backup, restore and rollback

How to take a backup of TManage, prove it restores, and go back one deploy on Hostinger shared
hosting. The scripts live in `scripts/ops/` (see its README for flags). This runbook does not
change the deploy order in `docs/runbooks/deploy.md`; it adds a backup step in front of it.

Status: written 2026-10-22 (AUDIT-2026-10-22 top-10 #10). The pure helpers are unit-tested; the
scripts themselves have **not yet been run against the live database**. The first scheduled
backup and the first restore drill below are what close that gap.

Updated 2026-10-23 (restore drill, run `claude-auto-1792715640`, local only): backup and restore
were run end to end on a private MariaDB 11.8.9 with all migrations 0001–0217; after deliberate
damage the restored database matched the original exactly (row checksums, 215 ledger rows, 231
tables, 168 triggers) and the uploads folder was identical. The same drill **disproved** the
earlier rollback advice "old code ignores what it does not know": see "Rollback" below. Still
untested on Hostinger itself: `backup.mjs` there, and the manifest sha it records.

## What a backup contains

`node scripts/ops/backup.mjs` writes `backups/<UTC stamp>/` (or `BACKUP_DIR`):

| File             | What                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| `db.sql.gz`      | `mysqldump --single-transaction --routines --triggers --events`, no `LOCK TABLES`, no `CREATE DATABASE` |
| `uploads.tar.gz` | the local storage root (`STORAGE_LOCAL_DIR`, else `STORAGE_FILESYSTEM_ROOT`, else `.local/storage`)     |
| `manifest.json`  | stamp, git sha, database name, migration versions in `apps/api/migrations`, file sizes                  |

The newest 14 backups are kept (`KEEP` / `--keep`); older stamp directories are deleted.

Not in the backup, on purpose: `AUTH_MFA_SEED_KEYS` and every other secret. Keep those in the
secret store and the offline copy described in `deploy.md` ("Where the key lives"). A restore
without the matching keyring leaves every enrolled MFA factor unreadable.

## Taking backups

1. Put the backups **outside the web root** and outside the git checkout, e.g.
   `BACKUP_DIR=/home/<user>/tmanage-backups`.
2. Use the migration credential (`DATABASE_MIGRATION_URL`) as `DATABASE_URL` for the run: it can
   read every table and trigger. The runtime user may lack `SHOW VIEW` / `TRIGGER`.
3. hPanel cron, daily at a quiet hour:

   ```
   cd ~/tmanage && DATABASE_URL="$DATABASE_MIGRATION_URL" BACKUP_DIR=~/tmanage-backups \
     node scripts/ops/backup.mjs >> ~/tmanage-backups/backup.log 2>&1
   ```

4. Copy at least the newest backup off the server weekly (download from hPanel File Manager).
   A backup on the same disk does not survive losing the account.
5. Always take one by hand **immediately before every deploy**.

## Restore drill (do this once now, then monthly)

1. In hPanel create an empty database whose name contains `restore`, e.g. `u123_tm_restore`, and
   give the migration user all privileges on it.
2. Dry run — prints what would happen, changes nothing:

   ```
   node scripts/ops/restore.mjs --from ~/tmanage-backups/<stamp> \
     --target "mysql://<user>:<pass>@127.0.0.1:3306/u123_tm_restore" --uploads ~/tm-restore-uploads
   ```

3. Repeat with `--apply`. Expect "migrations ledger matches the manifest". Exit code 2 means the
   ledger differs: the backup was taken while the code on disk was ahead of (or behind) the
   database — note which versions, the data itself is restored.
4. Spot-check row counts of `organizations`, `users`, `work_items` against production, then drop
   the restore database.

## Rollback: going back one deploy

Migrations are **forward-only** (the migrator has no down files). A rollback is therefore "old
code on a database that still works for it", and only falls back to restoring data when it
does not.

**Old code does not ignore newer migrations.** On every start `server.mjs` runs the migrator
before it opens the port. The migrator compares the `schema_migrations` ledger with the
`migrations/*.sql` files in the bundle, and a ledger row with no matching file is an error
("recorded as applied, but the file is missing", `apps/api/src/common/database/migrator.ts`).
That error stops the boot. So uploading only the previous ZIP after a deploy that applied a new
migration leaves the site **down**. This was proved locally on 2026-10-23: old file set applied,
newer migrations applied, then the old bundle alone was refused; the old bundle with the newer
migration files copied in started with "nothing to apply".

### Steps

1. **Stop traffic.** In hPanel stop the Node app (or point the domain at a maintenance page).
   Disable the cron passes so nothing writes during the switch.
2. **Back up the current state first**: `node scripts/ops/backup.mjs`. Never roll back without a
   copy of what you are rolling back from.
3. **Find the previous build.** Every uploaded build is kept as
   `deploy-live/tmanage-hostinger-<sha>.zip` next to its `STATUS-<sha>.md` / `SMOKE-<sha>.md`.
   The previous one is the last STATUS file that ends in a confirmed live check (a STATUS that
   stops at "build started" did not finish and is not the previous version). The last backup's
   `manifest.json` also records the sha. Check the ZIP with `unzip -t` before using it.
4. **Decide on the database** using the migration table below. List the migrations that are in
   the current build but not in the previous one (compare the two ZIPs' `migrations/` folders).
   - If **every** one of them is additive (new tables, new nullable or defaulted columns), keep
     the database and **copy those newer `migrations/*.sql` files into the previous build's
     `migrations/` folder**, then re-zip it as `tmanage-hostinger.zip`. The migrator then finds
     every ledger row's file, has nothing to apply, and the old code runs on the wider schema.
     Copy the files unchanged: the ledger stores a checksum per file.
   - If any of them changed something the old code depends on (drop, rename, narrowed type,
     changed meaning), copying files is **not** valid. Restore the pre-deploy backup with
     `node scripts/ops/restore.mjs --from <backup> --target "$DATABASE_MIGRATION_URL" --apply --i-know`,
     then restore uploads the same way, and upload the previous ZIP unchanged. Everything
     written since that backup is lost; export it first if it matters.
   - Never delete `schema_migrations` rows by hand to make old code start.
5. **Upload and build on Hostinger** (hPanel, the existing Web app for `tmanage.peetrix.com`):
   1. Open the app's deployments and upload the ZIP from step 4 as **`tmanage-hostinger.zip`**
      (look for _Deployments_ / _Redeploy_ / _Upload new files_). Check the uploaded size
      matches the local file.
   2. Start the build with the **same build settings** as every deploy (see
      `deploy/hostinger/DEPLOY-HOSTINGER.md` Part 2 step 5):

      | Setting                      | Value                                                  |
      | ---------------------------- | ------------------------------------------------------ |
      | Framework / app type         | **Other** — never _Next.js_ (the ZIP is already built) |
      | Node version                 | **22**                                                 |
      | Root directory               | `./` (where `server.mjs` is)                           |
      | Package manager              | **npm**                                                |
      | Build command / build script | `npm run build` (prebuilt: it only prints "prebuilt")  |
      | Entry file                   | `server.mjs` (start command, if asked: `npm start`)    |

   3. Leave the environment variables and the database untouched. A build takes about 70–80
      seconds; expect a brief 307/503 while the app restarts.
6. **Check** `/healthz` returns 200 `{"status":"ok"}`, `/` and `/sign-in` return 200, and the
   runtime log shows "nothing to apply (<n> already applied)" with no migrator error. Then
   re-enable the cron passes.

Worked example (from the 2026-10-23 drill): rolling back from `9c6d816c` to `014a9d51` means
copying `migrations/0215_member_profile_job_title.sql` from the `9c6d816c` ZIP into the
`014a9d51` bundle's `migrations/` (0215 only adds a column), uploading that as
`tmanage-hostinger.zip` with the settings above, and checking `/healthz`.

### Migrations 0205–0217: what a rollback must consider

| Migration                             | Change                                                                                    | Old code still works?                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 0205 user_identities                  | new table                                                                                 | Yes, additive                                                                                 |
| 0206 platform_admin                   | `organizations.suspended_at` NULL column + 3 new tables                                   | Yes; suspensions set while on the new build are **not enforced** by old code                  |
| 0207 mentions_kind_and_channel_team   | `notification_kind_prefs.kind` ENUM gains `mention`; backfills `conversation_memberships` | Mostly; old code may fail to read a `mention` preference row — delete those rows if it errors |
| 0208 oauth_core                       | 4 new OAuth tables                                                                        | Yes; issued OAuth tokens stop working until the new build returns                             |
| 0209 pending_ai_actions               | new table                                                                                 | Yes, additive                                                                                 |
| 0210 google_drive_storage             | 3 new tables + immutability trigger                                                       | Yes; Drive attachments are invisible to old code                                              |
| 0211 deliverables                     | new table + 4 NULL columns on `deliverable_versions`                                      | Yes, additive; deliverables made on the new build are invisible                               |
| 0212 request_messages                 | new table + immutability trigger                                                          | Yes, additive                                                                                 |
| 0213 meeting_ends_at                  | `meetings.ends_at` NULL column                                                            | Yes, additive                                                                                 |
| 0214 direct_conversations             | 2 new tables + immutability trigger                                                       | Yes; direct messages are invisible to old code                                                |
| 0215 member_profile_job_title         | `member_profiles.job_title` NULL column                                                   | Yes, additive (proved in the 2026-10-23 drill)                                                |
| 0216 direct_conversation_read_markers | 2 `NOT NULL DEFAULT 0` columns on `direct_conversations`                                  | Yes, additive; old code does not write them, unread counts may be off after returning         |
| 0217 meeting_client_attendees         | new table + immutability trigger                                                          | Yes, additive; client attendees are invisible to old code                                     |

0236 onedrive_storage (OneDrive as company storage) adds 3 NULL columns to
`storage_connections` (`onedrive_drive_id`, `onedrive_drive_name`, `granted_scopes`), 2 new tables
(`onedrive_folders`, `onedrive_attachments`) and their immutability triggers. Old code still works:
it ignores the columns and OneDrive attachments are invisible to it; no restore is needed.

0237 meeting_calendar_sync (meetings connected to Google Calendar / Meet) adds 13 columns with
defaults to `meetings` (event options and `cancelled_at`), an `optional` column and the
`tentative` answer to `meeting_attendees` and `meeting_client_attendees`, 4 new tables
(`calendar_connections`, `meeting_external_events`, `meeting_guests`, `meeting_attachments`) and
their immutability triggers. Additive: old code ignores the columns and never reads the tables; an
attendee answer of `tentative` shows as an unknown value in an old roster. No restore is needed.

None of 0205–0217 drops or renames anything, so going back one deploy across them needs **no
data restore** — but it does need the newer migration files copied into the older bundle (step
4). Re-deploying the newer build later is safe: the migrator sees the versions already in
`schema_migrations` and skips them.

When a future migration drops, renames or narrows a column, add it to this table with "No" and
the restore step becomes mandatory for a rollback across it.
