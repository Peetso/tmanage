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
-- below is table-level, and MySQL rejects a table-level GRANT naming a table that does
-- not exist (`ER_NO_SUCH_TABLE`, 1146). An earlier revision of
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
-- ## Re-running this file removes privileges as well as adding them — R10
--
-- Until 2026-09-12 this file contained no `REVOKE` at all and created every account with
-- `CREATE USER IF NOT EXISTS`. Both halves are deliberate and both are kept. What was
-- missing is the consequence: MySQL privileges are **additive**, so on a server that had
-- been provisioned by an earlier revision of this file, re-applying it *added* the narrow
-- grants and *left the old wide ones exactly where they were*. The worker's former
-- database-wide `SELECT` survived every re-run, and with it the relay's read of
-- `user_passwords`, `user_mfa_factors`, `user_recovery_codes` and `authentication_events`
-- — the four tables the D07 narrowing exists to take away. The narrowing was a property of
-- freshly created accounts and of nothing else. That is `code-review-2026-09-12/REVIEW.md`
-- **R10 · P1**.
--
-- The fix is one statement per principal, placed immediately after its `CREATE USER` and
-- before its first `GRANT`:
--
--     REVOKE ALL PRIVILEGES, GRANT OPTION FROM '<user>'@'%';
--
-- which strips every global, schema, table, column and routine privilege the account holds,
-- whatever granted it and whenever, leaving the account existing with `USAGE` and nothing
-- more. The grants below then rebuild exactly the intended set. The file is therefore
-- idempotent in the strong sense: **after it runs, each principal holds precisely the
-- privileges enumerated below, and no others** — whether the account was created by this
-- run, by an older revision of this file, or by a hosting panel.
--
-- Three consequences, stated rather than discovered:
--
-- 1. **On a fresh account there is nothing to revoke.** MySQL accepts that silently;
--    MariaDB can answer `ER_REVOKE_GRANTS` (1269) and some servers `ER_NONEXISTING_GRANT`
--    (1141). `apps/api/src/common/database/grants.ts` treats those two errors on a `REVOKE`
--    as the no-op they are and reports them, and fails on anything else. A `REVOKE` here
--    can only address a user the statement directly above it has just created, so neither
--    error can mean "unknown user".
-- 2. **There is a window.** Between the `REVOKE` and the `GRANT`s that follow it, a running
--    application or relay on this credential is refused. It is short — a handful of
--    statements on one connection — but it is real, and `db:grants` is therefore a
--    maintenance action, not a background one. It is safe to re-run; it is not safe to
--    re-run without expecting a few seconds of denied statements.
-- 3. **The applying credential must not be one of these three.** It never was — the section
--    above requires an administrative credential, and `tmanage_migrator` is refused by the
--    very first `CREATE USER` — but the `REVOKE` raises the cost of ignoring that from "the
--    script fails" to "the script would disarm the credential running it". It cannot reach
--    that point: the `CREATE USER` at the top aborts the run first.
--
-- ## What each principal is allowed to hold, in full
--
-- This is the list the verification reads back from the server. A principal holding
-- anything not on its list is a failure, not a variation.
--
-- **`tmanage_app`** — the API process.
--   · `SELECT` on `tmanage`.* (database-wide, and only SELECT; the reason is above)
--   · `INSERT, UPDATE, DELETE` on: organizations, users, sessions, memberships, workspaces,
--     projects, project_memberships, client_organizations, client_memberships,
--     project_clients, work_items, conversation_memberships, outbox_events,
--     idempotency_records, search_index
--   · `INSERT, UPDATE` on: client_requests, invitations, conversations, messages,
--     notifications, notification_preferences, notification_kind_prefs, work_blockers,
--     usage_counters, file_assets,
--     file_versions, upload_sessions, user_passwords, user_mfa_factors, user_recovery_codes,
--     documents, decisions
--     saved_views, meeting_attendees, org_settings
--   · `INSERT, DELETE` on: work_item_dependencies, saved_context, document_template_variables,
--     home_pinned_items, objective_work_links, decision_work_links
--   · `INSERT` on: message_work_links, audit_events, session_refresh_tokens,
--     authentication_events, usage_ledger_entries, meetings, meeting_notes, document_versions,
--     document_comments, decision_supersessions, document_templates, work_forms, onboarding_progress, marketing_leads
--   · nothing at all on `schema_migrations` beyond the database-wide SELECT, nothing on
--     `message_revisions` beyond it, and **no** global privilege, **no** privilege on any
--     other schema, **no** `GRANT OPTION`, **no** schema-modifying privilege anywhere.
--
-- **`tmanage_worker`** — the outbox relay.
--   · `SELECT` on exactly sixteen tables: outbox_events, client_requests, users,
--     organizations, projects, memberships, project_memberships, client_memberships,
--     project_clients, conversations, conversation_memberships, notifications, work_items,
--     idempotency_records, credential_change_notices, invitations — and on **no** others,
--     which is the whole of D07 (invitations added for TEN-003/ON-04's `--sweep-invitations`)
--   · `INSERT, UPDATE` on: outbox_events, idempotency_records
--   · `UPDATE` on: credential_change_notices — x31 drains it; the row is never created or
--     destroyed by the relay, only claimed, stamped and (on failure) rescheduled
--   · `UPDATE` on: work_items, client_requests, invitations — the sweep moves overdue
--     `pending` -> `expired`; no INSERT and no DELETE, an invitation is never created or
--     removed by the relay
--   · `INSERT` on: audit_events, notifications
--   · `DELETE` nowhere, no database-wide grant of any kind, and nothing whatever on
--     `user_passwords`, `user_mfa_factors`, `user_recovery_codes` or
--     `authentication_events`.
--
-- **`tmanage_migrator`** — owns the schema, used only by the migrator.
--   · `ALL PRIVILEGES` on `tmanage`.* and on nothing else
--   · **no** global privilege — in particular no `CREATE USER`, no `GRANT OPTION` at the
--     server level, no `FILE`, `SUPER`, `PROCESS` or `RELOAD` — so it can own one database
--     and cannot provision credentials or reach a neighbouring environment. This is why it
--     cannot apply this file, and the refusal is the control rather than an inconvenience.
--
-- Local development passwords only. Deployed environments provision these users from the
-- secret store; see docs/runbooks/deploy.md. On Hostinger, apply as far as the plan permits
-- and record any shortfall in the environment runbook (50-BOOTSTRAP §4).

-- ─────────────────────────────────────────────────────────────────────────────
-- Runtime user
-- ─────────────────────────────────────────────────────────────────────────────
CREATE USER IF NOT EXISTS 'tmanage_app'@'%' IDENTIFIED BY 'local_dev_only_app';

-- R10. Everything this account holds is taken away here and rebuilt below, so that what it
-- ends up with is what this file says and not the union of this file with every revision
-- that preceded it. `IF NOT EXISTS` above leaves an existing account's password alone; this
-- leaves none of its privileges alone.
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'tmanage_app'@'%';

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
-- FR-05 (x92) deliverable versions. **INSERT only** — a governed version is immutable: FR-05's
-- "changed governed content creates new version" is a new row, never an edit, and the trigger in
-- 0027 refuses UPDATE for every credential. No DELETE: the exact bytes a reviewer saw are the
-- evidence an approval binds to, so a runtime credential must not be able to erase them.
GRANT INSERT                 ON `tmanage`.`deliverable_versions`  TO 'tmanage_app'@'%';
-- FR-05 (x92) approvals. **No DELETE**, and for the same reason as client_requests: a decision is
-- the record that it was taken. UPDATE is needed for the lifecycle (view, decide, invalidate) and
-- for nothing else — the trigger in 0027 refuses the identity columns and refuses any change to a
-- terminal row, so "append-only" holds for the runtime credential specifically (INT-16).
GRANT INSERT, UPDATE         ON `tmanage`.`approvals`             TO 'tmanage_app'@'%';
-- FR-05 (x97) client projections. **INSERT only** — a projection is immutable: publishing freezes
-- one client-safe view of a governed version and there is no edit (25 §7), the trigger in 0031
-- refuses every UPDATE, and a re-publish is a new version's new projection. No DELETE: the exact
-- client-facing bytes are the record of what a client was shown, so a runtime credential must not
-- be able to erase them.
GRANT INSERT                 ON `tmanage`.`client_projections`    TO 'tmanage_app'@'%';
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
-- NOTIF-001 preferences. INSERT to create a person's settings row and UPDATE to replace it in
-- place — the `INSERT ... ON DUPLICATE KEY UPDATE` upsert needs both. **No DELETE**: settings
-- are replaced, never removed, and a row that could vanish is a person quietly reverted to
-- defaults they did not choose. The worker gets nothing here — this table is the API's alone
-- until a delivery slice reads it, and the read grant it would then need is added with that
-- slice, per this file's rule that a grant names a statement that exists.
GRANT INSERT, UPDATE         ON `tmanage`.`notification_preferences` TO 'tmanage_app'@'%';
-- WORK-003. A dependency is a removable planning edge — the second DELETE this file
-- grants, and like the first (idempotency housekeeping) it destroys no history the audit
-- trail does not keep: the removal is audited. A blocker is a ledger: INSERT to raise,
-- UPDATE (confined by 0011's trigger to the one-time resolution) to resolve, DELETE never.
GRANT INSERT, DELETE         ON `tmanage`.`work_item_dependencies` TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE         ON `tmanage`.`work_blockers`          TO 'tmanage_app'@'%';
-- x145 (0051) work item checklist / sub-items. A checklist item is added (INSERT), read (the
-- database-wide SELECT) and toggled or renamed in place (UPDATE) — this slice ships add/list/
-- toggle-rename — so INSERT and UPDATE and **no DELETE**: there is no delete endpoint, least
-- privilege, and the 0051 trigger pins organization_id and work_item_id immutable for every
-- credential besides so UPDATE can move `label`/`done`/`position` and nothing that says what the
-- item *is*. DELETE is added with the code that writes it, per this file's rule that a grant names
-- a statement that exists.
GRANT INSERT, UPDATE         ON `tmanage`.`work_item_checklist_items` TO 'tmanage_app'@'%';
-- x147 work item comments. **INSERT only** — a comment is an append-only record of what was said,
-- when: this slice ships add/list, and neither edit nor delete. Reading is the database-wide
-- SELECT above; the 0053 trigger refuses UPDATE for every credential besides, and no DELETE is
-- granted. Edit/delete arrive with the code that writes them, per this file's rule that a grant
-- names a statement that exists.
GRANT INSERT                 ON `tmanage`.`work_item_comments`     TO 'tmanage_app'@'%';
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
-- USAGE-001 slice 2. The append-only usage ledger: INSERT only, and never UPDATE or DELETE.
-- Reading is the database-wide SELECT (line above). A counter is corrected in place (UPDATE);
-- the ledger that explains how it got there is history, and an application that could amend or
-- erase a ledger row is a bill that can be quietly rewritten — the `audit_events` argument, in
-- the storage-accounting domain. Immutability here is the withheld privilege, not a trigger.
GRANT INSERT                 ON `tmanage`.`usage_ledger_entries` TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE         ON `tmanage`.`file_assets`      TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE         ON `tmanage`.`file_versions`    TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE         ON `tmanage`.`upload_sessions`  TO 'tmanage_app'@'%';
-- CAL-01 / MTG-01 (x90). A meeting is created (INSERT) and read (the database-wide SELECT) and,
-- this slice, never edited or removed: there is no update or delete endpoint, so **no UPDATE and
-- no DELETE** — least privilege, and the 0029 trigger pins organization_id/project_id immutable
-- for every credential besides. When an edit surface lands, UPDATE is added with the code that
-- writes it, per this file's rule that a grant names a statement that exists.
GRANT INSERT                 ON `tmanage`.`meetings`         TO 'tmanage_app'@'%';
-- DOC-01 (x91), extended by DOC-02 (x112). A document is created (INSERT) and read (the
-- database-wide SELECT). DOC-02 adds the editor: saving a new version bumps the document's current
-- body in the same transaction, so **UPDATE lands here now with the code that writes it** — the
-- 0030 trigger still pins organization_id/project_id/created_by_user_id immutable for every
-- credential, so UPDATE can move `title`/`body` and nothing that says what the document *is*. Still
-- **no DELETE**: a document is the studio's knowledge, not something a runtime credential removes.
GRANT INSERT, UPDATE         ON `tmanage`.`documents`        TO 'tmanage_app'@'%';
-- CAL-01 / MTG-01 second slice (x105). A note or decision is captured (INSERT) and read (the
-- database-wide SELECT); this slice has no edit or delete endpoint, so **no UPDATE and no
-- DELETE** — least privilege, and 0033's trigger refuses UPDATE for every credential besides. A
-- captured note is an append-only record. When a decision-lifecycle surface lands (x105-b),
-- UPDATE is added with the code that writes it, per this file's rule that a grant names a
-- statement that exists (the same treatment `meetings` and `documents` have above).
GRANT INSERT                 ON `tmanage`.`meeting_notes`    TO 'tmanage_app'@'%';
-- CAL-01 / MTG-01 attendees + RSVP (x126). An attendee is invited (INSERT) and their RSVP is
-- changed in place (UPDATE) — this slice ships invite/list/RSVP — so INSERT and UPDATE and **no
-- DELETE**: there is no un-invite endpoint, least privilege, and 0042's trigger pins
-- organization_id/meeting_id/membership_id immutable (only `rsvp` may change) for every credential
-- besides. DELETE is added with the code that writes it, per this file's rule that a grant names a
-- statement that exists (the same treatment `saved_views` has above).
GRANT INSERT, UPDATE          ON `tmanage`.`meeting_attendees` TO 'tmanage_app'@'%';
-- CAL recurrence (x129) meeting series. A series is created (INSERT) and read (the database-wide
-- SELECT); this slice has no edit or delete endpoint, so **no UPDATE and no DELETE** — least
-- privilege, and there is no immutability trigger because the withheld privilege is the control
-- (the same treatment `saved_context` has). When an edit/override surface lands (NS-13), the write
-- grant is added with the code that writes it, per this file's rule that a grant names a statement
-- that exists.
GRANT INSERT                 ON `tmanage`.`meeting_series`   TO 'tmanage_app'@'%';
-- WK-08 (x107). A saved view is created (INSERT), read (the database-wide SELECT) and edited in
-- place (UPDATE) — this slice ships create/list/update — so INSERT and UPDATE and **no DELETE**:
-- there is no delete endpoint, least privilege, and the 0034 trigger pins organization_id and
-- owner_user_id immutable for every credential besides. DELETE is added with the code that writes
-- it, per this file's rule that a grant names a statement that exists.
GRANT INSERT, UPDATE          ON `tmanage`.`saved_views`      TO 'tmanage_app'@'%';
-- HOME-05 (0035) saved/pinned context. INSERT to pin and DELETE to unpin, and **no UPDATE**: a
-- pin is created and removed, never edited, so the missing privilege is the control that keeps it
-- so (there is no immutability trigger and none is needed). Reading is the database-wide SELECT
-- above. The worker gets nothing here — this table is the API's alone.
GRANT INSERT, DELETE         ON `tmanage`.`saved_context`    TO 'tmanage_app'@'%';
-- HOME-05 follow-up (0050, x144) membership-scoped Home pins. INSERT to pin and DELETE to unpin, and
-- **no UPDATE**: a pin is created and removed, never edited, so the missing privilege is the control
-- (no immutability trigger, none needed). Reading is the database-wide SELECT above. The worker gets
-- nothing here — this table is the API's alone, the `saved_context` posture above.
GRANT INSERT, DELETE         ON `tmanage`.`home_pinned_items` TO 'tmanage_app'@'%';
-- DOC-02/DOC-03 (x112) document versions. **INSERT only** — a version is an immutable snapshot of
-- the body at a save: DOC-03's restore is a new row (forward-append), never an edit, and the 0036
-- trigger refuses UPDATE for every credential. No DELETE: a document's history is the record of how
-- it changed, so a runtime credential must not be able to erase it (the `deliverable_versions`
-- posture above).
GRANT INSERT                 ON `tmanage`.`document_versions` TO 'tmanage_app'@'%';
-- Docs "collaboration later" (0045, x132) document comments. **INSERT only** — a comment is captured
-- (INSERT) and read (the database-wide SELECT). This slice ships no edit/delete path, and the 0045
-- trigger refuses UPDATE for every credential besides; edit/delete is a later slice (NEXT-SCOPES-13)
-- that adds the privilege with the code that writes it. No DELETE.
GRANT INSERT                 ON `tmanage`.`document_comments` TO 'tmanage_app'@'%';
-- DOC-04/ADM-06 (x119) document templates. **INSERT only** — a template is created (INSERT) and
-- read (the database-wide SELECT). This slice ships no editor and no removal path, and the 0039
-- trigger pins organization_id/created_by_user_id immutable for every credential; an editor is a
-- later slice that adds UPDATE with the code that writes it. No DELETE.
GRANT INSERT                 ON `tmanage`.`document_templates` TO 'tmanage_app'@'%';
-- CLIENT-003 (x125, 0041). A project update is posted (INSERT) and read (the database-wide
-- SELECT above); `published` is set at INSERT time, and this slice ships no edit/unpublish
-- endpoint, so **no UPDATE and no DELETE** — least privilege, and the 0041 trigger pins
-- organization_id/project_id/created_by_user_id immutable for every credential besides. When the
-- publish/unpublish lifecycle lands (NEXT-SCOPES-12), UPDATE is added with the code that writes
-- it, per this file's rule that a grant names a statement that exists (the same treatment
-- `meetings` and `documents` have above).
GRANT INSERT                 ON `tmanage`.`project_updates`  TO 'tmanage_app'@'%';
-- DOC-04 (x130) document template variables. **INSERT and DELETE** — a variable is added (INSERT)
-- and removed (DELETE), read (the database-wide SELECT), and **never edited**: this slice ships no
-- editor, so no UPDATE, and the 0044 trigger pins organization_id/template_id immutable for every
-- credential besides. UPDATE is added with the code that writes it, per this file's rule that a
-- grant names a statement that exists.
GRANT INSERT, DELETE         ON `tmanage`.`document_template_variables` TO 'tmanage_app'@'%';
-- Portal milestones (x139, 0048). A milestone is created (INSERT) and read (the database-wide
-- SELECT above); `status` and `published` are set at INSERT time, and this slice ships no
-- edit/unpublish endpoint, so **no UPDATE and no DELETE** — least privilege, and the 0048 trigger
-- pins organization_id/project_id/created_by_user_id immutable for every credential besides. When
-- the edit/unpublish lifecycle lands (NEXT-SCOPES-13), UPDATE is added with the code that writes
-- it, per this file's rule that a grant names a statement that exists (the same treatment
-- `project_updates`, `meetings` and `documents` have above).
GRANT INSERT                 ON `tmanage`.`project_milestones` TO 'tmanage_app'@'%';
-- Portal risks (x140, 0049). A risk is recorded (INSERT) and read (the database-wide SELECT above);
-- `severity`, `status`, `internal_note`, `client_summary` and `published` are set at INSERT time, and
-- this slice ships no edit/unpublish endpoint, so **no UPDATE and no DELETE** — least privilege, and
-- the 0049 trigger pins organization_id/project_id/created_by_user_id immutable for every credential
-- besides. When the edit/unpublish lifecycle lands (NEXT-SCOPES-13), UPDATE is added with the code
-- that writes it, per this file's rule that a grant names a statement that exists (the same treatment
-- `project_updates`, `project_milestones`, `meetings` and `documents` have above).
GRANT INSERT                 ON `tmanage`.`project_risks`     TO 'tmanage_app'@'%';
-- WORK intake forms (x146). **INSERT only** — a work form is created (INSERT) and read (the
-- database-wide SELECT). This slice ships no editor and no removal path; the 0052 trigger pins
-- organization_id/created_by immutable for every credential, and an editor is a later slice that
-- adds UPDATE with the code that writes it. No DELETE. Submitting a form writes no work_forms row —
-- it creates a `work_items` row through the existing work path, which is granted above.
GRANT INSERT                 ON `tmanage`.`work_forms`        TO 'tmanage_app'@'%';
-- SRCH ranking (x148) search index. INSERT, UPDATE and DELETE: the index is a rebuildable mirror of
-- work items and documents, kept fresh by reindexing a source row (INSERT … ON DUPLICATE KEY UPDATE
-- refreshes title/body/audience/updated_at in place) and dropped when its source is removed. It is
-- not a record of anything — it holds no truth the source tables do not — so unlike the append-only
-- tables above there is no history to protect: DELETE is granted so a purge or a removed source can
-- clear its index row. The 0054 trigger pins organization_id/target_kind/target_id immutable for
-- every credential, so UPDATE can only refresh the searchable fields, never repoint a row.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`search_index`      TO 'tmanage_app'@'%';
-- Per-kind notification opt-out (x152, 0057). **INSERT and UPDATE** — the setting is an upsert
-- (`INSERT ... ON DUPLICATE KEY UPDATE`), which needs both, the `notification_preferences` posture
-- above. **No DELETE**: a preference is set and re-set, never removed by a runtime session — a row
-- that could vanish is a person quietly reverted to a default they did not choose. Reading is the
-- database-wide SELECT above. The worker gets nothing here — this table is the API's alone until a
-- delivery slice reads it.
GRANT INSERT, UPDATE         ON `tmanage`.`notification_kind_prefs` TO 'tmanage_app'@'%';
-- Organization settings / policy (0058, x153). **INSERT and UPDATE** — a setting is set (INSERT) and
-- changed in place (UPDATE), the two halves of the upsert (`INSERT ... ON DUPLICATE KEY UPDATE`), and
-- read (the database-wide SELECT above). **No DELETE** — a setting is set and changed, never removed
-- by a runtime credential; clearing one back to its default is a later slice that adds the privilege
-- with the code that writes it. The 0058 trigger pins organization_id/setting_key immutable for every
-- credential besides, so UPDATE can move only the value (and who set it, and when).
GRANT INSERT, UPDATE         ON `tmanage`.`org_settings`      TO 'tmanage_app'@'%';
-- ON-10 guided-tour progress (x155, 0059). **INSERT only** — a step is marked complete (INSERT) and
-- read (the database-wide SELECT). Progress is forward-only: re-completing a step is an idempotent
-- no-op the repository swallows on the unique-key conflict, never an UPDATE, and there is no
-- un-complete path, so no DELETE. The withheld UPDATE and DELETE are the immutability control (no
-- trigger needed). The worker gets nothing here — this table is the API's alone.
GRANT INSERT                 ON `tmanage`.`onboarding_progress` TO 'tmanage_app'@'%';
-- x160 public changelog (0061), GLOBAL (org-less). **No app write grant at all** — the public
-- `GET /v1/public/site/changelog` route only reads, and reading is the database-wide SELECT above.
-- No INSERT/UPDATE/DELETE this slice: entries are authored by a later admin slice, which adds the
-- write grant with the code that writes it (this file's rule that a grant names a statement that
-- exists). The decision is recorded in users-sql.test.ts's `withheldOnPurpose`, since the schema
-- gate requires every table to be either granted or deliberately withheld.

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

