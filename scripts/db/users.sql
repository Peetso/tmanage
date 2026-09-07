-- Least-privilege database users — ADR-0001 layer 2.
--
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md §5:
--   "Separate migration and runtime database users. The runtime user has only the DML
--    privileges the application needs and cannot alter schema, grant privileges, create
--    users, or access other databases."
--
-- MySQL has no row-level security, so the credential boundary is one of the few controls
-- that still holds if application code is bypassed entirely. Layers 3 (query guard) and 4
-- (lint boundary) live inside the application and do nothing for a direct SQL session.
--
-- ## Who applies this, and when
--
-- **An administrative credential, not the migration credential.** The statements below
-- issue `CREATE USER` and `GRANT`, which need the server-global `CREATE USER` privilege and
-- `GRANT OPTION`. `tmanage_migrator` holds privileges on the `tmanage` database only and is
-- correctly refused — provisioning credentials is an administrative act, separate from
-- migrating a schema, and the two are separate for the same reason the users are.
--
-- **After `pnpm db:migrate`** — `pnpm db:grants` does exactly that. Every grant
-- below is table-level, and MySQL and MariaDB both reject a table-level GRANT naming a
-- table that does not exist (`ER_NO_SUCH_TABLE`, 1146). An earlier revision of
-- `compose.yaml` mounted this file into `/docker-entrypoint-initdb.d/`, which runs on the
-- server's *first boot* — necessarily before any migration. That mount could never have
-- succeeded, and has been removed rather than worked around by loosening the grants.
--
-- ## Why every grant is table-level
--
-- MySQL privileges are additive and cannot be revoked for a single table once granted
-- database-wide. Withholding UPDATE and DELETE on `audit_events`, and INSERT on
-- `schema_migrations`, therefore requires never granting them database-wide in the first
-- place. `SELECT` is the one exception, and only for the application: `tmanage_app` is
-- granted it database-wide because that process already reads most of the schema, because
-- a read of a table it already reaches is not a privilege escalation, and because a new
-- module's tables would otherwise be unreadable until someone remembered to amend this
-- file. Writes get no such courtesy — a table this file does not name cannot be written by
-- the application at all, and that failure is loud.
--
-- The worker gets no such courtesy either, and D07 is why. `tmanage_worker` held the same
-- database-wide read, which made the relay's connection string a second way to dump every
-- password hash, every TOTP seed, every recovery code and the whole sign-in log — for a
-- process that reads a short, fixed list of tables and no credential at all. Its SELECTs
-- are therefore table-level and named one by one below, and the cost is the one the writes
-- already pay: a new table the relay must read arrives with the grant that lets it read
-- it, or the relay says so the first time it tries.
--
-- Local development passwords only. Deployed environments provision these users from the
-- secret store; see docs/runbooks/deploy.md. On Hostinger, apply as far as the plan permits
-- and record any shortfall in the environment runbook (50-BOOTSTRAP §4).

-- ─────────────────────────────────────────────────────────────────────────────
-- Runtime user
-- ─────────────────────────────────────────────────────────────────────────────
CREATE USER IF NOT EXISTS 'tmanage_app'@'%' IDENTIFIED BY 'local_dev_only_app';

-- Deliberately NOT granted: CREATE, ALTER, DROP, INDEX, REFERENCES, GRANT OPTION,
-- CREATE USER, FILE, SUPER, PROCESS, LOCK TABLES, CREATE TEMPORARY TABLES. The application
-- can read this one database and write the rows named below, and can do nothing else — to
-- it or to any other database on the server.
GRANT SELECT ON `tmanage`.* TO 'tmanage_app'@'%';

