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
-- place. `SELECT` is the one exception: it is granted database-wide because a read of any
-- table is not a privilege escalation, and because a new module's tables would otherwise
-- be unreadable until someone remembered to amend this file. Writes get no such courtesy —
-- a table this file does not name cannot be written by the application at all, and that
-- failure is loud.
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
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`outbox_events`        TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`idempotency_records`  TO 'tmanage_app'@'%';

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

GRANT SELECT ON `tmanage`.* TO 'tmanage_worker'@'%';

GRANT INSERT, UPDATE ON `tmanage`.`outbox_events`       TO 'tmanage_worker'@'%';
GRANT INSERT, UPDATE ON `tmanage`.`idempotency_records` TO 'tmanage_worker'@'%';
GRANT UPDATE         ON `tmanage`.`work_items`          TO 'tmanage_worker'@'%';
GRANT INSERT         ON `tmanage`.`audit_events`        TO 'tmanage_worker'@'%';

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