-- `credential_change_notices` (D05d) gets INSERT, and for once that is not an append-only
-- argument: the queue's rows *are* updated, by the relay, when a notice is delivered. The
-- runtime user is the producer and only the producer — it appends the notice inside the
-- transaction that changed the credential and has no business stamping one delivered, so
-- the UPDATE it would need for that is withheld. `SELECT` it already holds database-wide
-- (line 60), which is what `GET /v1/auth/security-activity` reads through.
--
-- The relay's side of this table is deliberately absent from the worker block below: the
-- consumer that drains it is not built yet, and this file's own rule is that a grant names
-- a statement that exists. Adding the drain means adding SELECT and UPDATE there, and
-- `least-privilege.db.test.ts` will need the pair asserted the way the outbox's are.
GRANT INSERT ON `tmanage`.`credential_change_notices` TO 'tmanage_app'@'%';

-- `marketing_leads` (x161) gets INSERT and nothing else. The public contact door writes one lead
-- row and never reads, amends or deletes it at runtime: there is no listing/read endpoint in this
-- slice (email delivery is Needs-Peter, and an admin viewer is a later slice with its own SELECT).
-- GLOBAL / org-less, so it is in the tenant guard's NON_TENANT_TABLES; SELECT stays absent here so
-- no runtime credential can enumerate the leads.
GRANT INSERT ON `tmanage`.`marketing_leads` TO 'tmanage_app'@'%';