GRANT INSERT, UPDATE, DELETE ON `tmanage`.`organizations`        TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`users`                TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`sessions`             TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`memberships`          TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`workspaces`           TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`projects`             TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`project_memberships`  TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`client_organizations` TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`client_memberships`   TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`project_clients`      TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`work_items`           TO 'tmanage_app'@'%';
-- REQ-001 client requests. **No DELETE**, and for a stronger reason than invitations: a
-- client request is the client's own record of having asked. `23-ERD` §6 gives the client
-- `withdrawn` and gives the studio no way out at all, so a runtime credential that could
-- remove the row could make a request the agency did not want to answer disappear with no
-- trace that it was ever made. UPDATE is needed for the lifecycle and for nothing else; the
-- immutability trigger in 0006 refuses the four columns that say what the request *is*.
GRANT INSERT, UPDATE         ON `tmanage`.`client_requests`      TO 'tmanage_app'@'%';
-- TEN-003 invitations. **No DELETE**, and that is the point of listing it separately: an
-- invitation is never removed, it moves to `accepted`, `revoked` or `expired`. "Who invited
-- this person, when, and who withdrew it" is the trail a role change is investigated by, and a
-- runtime credential that could delete the row could erase the grant's own history. UPDATE is
-- needed for exactly those three status moves; the immutability trigger in 0005 refuses the
-- two columns that must never change.
GRANT INSERT, UPDATE         ON `tmanage`.`invitations`           TO 'tmanage_app'@'%';
-- CHAT-001 conversations. A channel is archived rather than dropped, so **no DELETE**: the
-- messages in it are the project's record of how a decision was reached, and a credential that
-- could remove the channel could remove the thread that explains the work.
GRANT INSERT, UPDATE         ON `tmanage`.`conversations`         TO 'tmanage_app'@'%';
-- Leaving a channel is an ordinary revocation, so DELETE is granted here exactly as it is for
-- `project_memberships`, and the audit row records the facts the DELETE destroys.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`conversation_memberships` TO 'tmanage_app'@'%';
-- **No DELETE**, and this is the sharpest case of the rule in this file. `12-PERMISSION-MATRIX`
-- §2 lets a moderator take a message down; `messages.deleted_at` and `deleted_by_user_id`
-- record that they did. A runtime credential able to remove the row could make a message
-- vanish with nothing to show it was ever said, which is the difference between moderation and
-- erasure. UPDATE is needed for an edit and for a moderation, and the trigger in 0007 refuses
-- the six columns that say what the message *is*.
GRANT INSERT, UPDATE         ON `tmanage`.`messages`              TO 'tmanage_app'@'%';

