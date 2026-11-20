# Off-site database backup to OCI Object Storage (Always Free)

Status: built 2026-11-20 (lane L, OFFSITE-BACKUP). Unit-tested, and proved end to end on a
private MariaDB 11.8.9 with every migration applied (see "Evidence"). **Not yet run against a
real OCI bucket and not configured on live:** the first scheduled run after the settings below
are entered is the first real upload. Until then `/healthz/deep` says `backups: not_configured`.

What it is: once a day the app itself dumps the live MariaDB database, compresses it, encrypts
it to an age public key, uploads it to a private bucket in Oracle Cloud's Always Free Object
Storage (region `ca-montreal-1`), reads it back to check it, prunes old copies, and records the
run in `platform_backup_runs`, which `/healthz/deep` reads. It runs inside the Node app as the
`offsite-backup` scheduled job (`apps/worker/src/backup/offsite-backup.ts`); there is no cron
entry, no shell, and no `mysqldump` binary involved. The host-side scripts in
`docs/runbooks/backup-restore.md` (cron, Google Drive) still work and are unchanged.

## 1. Facts this design rests on (checked on the web, 2026-11-20)

| Fact                                                                                                                                                                                                                                                                                                                             | Source                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Always Free Object Storage: 20 GB combined Standard + Infrequent Access + Archive, 50,000 Object Storage API requests a month, once the trial has ended and the account is Always Free only. More than 20 GB stored when the trial ends: all objects are deleted.                                                                | Oracle, _Always Free Resources_ https://docs.oracle.com/iaas/Content/FreeTier/resourceref.htm                                                                                                                                              |
| S3-compatible endpoint, path style: `https://<namespace>.compat.objectstorage.<region>.oci.customer-oci.com/<bucket>/<object>` (dedicated, recommended "for the strongest security posture"). The legacy `<namespace>.compat.objectstorage.<region>.oraclecloud.com` still works ("Your existing … endpoints continue to work"). | Oracle, _Amazon S3 Compatibility API_ https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/s3compatibleapi.htm ; _Object Storage Dedicated Endpoints_ https://docs.oracle.com/en-us/iaas/Content/Object/Concepts/dedicatedendpoints.htm |
| Authentication by a Customer Secret Key (access key + secret key); SigV4 only, SigV2 not supported; region must be the bucket's region.                                                                                                                                                                                          | Oracle, _Amazon S3 Compatibility API Support_ https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/s3compatibleapi_topic-Amazon_S3_Compatibility_API_Support.htm                                                                        |
| Supported calls include PutObject, GetObject, DeleteObject, ListObjects; **ListObjectsV2 is not in Oracle's list**, so the client uses ListObjects (v1).                                                                                                                                                                         | same page                                                                                                                                                                                                                                  |
| Region identifier of Canada Southeast (Montreal): `ca-montreal-1`, key YUL, realm OC1.                                                                                                                                                                                                                                           | Oracle, _Regions and Availability Domains_ https://docs.oracle.com/en-us/iaas/Content/General/Concepts/regions.htm                                                                                                                         |
| A user can have at most two Customer Secret Keys; they do not expire; the secret is shown once.                                                                                                                                                                                                                                  | Oracle, _Creating a Customer Secret Key_ https://docs.oracle.com/iaas/Content/Identity/access/to_create_a_Customer_Secret_key.htm ; _Managing User Credentials_                                                                            |
| Bucket-scoped policy: `where target.bucket.name='<bucket>'` on `manage objects` / `read buckets`.                                                                                                                                                                                                                                | Oracle, _Common Policies_ https://docs.oracle.com/en-us/iaas/Content/Identity/Concepts/commonpolicies.htm                                                                                                                                  |
| SigV4 algorithm and test vectors.                                                                                                                                                                                                                                                                                                | AWS SigV4 test suite as shipped in botocore `tests/unit/auth/aws4_testsuite` (https://github.com/boto/botocore)                                                                                                                            |
| age v1 format and test vectors.                                                                                                                                                                                                                                                                                                  | https://age-encryption.org/v1 ; C2SP CCTV `age/testdata` (https://github.com/C2SP/CCTV)                                                                                                                                                    |

## 2. Design decisions

**Dump in Node, not `mysqldump`.** Hostinger shared hosting gives the Node app no root, and
which client binaries its sandbox carries (and in which version) is outside our control; a MySQL
8 `mysqldump` against MariaDB 11.8 also needs flags a MariaDB one rejects. The job therefore
writes the dump itself (`apps/worker/src/common/database/backup-dump.ts`) on one connection
(`backup-store.ts`): `START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY` at REPEATABLE READ
(what `mysqldump --single-transaction` does, no `LOCK TABLES`), `SHOW CREATE` for tables, views,
routines, events and triggers, rows read as raw bytes (`typeCast: false`) and written back
unchanged (binary as hex, numbers bare, everything else escaped), generated columns left out,
triggers last under `DELIMITER ;;` with their own `sql_mode`, definers dropped. Output replays
with the `mariadb`/`mysql` client and with `scripts/ops/restore.mjs`.

**age, not AES-256-GCM with a key in env.** The host holds only the public key
(`BACKUP_AGE_RECIPIENT`); the private key stays offline. Whoever reads the app's environment,
the host disk or the bucket gets ciphertext only. With a symmetric key in env, the same reader
would decrypt every backup ever taken. age also fixes the file format (X25519 + HKDF-SHA-256,
ChaCha20-Poly1305 in 64 KiB chunks, header MAC), so the reference `age -d` can decrypt our files
and our code is checked against the CCTV vectors. GCM would need a home-made chunk framing with
no second implementation to check it against.

**Checks on every upload.** The SHA-256 of each object is signed into the request
(`x-amz-content-sha256`) and its MD5 sent as `Content-MD5`, so the store can refuse a body that
changed in transit. Then the job **reads each object back and hashes it**. A mismatch deletes the
object and fails the run. The manifest is uploaded after the dump. Its presence marks a backup as
complete, so a run that dies half-way leaves an "incomplete" backup, which is never counted as
kept and is deleted after a day.

**Retention and the free limit.** The newest backup of each of the last 7 UTC days, plus the
newest of each of the last 4 ISO weeks (at most 11 kept). The total is capped by
`BACKUP_OCI_MAX_BYTES` (default 15 GB, three quarters of the 20 GB allowance; the oldest kept
copies go first, the newest never). Old copies are deleted only **after** the new one is
verified, unless the cap needs room first. A run makes about 7 API calls (list, 2 puts, 2
read-backs, a few deletes), so about 220 a month. A broken setup retries at most hourly, which is
under 4,500 calls a month even in the worst case. The allowance is 50,000.

**Schedule and failure.** The job ticks every 15 minutes under the sweep lock, so one process runs
it (AS-4 / RT-3). A backup is due when the last good OCI run is 23 h 45 min old and the last
attempt is at least 1 h old. A failure writes a `failed` row and logs
`sweep offsite-backup failed: …`. `/healthz/deep` then says `backups: failed` straight away. The
app keeps serving: the job never exits the process, and no backup state makes the health answer 503.

## 3. What the manager creates in the Oracle console (once)

Do this as the account owner, in a browser.

1. **Account.** Sign up for Oracle Cloud Free Tier with **home region Canada Southeast (Montreal),
   `ca-montreal-1`**. The home region cannot be changed later. Never press _Upgrade to Pay As You
   Go_. Keep the account Always Free only. If you are still in the 30-day trial, stay well under
   20 GB: at the end of the trial, an account holding more than 20 GB loses **all** its objects.
2. **Namespace.** Profile menu → _Tenancy: <name>_ → **Object Storage namespace** (a short
   lowercase string). It is also shown on every bucket's details page. Write it down.
3. **Bucket.** Storage → Object Storage & Archive Storage → Buckets, compartment **root** (the
   default compartment for the S3-compatible API) → _Create bucket_:
   - Name: **`tmanage-db-backups`**
   - Default storage tier: **Standard**. Do not use Archive: an archived object must be restored
     before it can be read, and the job reads every upload back.
   - Auto-tiering: off. **Object versioning: off.** With versioning on, pruned backups stay as old
     versions and keep counting against the 20 GB.
   - Encryption: Oracle-managed keys (the default; the data is already age-encrypted).
   - Visibility stays **Private**. Create no pre-authenticated requests.
4. **A user that can only touch this bucket.** Identity & Security → Domains → _Default_:
   - Groups → create **`tmanage-backup-writers`**.
   - Users → create **`tmanage-backup`** and add it to that group. It needs no console password.
   - Identity & Security → Policies, compartment root → create policy **`tmanage-backup-policy`**
     with these two statements:

     ```
     Allow group tmanage-backup-writers to read buckets in tenancy where target.bucket.name='tmanage-db-backups'
     Allow group tmanage-backup-writers to manage objects in tenancy where target.bucket.name='tmanage-db-backups'
     ```

5. **Customer Secret Key.** Domains → Default → Users → `tmanage-backup` → Resources → _Customer
   secret keys_ → _Generate secret key_, name `tmanage-hostinger`. Copy the **Secret key at
   once** (it is shown only once). Then copy the **Access key** from the list. Store both in the
   password manager. A user can hold at most two keys, so delete the old one when you rotate.
6. **The age key pair**, on your own PC, never on the server:

   ```
   node scripts/ops/backup-encrypt.mjs keygen > tmanage-backup-age-key.txt
   ```

   The file holds the secret `AGE-SECRET-KEY-1…` line and a `# public key: age1…` comment. Keep
   the file in the password manager **and** on an offline medium. Without it no backup can ever
   be opened. Only the `age1…` public key goes to Hostinger.

## 4. What goes into the Hostinger environment (hPanel → the Node app → Environment variables)

Add these variables one at a time. **Never run a full replace of the variable set** (RT-1). Then
restart the app quietly (memory "Restart Hostinger quietly").

| Variable                       | Value                                      |
| ------------------------------ | ------------------------------------------ |
| `BACKUP_OCI_NAMESPACE`         | the namespace from step 2                  |
| `BACKUP_OCI_REGION`            | `ca-montreal-1` (this is also the default) |
| `BACKUP_OCI_BUCKET`            | `tmanage-db-backups`                       |
| `BACKUP_OCI_ACCESS_KEY_ID`     | the Access key from step 5 (secret)        |
| `BACKUP_OCI_SECRET_ACCESS_KEY` | the Secret key from step 5 (secret)        |
| `BACKUP_AGE_RECIPIENT`         | the `age1…` public key from step 6         |
| `BACKUP_OCI_MAX_BYTES`         | optional; leave unset for 15 GB            |
| `BACKUP_OCI_ENDPOINT`          | optional; leave unset                      |

`DATABASE_MIGRATION_URL` is already set on live, and the dump reads with it. Nothing else changes.

**After the restart:** within 15 minutes the first run happens. The runtime log shows
`sweep offsite-backup: <stamp>: N table(s), … verified at oci:tmanage-db-backups/db/<stamp>/`.
`/healthz/deep` then shows `backups: ok`. The bucket holds `db/<stamp>/db.sql.gz.age` and
`db/<stamp>/manifest.json`. If it says `backups: failed`, the log line names the cause. For
example, `object store PutObject -> 403 …` means a wrong key or policy, and `misconfigured: …`
names the missing variable.

## 5. Restore

You need: Node 22, the repository checkout, the `mariadb` (or `mysql`) client, and the age key
file from step 6.

1. **Download one backup.** In the OCI console open the bucket, open `db/<stamp>/`, and download
   both `db.sql.gz.age` and `manifest.json` into one empty folder. Choose the newest stamp unless
   you are going back to a known-good day.
2. **Create an empty target database** whose name contains `restore`, for example
   `u123_tm_restore` in hPanel, or a local one.
3. **Dry run.** This checks the SHA-256 of the dump against the manifest and changes nothing:

   ```
   MYSQL=mariadb node scripts/ops/restore.mjs --from <folder> \
     --target "mysql://<user>:<pass>@127.0.0.1:3306/u123_tm_restore" --identity tmanage-backup-age-key.txt
   ```

4. **Apply.** Repeat with `--apply`. Expect `Restore complete; migrations ledger matches the
manifest.`
5. **Without the script**, for example on a machine with only the reference tools:
   `age -d -i tmanage-backup-age-key.txt db.sql.gz.age | gunzip | mariadb --default-character-set=utf8mb4 -u <user> -p <db>`.
6. **Restoring over production** is a rollback. Follow "Rollback" in
   `docs/runbooks/backup-restore.md`: stop the app first, back up the current state, then run
   `restore.mjs --target "$DATABASE_MIGRATION_URL" --apply --i-know`.
7. **Secrets are not in the backup.** `AUTH_MFA_SEED_KEYS`, `FIELD_CIPHER_KEYS` and the other
   keys live in the secret store. A restored database without the same keyring cannot read
   encrypted fields or MFA factors.

**Drill:** once after the first real upload, then monthly, do steps 1–4 into a `restore`
database and compare row counts of `organizations`, `users` and `work_items` with live.

## 6. Evidence (2026-11-20, local)

- Unit tests: `apps/worker/src/backup/*.test.ts`, `src/common/database/backup-{dump,store}.test.ts`,
  `apps/api/src/common/observability/backup-health.test.ts`. They include the AWS SigV4
  vectors, the CCTV age vectors and a cross-check with `scripts/ops/backup-encrypt.mjs`. Each
  core fix was reverted on purpose and its test failed (report: lane L).
- Round trip on a private MariaDB 11.8.9 with every migration applied: the Node dump was
  encrypted, decrypted and replayed with `mariadb.exe` into a second database. Results: 388
  tables with `CHECKSUM TABLE … EXTENDED` equal, 232 triggers, 2 views and 561 foreign keys
  equal, and the column, index and trigger definitions hash-equal. An awkward-values row (binary
  with NUL and quote bytes, emoji, `\0`, max BIGINT UNSIGNED, DECIMAL(30,10), DATETIME(6), JSON,
  BIT, UUID, INET6, virtual and stored generated columns) came back byte-identical. The restored
  immutability trigger still fires.
- The real pass (real session, dump, age and run row) against a folder standing in for the
  bucket was followed by `scripts/ops/restore.mjs --apply`. Results: "migrations ledger matches
  the manifest", and 386 tables are checksum-equal (all except `platform_backup_runs`, which
  gained the run row after the snapshot). A second pass straight after did nothing (not due).
- **Not yet proved:** a real OCI upload (no account yet); the dump against MySQL 8 (local
  development). Live is MariaDB, which is what was proved.