-- `import_jobs` (ON-09) gets INSERT for the validate/dry-run half (one attempt row per
-- validation) and UPDATE for the commit half (x100): committing a validated job transitions its
-- `status` to 'committed' / 'committed_with_errors' and stamps `committed_at` / `committed_count`
-- / `failed_count` in place — a single UPDATE on an existing row, not a new one. DELETE stays
-- withheld: an attempt, once recorded, is history. `SELECT` it already holds database-wide (line
-- 60), which the job read-back uses.
GRANT INSERT, UPDATE ON `tmanage`.`import_jobs` TO 'tmanage_app'@'%';
-- `import_rows` (ON-09 commit half, x100) gets INSERT and nothing else. It is the per-row receipt
-- (ADM-10): the commit appends one row per source row — created or failed — and never amends it,
-- so UPDATE and DELETE are withheld the way the append-only ledgers above are. `SELECT` is the
-- database-wide grant (line 60), which the receipt read-back uses.
GRANT INSERT ON `tmanage`.`import_rows` TO 'tmanage_app'@'%';
-- `incidents` (Public & trust site, x159, 0060) gets NO write grant. It is a GLOBAL, org-less table
-- and this slice ships the public status READ only — the read runs through the database-wide SELECT
-- (line 60), which is all the public page needs. There is no runtime write path yet: a future admin
-- slice that drafts/publishes incidents adds INSERT (and, for editing, UPDATE) here with the code
-- that writes it, per this file's rule that a grant names a statement that exists. No line is emitted
-- now precisely because none exists to name.
-- `decisions` (DEC-01, x113) gets INSERT, and now UPDATE (DEC-01-b, x117). A decision is authored
-- (INSERT), read (the database-wide SELECT, line 60), and moved through its lifecycle (UPDATE):
-- `proposed → accepted` on accept and `→ superseded` on supersede. UPDATE writes exactly `status`;
-- the 0038 column-pinning trigger (`trg_decisions_immutable`) refuses every other column at the
-- engine, so "a decision's substance is immutable" holds for the runtime credential specifically.
-- **No DELETE**: a decision on the register is the durable record of a choice the project made.
GRANT INSERT, UPDATE ON `tmanage`.`decisions` TO 'tmanage_app'@'%';
-- `decision_supersessions` (DEC-01-b / DEC-02, x117) gets INSERT and nothing else. The supersede
-- edge is authored once (INSERT) and read (the database-wide SELECT); it is immutable (the 0038
-- trigger refuses every UPDATE) and never removed, so UPDATE and DELETE are withheld the way the
-- append-only edges and ledgers above are.
GRANT INSERT ON `tmanage`.`decision_supersessions` TO 'tmanage_app'@'%';
-- `decision_work_links` (DEC / module 12, x149) gets INSERT and DELETE. An edge is created (link)
-- and removed (unlink), never edited — there is no column to change on a link, so **no UPDATE** — the
-- posture `objective_work_links` and `work_item_dependencies` carry. Reading is the database-wide
-- SELECT above.
GRANT INSERT, DELETE ON `tmanage`.`decision_work_links` TO 'tmanage_app'@'%';
-- `decision_locks` (SEC / Decisions, x150) gets INSERT and nothing else. A lock is authored once
-- (INSERT), read (the database-wide SELECT, line 60) to enforce the write boundary and to refuse a
-- re-lock; it is immutable (the 0056 trigger refuses every UPDATE) and never lifted this slice, so
-- UPDATE and DELETE are withheld the way the append-only edges and ledgers above are.
GRANT INSERT ON `tmanage`.`decision_locks` TO 'tmanage_app'@'%';
-- `project_objectives` (PROJ / module 8, x124) gets INSERT and UPDATE. An objective is created
-- (INSERT), read (the database-wide SELECT, line 60), and moved through its lifecycle (UPDATE):
-- `open → met` or `open → missed`. UPDATE writes exactly `status`; the 0040 column-pinning trigger
-- (`trg_project_objectives_pin_columns`) refuses every other column at the engine, so an objective's
-- name, description, target and authorship are immutable for the runtime credential specifically.
-- **No DELETE**: an objective is the durable record of what the project set out to do.
GRANT INSERT, UPDATE ON `tmanage`.`project_objectives` TO 'tmanage_app'@'%';
-- `org_objectives` (PROJ / module 8, x136) gets INSERT and UPDATE, the same posture as
-- `project_objectives`. An org objective is created (INSERT), read (the database-wide SELECT, line
-- 60), and moved through its lifecycle (UPDATE): `open → met` or `open → missed`. UPDATE writes
-- exactly `status`; the 0046 column-pinning trigger (`trg_org_objectives_pin_columns`) refuses every
-- other column at the engine, so an objective's name, description, target and authorship are
-- immutable for the runtime credential specifically. **No DELETE**: an objective is the durable
-- record of what the organization set out to do.
GRANT INSERT, UPDATE ON `tmanage`.`org_objectives` TO 'tmanage_app'@'%';
-- `objective_work_links` (PROJ / module 8, x138) gets INSERT and DELETE. An edge is created (link)
-- and removed (unlink), never edited — there is no column to change on a link, so **no UPDATE** — the
-- posture `work_item_dependencies` and `saved_context` carry. Reading is the database-wide SELECT
-- above.
GRANT INSERT, DELETE ON `tmanage`.`objective_work_links` TO 'tmanage_app'@'%';

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

