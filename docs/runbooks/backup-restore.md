# Backup, restore and rollback

How to take a backup of TManage, prove it restores, and go back one deploy on Hostinger shared
hosting. The scripts live in `scripts/ops/` (see its README for flags). This runbook does not
change the deploy order in `docs/runbooks/deploy.md`; it adds a backup step in front of it.

Status: written 2026-10-22 (AUDIT-2026-10-22 top-10 #10). The pure helpers are unit-tested; the
scripts themselves have **not yet been run against the live database**. The first scheduled
backup and the first restore drill below are what close that gap.

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

1. **Stop traffic.** In hPanel stop the Node app (or point the domain at a maintenance page).
   Disable the cron passes so nothing writes during the switch.
2. **Back up the current state first**: `node scripts/ops/backup.mjs`. Never roll back without a
   copy of what you are rolling back from.
3. **Put the previous build back.** Redeploy the previous release's build (the previous commit
   on the deploy branch, or the previous uploaded build archive) and restart the app with the
   same environment variables. Find the previous sha in the last backup's `manifest.json`.
4. **Decide on the database** using the migration list below:
   - If every migration added since the previous build is additive (new tables, new nullable
     columns), **leave the database as it is**. Old code ignores what it does not know.
   - If a migration changed something the old code depends on, **restore the pre-deploy backup**
     with `--target "$DATABASE_MIGRATION_URL" --apply --i-know`, then restore uploads the same way.
     Everything written since that backup is lost; export it first if it matters.
5. **Check** `/health` (or the login page), then re-enable the cron passes.

### Migrations 0205–0214: what a rollback must consider

| Migration                           | Change                                                                                    | Old code still works?                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 0205 user_identities                | new table                                                                                 | Yes, additive                                                                                 |
| 0206 platform_admin                 | `organizations.suspended_at` NULL column + 3 new tables                                   | Yes; suspensions set while on the new build are **not enforced** by old code                  |
| 0207 mentions_kind_and_channel_team | `notification_kind_prefs.kind` ENUM gains `mention`; backfills `conversation_memberships` | Mostly; old code may fail to read a `mention` preference row — delete those rows if it errors |
| 0208 oauth_core                     | 4 new OAuth tables                                                                        | Yes; issued OAuth tokens stop working until the new build returns                             |
| 0209 pending_ai_actions             | new table                                                                                 | Yes, additive                                                                                 |
| 0210 google_drive_storage           | 3 new tables + immutability trigger                                                       | Yes; Drive attachments are invisible to old code                                              |
| 0211 deliverables                   | new table + 4 NULL columns on `deliverable_versions`                                      | Yes, additive; deliverables made on the new build are invisible                               |
| 0212 request_messages               | new table + immutability trigger                                                          | Yes, additive                                                                                 |
| 0213 meeting_ends_at                | `meetings.ends_at` NULL column                                                            | Yes, additive                                                                                 |
| 0214 direct_conversations           | 2 new tables + immutability trigger                                                       | Yes; direct messages are invisible to old code                                                |

None of 0205–0214 drops or renames anything, so going back one deploy across them normally needs
**no data restore**. Re-deploying the newer build later is safe: the migrator sees the versions
already in `schema_migrations` and skips them. Do **not** delete ledger rows by hand.

When a future migration drops, renames or narrows a column, add it to this table with "No" and
the restore step becomes mandatory for a rollback across it.
