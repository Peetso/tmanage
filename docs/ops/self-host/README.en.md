# TManage self-host guide

Run TManage on your own Linux server: one install command, four questions, HTTPS, daily backups
and an update command. Your data stays on your servers; TManage (the vendor) processes none of it.

## What you need

- A Linux server with Docker Engine and the Docker Compose plugin (for example Ubuntu 24.04).
- About 2 vCPU, 4 GB RAM and 20 GB of disk for up to 50 users; add disk for uploaded files.
- A domain name (for example `tasks.your-company.tld`) whose DNS A/AAAA record points at the server.
- Ports 80 and 443 open to the internet (80 is needed to obtain the HTTPS certificate).
- A mailbox that can send by SMTP (invitations and sign-in codes are emailed).

## What runs

| Service | What it does                                                                 | Reachable from                   |
| ------- | ---------------------------------------------------------------------------- | -------------------------------- |
| `caddy` | HTTPS on 443, renews the certificate, redirects 80 to 443                    | the internet (80, 443)           |
| `app`   | TManage: pages, API, background jobs and live updates in one Node.js process | `caddy` only                     |
| `db`    | MariaDB 11.8.9                                                               | `app` only — no port on the host |

The app runs as a non-root user with no Linux capabilities. Uploaded files are kept in the
`app-storage` volume (or in your S3-compatible bucket if you chose `s3`), never in a web folder.
The database is created and upgraded automatically every time the app starts.

## Install

1. Get the kit and its SHA-256 from the release page, then run:

   ```bash
   curl -fsSLO <kit URL>/install.sh
   sudo bash install.sh <kit URL> <sha256>
   ```

   (Or copy `tmanage-self-host-<version>.tar.gz` to the server and pass the file path instead of
   the URL.) The kit is refused if its SHA-256 does not match.

2. Answer the four questions: the domain, your email, the mail server (SMTP) and where files are
   kept (`local` or `s3`). Every secret is generated for you and written to
   `/opt/tmanage/tmanage.env` with `chmod 600`. You never type a key.

3. The installer builds the app image on the server (no image registry), starts the stack, waits
   until `/healthz` answers, and prints a one-time setup token.

4. Open `https://<your domain>/setup`, paste the token, and create the first owner account and
   organization. Then run `sudo /opt/tmanage/tmanage finish-setup` to remove the token.

5. Accept the daily backup the installer offers (03:15, the last 14 kept).

Everyone else joins by invitation from inside the app. Public sign-up is off (`PUBLIC_SIGNUP=off`).
Platform admin (`/platform`) belongs to the email you gave (`PLATFORM_ADMIN_EMAILS`).

## Daily commands

Run from `/opt/tmanage`:

| Command                                 | What it does                                                         |
| --------------------------------------- | -------------------------------------------------------------------- |
| `./tmanage status`                      | the three services and their health                                  |
| `./tmanage logs [app\|db\|caddy]`       | follow the log                                                       |
| `./tmanage health`                      | wait until the app answers 200 inside and over HTTPS                 |
| `./tmanage down` / `./tmanage up`       | stop / start (data stays in the volumes)                             |
| `./tmanage backup [folder]`             | database, files and a copy of `tmanage.env` into a dated folder      |
| `./tmanage restore <folder>`            | check the folder's SHA-256 sums, replace database and files, restart |
| `./tmanage update <kit> --sha256 <hex>` | back up, then move to a new release                                  |

## Backups and restore

`./tmanage backup` writes `backups/<UTC date>/` with `db.sql.gz` (a consistent MariaDB dump),
`files.tar.gz` (when files are stored locally), `tmanage.env` and `SHA256SUMS`.

- **Keep a copy off the server.** The command warns when the backup folder is on the same disk as
  the data. Copy `backups/` to another machine or bucket on a schedule.
- **The backup contains your keys.** `tmanage.env` is needed to read encrypted fields and
  two-step sign-in codes after a restore. Store backups like you store passwords.
- **Restore on the same server:** `./tmanage restore <folder>`, then type `RESTORE`.
- **Restore on a new server:** unpack the same kit version into `/opt/tmanage`, copy the backup's
  `tmanage.env` there (`chmod 600`), run `./tmanage up`, then `./tmanage restore <folder>`. The
  command warns if the current `tmanage.env` differs from the backup's.
- With `s3` storage the files are in your bucket; back the bucket up with your provider's tools.

## Updating

```bash
./tmanage update tmanage-self-host-<new version>.tar.gz --sha256 <published hex>
```

The update verifies the checksum, takes a backup, replaces the kit files (your `tmanage.env` is
kept), rebuilds the image and restarts. The app applies database migrations on start. It refuses
to jump more than one major version unless you pass `--force`; read the release notes first. To go
back, install the previous kit with `update` and `./tmanage restore` the backup it took.

## Configuration

Every variable the app accepts, whether it is required and whether it is a secret:
[ENV-REFERENCE.md](ENV-REFERENCE.md). Edit `tmanage.env`, then `./tmanage up` (the app restarts
with the new values). The app refuses to start with a wrong value and names every bad variable.

- **Database users.** Like the cloud's Hostinger plan, the kit uses one database user and the log
  says "single-user mode". To keep schema changes and background jobs on users of their own,
  create them in MariaDB and set `DATABASE_URL`, `DATABASE_MIGRATION_URL` and
  `WORKER_DATABASE_URL` (see ENV-REFERENCE.md).
- **Virus scanning** is off (`MALWARE_SCAN_DRIVER=none`). To scan uploads, run ClamAV and set
  `MALWARE_SCAN_DRIVER=clamav` and `CLAMAV_HOST`.
- **Sign in with Google** needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, with
  `https://<your domain>/v1/auth/google/callback` as the redirect URI.

## Rotating secrets

- `SESSION_SECRET`, `CSRF_SECRET`, `STORAGE_LOCAL_SIGNING_SECRET`, `PUBLIC_LINK_PEPPER`: replace with
  a new value (`openssl rand -base64 32`) and `./tmanage up`. Everyone signs in again; links in
  flight expire.
- `AUTH_MFA_SEED_KEYS`, `FIELD_CIPHER_KEYS`, `AUDIT_ANCHOR_KEY`: never replace — append a new entry
  (`;2:<new key>`); the highest number is used for new data and older entries still read old data.
- `DB_PASSWORD`: change it in MariaDB first, then in `tmanage.env`.

## What phones home

Nothing. The app sends email only through your SMTP server and contacts no TManage service. The
only outbound connections are the ones you configure (SMTP, S3, Google sign-in) and Caddy's
certificate requests to Let's Encrypt.

## Troubleshooting

- `./tmanage health` times out: `./tmanage logs app` shows the missing or wrong variable by name.
- The certificate is not issued: check DNS for the domain and that ports 80 and 443 reach the server.
- Emails do not arrive: check `SMTP_*` and that the sender address belongs to that mailbox.

## For maintainers: building a kit

```bash
pnpm deploy:hostinger            # the same bundle the cloud runs
node deploy/self-host/pack.mjs   # deploy/self-host/out/tmanage-self-host-<version>.tar.gz + .sha256
```

Publish the `.tar.gz`, `install.sh` and the `.sha256` value. Regenerate ENV-REFERENCE.md after any
change to `packages/config/src/env.ts` with `node deploy/self-host/env-reference.mjs` (a unit test
fails while it is stale).