-- `message_revisions` gets NO write grant at all, and the absence is the mechanism. The
-- rows are written by `trg_messages_record_revision` (0008), which fires with its definer's
-- privileges — so history happens to the application rather than being written by it. A
-- runtime credential that could INSERT could forge a revision; UPDATE is refused by the
-- table's own trigger for every credential; DELETE withheld here is what makes the history
-- as permanent as the moderation ledger above. Reading is the database-wide SELECT.
-- CHAT-003's source link. INSERT only: FR-02 says the link is immutable, and the trigger in
-- 0009 refuses UPDATE for every credential — withholding UPDATE and DELETE here is what
-- makes "immutable" true for the runtime credential specifically, the way it is for the
-- moderation ledger above.
GRANT INSERT                 ON `tmanage`.`message_work_links`   TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`outbox_events`        TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`idempotency_records`  TO 'tmanage_app'@'%';
-- NOTIF-001. UPDATE is for marking read — the trigger in 0010 confines it to `read_at`,
-- forward only. DELETE withheld: "was this person told" must stay answerable.
GRANT INSERT, UPDATE         ON `tmanage`.`notifications`        TO 'tmanage_app'@'%';
-- WORK-003. A dependency is a removable planning edge — the second DELETE this file
-- grants, and like the first (idempotency housekeeping) it destroys no history the audit
-- trail does not keep: the removal is audited. A blocker is a ledger: INSERT to raise,
-- UPDATE (confined by 0011's trigger to the one-time resolution) to resolve, DELETE never.
GRANT INSERT, DELETE         ON `tmanage`.`work_item_dependencies` TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE         ON `tmanage`.`work_blockers`          TO 'tmanage_app'@'%';
-- FILE-001. The counter is reserved, committed and released in place (UPDATE) and seeded
-- once per organization (INSERT); DELETE withheld because a counter that can vanish is a
-- bill that can. A session moves through its lifecycle (UPDATE) and a file asset through
-- 23-ERD §10's (UPDATE); neither is ever removed by the runtime — retention is FILE-003's
-- privileged procedure. A file version was INSERT-only through FILE-001; FILE-002's
-- verification pass runs in the API under this credential (decision F2, the sweeper's
-- precedent) and writes exactly two values on a version, once — `content_hash` and
-- `detected_mime_type`, NULL until then — so UPDATE arrives here with the code that writes
-- them. What keeps the grant narrow is the trigger, not the privilege: 0018 recreates
-- `trg_file_versions_immutable` to pin every other column outright and those two once set,
-- so the runtime credential can move two NULLs and nothing else. DELETE stays withheld.
GRANT INSERT, UPDATE         ON `tmanage`.`usage_counters`   TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE         ON `tmanage`.`file_assets`      TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE         ON `tmanage`.`file_versions`    TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE         ON `tmanage`.`upload_sessions`  TO 'tmanage_app'@'%';

-- ID-002 credentials. `user_passwords` and `user_mfa_factors` need UPDATE — a password is
-- changed in place, and a factor records the counter of the last code it accepted on every
-- successful verification. `user_recovery_codes` needs UPDATE to spend a code and to revoke
-- a superseded batch, and DELETE is withheld: a spent code must stay spent and visible,
-- because "this code was used on the 3rd" is the sentence that distinguishes a legitimate
-- recovery from a stolen one.
GRANT INSERT, UPDATE ON `tmanage`.`user_passwords`      TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE ON `tmanage`.`user_mfa_factors`    TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE ON `tmanage`.`user_recovery_codes` TO 'tmanage_app'@'%';

-- `audit_events` gets INSERT and nothing else: the runtime user may append and read, never
-- amend or remove. The append-only triggers in 0002_platform_primitives.sql enforce the
-- same rule for every other credential, including this script's own migrator — but a
-- trigger is a runtime check and a missing privilege is a structural one, so both exist.
-- Retention and purge are consequently a privileged, separately-credentialed procedure: an
-- audit log the application can quietly trim is not an audit log.
GRANT INSERT ON `tmanage`.`audit_events` TO 'tmanage_app'@'%';

-- `session_refresh_tokens` gets INSERT and nothing else, for the same reason and with more
-- force. The ledger of superseded refresh-token hashes *is* the reuse detector: an attacker
-- who could delete their replayed hash would make a stolen token look merely unknown, and a
-- session compromise would be indistinguishable from a stale browser tab. Append-only
-- triggers in 0003_session_rotation.sql enforce this for every credential; withholding the
-- privileges means the runtime user cannot even make the attempt.
GRANT INSERT ON `tmanage`.`session_refresh_tokens` TO 'tmanage_app'@'%';

-- `authentication_events` gets INSERT and nothing else, for the third time and the same
-- reason. This log is where the precision the API's responses deliberately drop is kept: the
-- caller is told one thing for every sign-in failure so that "no such account" cannot be
-- distinguished from "wrong password", and the specific cause is written here. An
-- application that could amend it could erase the only record of a credential-stuffing run
-- against a customer. Append-only triggers in 0004_credentials.sql cover every other
-- credential; withholding the privilege means this one cannot make the attempt.
GRANT INSERT ON `tmanage`.`authentication_events` TO 'tmanage_app'@'%';

-- `schema_migrations` is named nowhere above, so the runtime user can read the migration
-- ledger and cannot write it — not even to append. Only the migrator records what it
-- applied, which is the property `pnpm db:status` depends on to be trustworthy.

-- ─────────────────────────────────────────────────────────────────────────────
-- Worker user — narrower still
-- ─────────────────────────────────────────────────────────────────────────────
-- The relay marks outbox rows dispatched and appends audit rows; it never deletes domain
-- data and never creates tenants, users, or memberships. DELETE is withheld everywhere so
-- a defective consumer cannot destroy work.
CREATE USER IF NOT EXISTS 'tmanage_worker'@'%' IDENTIFIED BY 'local_dev_only_worker';

-- The relay's reads, one table at a time — D07. The list is the tables named by statements
-- in `apps/worker/src/common/database/` — the one directory in the worker permitted to
-- spell SQL — plus the tables the write grants further down cannot be exercised without
-- (see "Read where it writes"). What the list leaves out is the point: `user_passwords`,
-- `user_mfa_factors`, `user_recovery_codes` and `authentication_events` are unreachable by
-- this credential entirely, so a leaked relay connection string is worth the outbox and
-- the membership rows and not one second factor.

-- The outbox itself: the `FOR UPDATE SKIP LOCKED` claim, the dispatched stamp, the retry
-- schedule and the parked-event report (`outbox-store.ts`).
GRANT SELECT ON `tmanage`.`outbox_events`            TO 'tmanage_worker'@'%';

-- PLAT-004's lifecycle rule reads the request the work item was born from and its version
-- (`lifecycle-store.ts`); NOTIF-002's mail joins the three rows an email renders it with —
-- who submitted it, which studio, which project (`mail-store.ts`). `users` is here for the
-- address and locale on that join and for nothing else; the relay reads no password row,
-- which is a different table and, since D07, a different privilege.
GRANT SELECT ON `tmanage`.`client_requests`          TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`users`                    TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`organizations`            TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`projects`                 TO 'tmanage_worker'@'%';

-- NOTIF-001's recipients. `24-EVENT-CATALOG` §6 forbids a consumer inferring authorization
-- from event receipt, so the audience is recomputed from the *current* membership rows at
-- delivery time — which is why these four are read grants the relay genuinely needs rather
-- than a convenience (`notifications-store.ts`).
GRANT SELECT ON `tmanage`.`memberships`              TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`project_memberships`      TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`client_memberships`       TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`project_clients`          TO 'tmanage_worker'@'%';

-- RT-001's fan-out audience: who is in the conversation, and still in the organization
-- (`realtime-store.ts`). The channel's messages are not read — the frame carries what the
-- socket needs — so `messages` is named nowhere here.
GRANT SELECT ON `tmanage`.`conversations`            TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`conversation_memberships` TO 'tmanage_worker'@'%';

-- Read where it writes. MySQL reads to write: an `UPDATE … WHERE` needs SELECT on the
-- columns it filters by, and the notification insert's `ON DUPLICATE KEY UPDATE id = id`
-- — the dedupe that absorbs an at-least-once replay — reads the row it collided with. A
-- write grant below without the matching read here would be a grant that cannot be used,
-- so the two are kept together for every table the relay may write.
GRANT SELECT ON `tmanage`.`notifications`            TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`work_items`               TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`idempotency_records`      TO 'tmanage_worker'@'%';

-- `audit_events` is the one table the relay writes and cannot read, and the asymmetry is
-- deliberate: it appends system audit rows (`lifecycle-store.ts`) and never reads one back,
-- so SELECT would be privilege granted against no statement. `INSERT` alone, below.

GRANT INSERT, UPDATE ON `tmanage`.`outbox_events`       TO 'tmanage_worker'@'%';
GRANT INSERT, UPDATE ON `tmanage`.`idempotency_records` TO 'tmanage_worker'@'%';
GRANT UPDATE         ON `tmanage`.`work_items`          TO 'tmanage_worker'@'%';
GRANT INSERT         ON `tmanage`.`audit_events`        TO 'tmanage_worker'@'%';
-- PLAT-004's lifecycle consumer: when committed work starts, the linked request moves
-- accepted->planned; when the work is done, planned->delivered (23-ERD §6). UPDATE only —
-- the relay never creates or destroys a request, it advances one a manager accepted.
GRANT UPDATE         ON `tmanage`.`client_requests`     TO 'tmanage_worker'@'%';
-- NOTIF-001's consumer writes the records. INSERT only: marking read is a person's act
-- through the API, never the relay's, and DELETE is withheld everywhere above.
GRANT INSERT         ON `tmanage`.`notifications`       TO 'tmanage_worker'@'%';

-- ─────────────────────────────────────────────────────────────────────────────
-- Migration user
-- ─────────────────────────────────────────────────────────────────────────────
-- Owns the schema. Used only by the migrator, never by a running application process.
-- `packages/config` refuses to boot when DATABASE_URL equals DATABASE_MIGRATION_URL, so
-- collapsing the two into one credential is a validation error rather than a code review
-- someone might skip.
--
-- Created here as well as by `compose.yaml`'s MARIADB_USER, because this file must also
-- work against a server that was not provisioned by that compose file — a CI service
-- container, or a Hostinger database created through the panel. MySQL 8 and MariaDB 10.4+
-- both refuse `GRANT` to a user that does not exist, so the create cannot be skipped.
-- `IF NOT EXISTS` leaves an existing user's password untouched.
CREATE USER IF NOT EXISTS 'tmanage_migrator'@'%' IDENTIFIED BY 'local_dev_only_migrator';

GRANT ALL PRIVILEGES ON `tmanage`.* TO 'tmanage_migrator'@'%';

FLUSH PRIVILEGES;
