# scripts/ops

Operations scripts. Plain Node (no dependencies), runnable on Hostinger shared hosting. The
procedure — schedule, restore drill, rollback — is in `docs/runbooks/backup-restore.md`.

| Script            | Purpose                                                           |
| ----------------- | ----------------------------------------------------------------- |
| `backup.mjs`      | dump DB + archive uploads + manifest, prune to the newest 14      |
| `restore.mjs`     | replay a backup into a target database (dry run by default)       |
| `backup-plan.mjs` | pure helpers both scripts share; tested by `backup-plan.test.mjs` |

Requires the `mysqldump`/`mysql` clients (or set `MYSQLDUMP=mariadb-dump`, `MYSQL=mariadb`) and
`tar` on `PATH`. Passwords are passed through `MYSQL_PWD`, never as arguments.

## backup.mjs

```
DATABASE_URL=mysql://user:pass@127.0.0.1:3306/db node scripts/ops/backup.mjs \
  [--out <dir>] [--uploads <dir>] [--keep 14]
```

Env fallbacks: `BACKUP_DIR` (default `backups/`), `KEEP`, `STORAGE_LOCAL_DIR` /
`STORAGE_FILESYSTEM_ROOT` (default `.local/storage`), `GIT_SHA` (else `git rev-parse HEAD`).
`backups/` is not git-ignored yet; point `BACKUP_DIR` outside the checkout.

## restore.mjs

```
node scripts/ops/restore.mjs --from backups/<stamp> --target mysql://u:p@h:3306/tm_restore \
  [--uploads <dir>] [--apply] [--i-know]
```

- Without `--apply` it only prints the plan.
- Refuses a target database whose name contains neither `restore` nor `test`, and a non-empty
  uploads destination, unless `--i-know`.
- Strips `DEFINER=` clauses so triggers restore under a non-SUPER user.
- Exit 0 ok, 1 error, 2 restored but the `schema_migrations` ledger differs from the manifest.

## Tests

```
node --test scripts/ops/backup-plan.test.mjs
```

## Uptime check (`uptime-check.mjs`)

Polls `/healthz` and `/healthz/deep` and mails `ALERT_EMAILS` (through the `SMTP_*` settings) when
either fails, at most once per 15 minutes per kind, plus one "recovered" mail. Run it from a machine
other than the server: `UPTIME_URL=https://your-site node scripts/ops/uptime-check.mjs` (one pass,
exit 1 while failing — for Task Scheduler or cron) or add `--loop` (every `UPTIME_INTERVAL_SECONDS`,
default 300). A free external monitor pointed at `/healthz/deep` works too; it answers 503 on failure.