-- R10, and this is the account the finding was about. Before this statement existed, an
-- installation provisioned under the pre-D07 revision kept a database-wide GRANT SELECT
-- through every re-run of `db:grants`, so the fourteen named grants below were added on top
-- of a database-wide read that already covered them — and covered the four credential
-- tables they deliberately omit. The narrowing only became true of such an installation
-- when this line was added.
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'tmanage_worker'@'%';

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

-- `D05d` / x31: the credential-change notice queue, drained by the same dispatcher over its
-- own table (`notice-store.ts`). SELECT and UPDATE and nothing else — the API is the only
-- writer of a notice (INSERT is `tmanage_app`'s, further up) and DELETE is withheld from this
-- account everywhere. The queue's presence here does **not** widen what a leaked relay
-- credential is worth: 0020 keeps every secret, address and user agent out of the table, and
-- `user_passwords`, `user_mfa_factors`, `user_recovery_codes` and `authentication_events`
-- remain unreachable by this account entirely.
GRANT SELECT ON `tmanage`.`credential_change_notices` TO 'tmanage_worker'@'%';

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
-- TEN-003/ON-04 invitation sweep. Read where it writes: `--sweep-invitations`
-- (`invitations-sweep-store.ts`) filters by `status` and `expires_at`. No DELETE.
GRANT SELECT ON `tmanage`.`invitations`              TO 'tmanage_worker'@'%';

-- `audit_events` is the one table the relay writes and cannot read, and the asymmetry is
-- deliberate: it appends system audit rows (`lifecycle-store.ts`) and never reads one back,
-- so SELECT would be privilege granted against no statement. `INSERT` alone, below.

GRANT INSERT, UPDATE ON `tmanage`.`outbox_events`       TO 'tmanage_worker'@'%';
-- x31's drain: `attempts`, `available_at`, `last_error`, `published_at`. No INSERT — the
-- notice is written by the transaction that changed the credential, on the API's credential.
GRANT UPDATE         ON `tmanage`.`credential_change_notices` TO 'tmanage_worker'@'%';
GRANT INSERT, UPDATE ON `tmanage`.`idempotency_records` TO 'tmanage_worker'@'%';
GRANT UPDATE         ON `tmanage`.`work_items`          TO 'tmanage_worker'@'%';
-- TEN-003/ON-04 invitation sweep. UPDATE only — `--sweep-invitations` moves overdue
-- `pending` -> `expired` across all tenants by the DB clock; DELETE withheld, an
-- invitation is never removed (the trigger in 0005 pins the two immutable columns).
GRANT UPDATE         ON `tmanage`.`invitations`          TO 'tmanage_worker'@'%';
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
-- Created here as well as by `compose.yaml`'s MYSQL_USER, because this file must also
-- work against a server that was not provisioned by that compose file — a CI service
-- container, or a Hostinger database created through the panel. MySQL refuses `GRANT` to
-- a user that does not exist, so the create cannot be skipped.
-- `IF NOT EXISTS` leaves an existing user's password untouched.
CREATE USER IF NOT EXISTS 'tmanage_migrator'@'%' IDENTIFIED BY 'local_dev_only_migrator';

-- R10, and least obviously needed of the three, which is why it is here. `ALL PRIVILEGES ON
-- `tmanage`.*` is a superset of anything an older revision of this file granted at the
-- schema level, so re-applying without a revoke leaves this account *looking* correct. What
-- it does not cover is a **global** privilege — `GRANT ALL ON *.*`, or the `CREATE USER` a
-- panel or a well-meaning operator may have added so that the migrator could "just run the
-- grants file". That is precisely the privilege this account must not have, because its
-- absence is what makes provisioning credentials a separate administrative act. A schema
-- grant below can never take a global privilege away; this line does.
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'tmanage_migrator'@'%';

GRANT ALL PRIVILEGES ON `tmanage`.* TO 'tmanage_migrator'@'%';

FLUSH PRIVILEGES;
