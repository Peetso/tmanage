-- Least-privilege database users — ADR-0001 layer 2.
--
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md §5:
--   "Separate migration and runtime database users. The runtime user has only the DML
--    privileges the application needs and cannot alter schema, grant privileges, create
--    users, or access other databases."
--
-- MariaDB has no row-level security, so the credential boundary is one of the few controls
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
-- below is table-level, and MariaDB rejects a table-level GRANT naming a table that does
-- not exist (`ER_NO_SUCH_TABLE`, 1146 — observed on 11.8.9). An earlier revision of
-- `compose.yaml` mounted this file into `/docker-entrypoint-initdb.d/`, which runs on the
-- server's *first boot* — necessarily before any migration. That mount could never have
-- succeeded, and has been removed rather than worked around by loosening the grants.
--
-- ## Why every grant is table-level
--
-- MariaDB privileges are additive and cannot be revoked for a single table once granted
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
-- missing is the consequence: MariaDB privileges are **additive**, so on a server that had
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
-- One MariaDB qualification. The `REVOKE` takes away what is granted *to the account*; it
-- does not take away what the account holds through a role, and since MariaDB 10.11 every
-- account holds whatever is granted to the built-in `PUBLIC` role. A default
-- `mariadb-install-db` grants `PUBLIC` full rights on the `test` and `test\_%` schemas
-- (observed on 11.8.9), and a `GRANT … TO PUBLIC` on `tmanage` would hand every principal
-- here that privilege behind this file's back. This file does not touch `PUBLIC` — it is
-- server-wide state, owned by whoever administers the server — so
-- `apps/api/test/least-privilege.db.test.ts` asserts that `PUBLIC` holds nothing on the
-- `tmanage` schema, and a server's `test` grants are a provisioning matter for its owner.
--
-- Three consequences, stated rather than discovered:
--
-- 1. **On a fresh account there is nothing to revoke.** MariaDB 11.8 accepts that
--    silently — no error and no warning on 11.8.9, so `pnpm db:grants` reports no no-op
--    revokes even on a first run. Other MariaDB releases and configurations can answer
--    `ER_REVOKE_GRANTS` (1269) or `ER_NONEXISTING_GRANT` (1141), and
--    `apps/api/src/common/database/grants.ts` treats those two errors on a `REVOKE` as the
--    no-op they are and reports them, and fails on anything else. A `REVOKE` here
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
--     idempotency_records, search_index, meeting_occurrence_overrides
--     idempotency_records, search_index, meeting_occurrence_overrides, user_shortcut_prefs
--   · `INSERT, UPDATE` on: client_requests, invitations, conversations, messages,
--     notifications, notification_preferences, notification_kind_prefs, work_blockers,
--     usage_counters, file_assets,
--     notifications, notification_preferences, user_preferences, work_blockers, usage_counters, file_assets,
--     file_versions, upload_sessions, user_passwords, user_mfa_factors, user_recovery_codes,
--     documents, decisions
--     saved_views, meeting_attendees, org_settings
--     saved_views, meeting_attendees, a11y_preferences
--     saved_views, meeting_attendees, org_settings, org_policies
--     saved_views, meeting_attendees, a11y_preferences, pref_quiet_hours
--     saved_views, meeting_attendees, org_settings, security_settings
--     saved_views, meeting_attendees, a11y_preferences, home_widget_prefs
--     saved_views, meeting_attendees, a11y_preferences, pref_quiet_hours, pref_digest
--     saved_views, meeting_attendees, a11y_preferences, home_widget_prefs, insight_dashboard_layouts
--   · `INSERT, DELETE` on: work_item_dependencies, saved_context, document_template_variables,
--     home_pinned_items, objective_work_links, decision_work_links
--     documents, decisions, work_item_checklist_items, billing_profiles
--     documents, decisions, billing_seats
--     saved_views, meeting_attendees
--   · `INSERT, DELETE` on: work_item_dependencies, saved_context, document_template_variables, home_pinned_items, person_skills, person_certifications
--   · `INSERT, DELETE` on: work_item_dependencies, work_item_files, saved_context,
--     document_template_variables, home_pinned_items, objective_work_links, decision_work_links
--     saved_views, meeting_attendees, member_profiles
--   · `INSERT, DELETE` on: work_item_dependencies, saved_context, document_template_variables, home_pinned_items
--     document_template_variables, home_pinned_items, objective_work_links, decision_work_links,
--     member_admin_notes
--   · `INSERT` on: message_work_links, audit_events, session_refresh_tokens,
--     authentication_events, usage_ledger_entries, meetings, meeting_notes, document_versions,
--     document_comments, decision_supersessions, document_templates, work_forms, onboarding_progress, marketing_leads
--     document_comments, decision_supersessions, document_templates, work_forms,
--     workflow_templates, workflow_runs, workflow_conditions
--     document_comments, decision_supersessions, document_templates, work_forms,
--     integration_connections
--     document_comments, decision_supersessions, document_templates, work_forms,
--     project_risks, person_allocations
--     document_comments, decision_supersessions, document_templates, work_forms, onboarding_progress,
--     custom_roles
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
--
-- Company erasure (H3, audit gap 8) is deliberately NOT given DELETE here. `CompanyErasure`
-- (`privacy-erasure.repository.ts`) deletes every row of a closed company from each tenant table
-- outside its RETAINED_TABLES, on the tenant pool — today this account. Roughly half of those
-- tables withhold DELETE from this account on purpose (approvals, deliverable_versions,
-- client_projections, invitations, messages, ...: "a runtime credential must not erase the
-- record"), so widening it would undo those decisions for every request the API serves. On a
-- deployment with these split users the erasure therefore reports `not_permitted` and leaves
-- `purged_at` NULL rather than forcing anything. The least-privilege answer is a separate purge
-- principal (SELECT + DELETE on exactly the erasable tables, nothing else) used only by the
-- erasure pool; it needs the privacy module wired to its own URL and the grant tests' probe
-- lists extended, so it is not created here until that lands. Hostinger runs one database user
-- and is unaffected.
GRANT SELECT ON `tmanage`.* TO 'tmanage_app'@'%';

GRANT INSERT, UPDATE, DELETE ON `tmanage`.`organizations`        TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`users`                TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`sessions`             TO 'tmanage_app'@'%';
-- 0202 personal access tokens. INSERT (create), UPDATE (record last use, soft-revoke), SELECT
-- (via the database-wide read). **No DELETE**: a token is retired by setting `revoked_at`, so
-- the row — and its audit value — survives, the same posture the credential tables take.
GRANT INSERT, UPDATE ON `tmanage`.`personal_access_tokens`       TO 'tmanage_app'@'%';
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
-- 0211 deliverables (audit gap 1). INSERT to create one, UPDATE for its title/description and
-- `updated_at` when a new version lands. No DELETE: approvals and client projections refer to it.
GRANT INSERT, UPDATE         ON `tmanage`.`deliverables`          TO 'tmanage_app'@'%';
-- FR-05 (x92) approvals. **No DELETE**, and for the same reason as client_requests: a decision is
-- the record that it was taken. UPDATE is needed for the lifecycle (view, decide, invalidate) and
-- for nothing else — the trigger in 0027 refuses the identity columns and refuses any change to a
-- terminal row, so "append-only" holds for the runtime credential specifically (INT-16).
GRANT INSERT, UPDATE         ON `tmanage`.`approvals`             TO 'tmanage_app'@'%';
-- Sequential approval steps (x315, 0183). **INSERT, UPDATE** — define the ordered chain (INSERT) and
-- record a step's decision (UPDATE: state/decided_by/decided_at). No DELETE: a chain and its
-- decisions are the record of how an approval advanced, so a runtime credential must not erase them.
-- SELECT is the database-wide read grant above; the 0183 trigger holds the identity columns immutable.
GRANT INSERT, UPDATE         ON `tmanage`.`approval_steps`        TO 'tmanage_app'@'%';
-- 0235 (wave 9 S5, F15) per-reviewer decisions. **INSERT only**: a reviewer's decision is evidence,
-- never edited or removed. The approval row carries the aggregate; SELECT is the read grant above.
GRANT INSERT                 ON `tmanage`.`approval_reviewer_decisions` TO 'tmanage_app'@'%';
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
-- A1 (0218): projects an invited person joins on acceptance. Written once at issue (INSERT);
-- never updated or deleted (0218's trigger pins every identity column), so INSERT only.
GRANT INSERT                 ON `tmanage`.`invitation_projects`   TO 'tmanage_app'@'%';
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
-- x247 chat pins. A pin is created (pin) and removed (unpin), never edited: INSERT and DELETE,
-- and **no UPDATE** — there is no repository UPDATE path, so the withheld privilege is the control.
-- Curating a channel's pinned context is `conversation.moderate`; the pinned row is a reference, not
-- a copy of the message, so removing it removes nothing the moderation ledger needs to keep.
GRANT INSERT, DELETE         ON `tmanage`.`conversation_pinned_messages` TO 'tmanage_app'@'%';
-- x251 chat message drafts. A member's unsent composer draft, upserted whole against
-- `uq_conversation_message_drafts_identity`. DELETE is granted here: clearing a draft on send or
-- discard is an ordinary removal, and a draft is no record — nothing is lost that mattered.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`conversation_message_drafts` TO 'tmanage_app'@'%';

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
-- x246 message reactions. INSERT and DELETE, and NO UPDATE: a reaction is added and removed,
-- never edited — the emoji is the row — so withholding UPDATE is what keeps a reaction's
-- identity fixed for the runtime credential. Reading the tally is the database-wide SELECT.
GRANT INSERT, DELETE         ON `tmanage`.`message_reactions`    TO 'tmanage_app'@'%';
-- x249 thread replies. INSERT only: the table is append-only (planning ref CH-05), the trigger
-- in 0121 refuses UPDATE for every credential, and withholding UPDATE and DELETE here is what
-- makes "a reply, once said, is said" true for the runtime credential. Reading is the
-- database-wide SELECT.
GRANT INSERT                 ON `tmanage`.`conversation_thread_replies` TO 'tmanage_app'@'%';
-- Conversation read-state (0122, x250). **INSERT, UPDATE** — a member's last-read position in a
-- channel is created and then replaced in place by an `INSERT ... ON DUPLICATE KEY UPDATE` upsert
-- against `uq_conversation_read_state_member`. No DELETE: a read position is only ever advanced,
-- never removed. SELECT is the database-wide grant.
GRANT INSERT, UPDATE         ON `tmanage`.`conversation_read_state` TO 'tmanage_app'@'%';
-- CH-09 conversation mute (x252, module Chat). **INSERT, UPDATE** — a member's mute state for a
-- conversation is created and then flipped in place by an `INSERT ... ON DUPLICATE KEY UPDATE`
-- upsert against `uq_conversation_mutes_org_conv_membership`. No DELETE: a member unmutes by saving
-- `false`, not by removing the row. SELECT is the database-wide grant.
GRANT INSERT, UPDATE         ON `tmanage`.`conversation_mutes`   TO 'tmanage_app'@'%';
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
-- PREF-001 appearance & accessibility preferences (x182). INSERT to create a member's settings row
-- and UPDATE to replace it in place — the `INSERT ... ON DUPLICATE KEY UPDATE` upsert needs both.
-- **No DELETE**: settings are replaced, never removed, so a member cannot be silently reverted to
-- defaults they did not choose. Reading is the database-wide SELECT.
GRANT INSERT, UPDATE         ON `tmanage`.`user_preferences`     TO 'tmanage_app'@'%';
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
-- x307 (0175) work item subtasks / breakdown. A subtask is added (INSERT), read (the database-wide
-- SELECT), toggled/renamed/reordered in place (UPDATE) and removed (DELETE) — this slice ships
-- add/list/edit/delete — so INSERT, UPDATE and DELETE. The 0175 trigger pins `organization_id` and
-- `parent_work_item_id` immutable for every credential besides, so UPDATE can move
-- `title`/`is_done`/`position` and nothing that says what the subtask *is*.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`work_item_subtasks`      TO 'tmanage_app'@'%';
-- x147 work item comments. **INSERT only** — a comment is an append-only record of what was said,
-- when: this slice ships add/list, and neither edit nor delete. Reading is the database-wide
-- SELECT above; the 0053 trigger refuses UPDATE for every credential besides, and no DELETE is
-- granted. Edit/delete arrive with the code that writes them, per this file's rule that a grant
-- names a statement that exists.
GRANT INSERT                 ON `tmanage`.`work_item_comments`     TO 'tmanage_app'@'%';
-- `request_comments` (Requests / module 11, x299) gets INSERT and DELETE. An internal comment on a
-- client request is authored (INSERT), read (the database-wide SELECT, line 60) and — because a
-- studio may retract an internal note — removed (DELETE), but never edited: the 0167 `BEFORE UPDATE`
-- trigger refuses every amendment, so **no UPDATE**, the append-with-retract posture of the typed
-- edges above (deleting a parent deletes its replies first, so the RESTRICT self-reference holds).
GRANT INSERT, DELETE         ON `tmanage`.`request_comments`        TO 'tmanage_app'@'%';
-- 0212 `request_messages` (audit gap 4) gets **INSERT only**: a message said to a client is a
-- record and is neither edited nor retracted; reading is the database-wide SELECT. The 0212
-- `BEFORE UPDATE` trigger refuses amendment for every credential besides.
GRANT INSERT                 ON `tmanage`.`request_messages`        TO 'tmanage_app'@'%';
-- A8 (0221) `request_message_files` gets **INSERT only**, like the message it hangs off: what was
-- attached to a message is part of the record. The 0221 `BEFORE UPDATE` trigger refuses amendment.
GRANT INSERT                 ON `tmanage`.`request_message_files`   TO 'tmanage_app'@'%';
-- C7 (0228) `attachment_versions` gets **INSERT only**: a version of a plain attachment is the
-- record of how the file changed; the 0228 trigger refuses UPDATE and no credential may DELETE.
GRANT INSERT                 ON `tmanage`.`attachment_versions`     TO 'tmanage_app'@'%';
-- 0214 direct messages (BK3, COL-03). `direct_conversations` gets **INSERT, UPDATE**: a pair row is
-- created once and its `next_sequence_no` / `last_message_at` move on every post; never deleted.
-- `direct_messages` gets **INSERT only** — append-only, and the 0214 `BEFORE UPDATE` trigger refuses
-- amendment for every credential. SELECT is the database-wide grant.
GRANT INSERT, UPDATE         ON `tmanage`.`direct_conversations`    TO 'tmanage_app'@'%';
GRANT INSERT                 ON `tmanage`.`direct_messages`         TO 'tmanage_app'@'%';
-- x180 (0077) billing profile. Module 19: exactly one billing profile per organization, created and
-- edited in place through `INSERT ... ON DUPLICATE KEY UPDATE` — so INSERT and UPDATE and **no
-- DELETE**: there is no delete endpoint (a profile is edited, never removed by a runtime credential),
-- least privilege, and the 0077 trigger pins `organization_id` immutable for every credential besides
-- so UPDATE can move the contact/tax id/address and nothing that says which tenant the profile is.
GRANT INSERT, UPDATE         ON `tmanage`.`billing_profiles`      TO 'tmanage_app'@'%';
-- x199 (0082) billing contacts. Module 19: the org's nominated billing/notification contacts, added
-- (INSERT), read (the database-wide SELECT) and removed (DELETE) — so INSERT and DELETE and **no
-- UPDATE**: a contact is added and removed, never edited in place (to change one, remove it and add
-- it again), least privilege, and the 0082 trigger pins `organization_id` immutable for every
-- credential besides so identity cannot move even were UPDATE granted.
GRANT INSERT, DELETE         ON `tmanage`.`billing_contacts`      TO 'tmanage_app'@'%';
-- x283 (0152) billing tax / legal-entity details. Module 19: exactly one row per organization, created
-- and edited in place through `INSERT ... ON DUPLICATE KEY UPDATE` — so INSERT and UPDATE and **no
-- DELETE**: there is no delete endpoint (the entity is edited, never removed by a runtime credential),
-- least privilege, and the 0152 trigger pins `organization_id` immutable for every credential besides
-- so UPDATE can move the legal/tax fields and nothing that says which tenant the row is. SELECT comes
-- from the database-wide grant above.
GRANT INSERT, UPDATE         ON `tmanage`.`billing_tax_details`   TO 'tmanage_app'@'%';
-- x204 (0085) work item links. A typed link is added (INSERT), read (the database-wide SELECT) and
-- removed (DELETE) — this slice ships add/list/remove — so INSERT and DELETE and **no UPDATE**: a
-- typed edge is immutable, correcting one is delete-and-add, and the 0085 trigger refuses UPDATE for
-- every credential besides. DELETE destroys the only record of the link, but it is a planning edge
-- the way `work_item_dependencies` is, removable by the member who owns the work.
GRANT INSERT, DELETE         ON `tmanage`.`work_item_links`        TO 'tmanage_app'@'%';
-- x205 work item file attachments. A link is attached (INSERT) and detached (DELETE) — this
-- slice ships attach/list/detach — so INSERT and DELETE and **no UPDATE**: a link is never
-- re-parented or re-attributed in place (that is delete-and-add), and the 0086 trigger refuses
-- UPDATE for every credential besides. Reading is the database-wide SELECT above. The removal
-- destroys no history the audit trail does not keep: the detach is audited.
GRANT INSERT, DELETE         ON `tmanage`.`work_item_files`        TO 'tmanage_app'@'%';
-- x231 (0103) work item time logs. An effort entry is added (INSERT), read (the database-wide
-- SELECT) and deleted by its own author (DELETE) — this slice ships log/list/delete-own — so
-- INSERT and DELETE and **no UPDATE**: there is no edit endpoint, least privilege, and the 0103
-- trigger pins organization_id and work_item_id immutable for every credential besides. Edit
-- arrives with the code that writes it, per this file's rule that a grant names a statement that
-- exists.
GRANT INSERT, DELETE         ON `tmanage`.`work_item_time_logs`    TO 'tmanage_app'@'%';
-- x258 (0128) work item estimates. A single planned effort per work item, set or revised in place
-- through `INSERT ... ON DUPLICATE KEY UPDATE` on the org+item unique key — so INSERT and UPDATE and
-- **no DELETE**: there is no remove endpoint (an estimate is edited, never dropped by a runtime
-- credential), least privilege, and the 0128 trigger pins organization_id and work_item_id immutable
-- for every credential besides so UPDATE can move `estimate_minutes` and nothing that says which item
-- or tenant the estimate is. Reading is the database-wide SELECT above.
GRANT INSERT, UPDATE         ON `tmanage`.`work_item_estimates`    TO 'tmanage_app'@'%';
-- x232 work item watchers. **INSERT and DELETE** — a member subscribes (INSERT, idempotent on the
-- unique `(organization_id, work_item_id, member_id)` key) and unsubscribes their own row (DELETE).
-- No UPDATE: a watch has nothing mutable — it exists or it does not. Reading is the database-wide
-- SELECT above. There is no immutable trigger, unlike the append-only comments above, because a
-- watch is meant to be removed.
GRANT INSERT, DELETE         ON `tmanage`.`work_item_watchers`     TO 'tmanage_app'@'%';
-- x256 (0126) work item reminders. **INSERT, UPDATE and DELETE** — a member sets a personal
-- reminder (INSERT ... ON DUPLICATE KEY UPDATE against the unique `(organization_id, work_item_id,
-- membership_id)` key, so the upsert's replace path needs UPDATE), clears it (DELETE), and reads
-- their due list (the database-wide SELECT above). Unlike the immutable joins above, `remind_at` is
-- meant to be moved in place, so this row is genuinely mutable and UPDATE is granted. No dispatch
-- happens here — email/notification is a separate, out-of-scope path.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`work_item_reminders`    TO 'tmanage_app'@'%';
-- x233 work item labels. INSERT (define a label; assign a label to an item) and DELETE (untag an
-- item). No UPDATE: a label is defined once and a tag is added or removed, never amended in place;
-- the 0105 trigger pins organization_id immutable, and reading is the database-wide SELECT above.
GRANT INSERT, DELETE         ON `tmanage`.`work_item_labels`      TO 'tmanage_app'@'%';
-- x306 (0174) work item custom fields. INSERT (define a field; set a value the first time), UPDATE
-- (a value is set or revised in place through `INSERT ... ON DUPLICATE KEY UPDATE` on the value's
-- unique key, so the upsert's replace path needs UPDATE) and DELETE (remove a field definition). No
-- edit exists for a definition — it is defined once and removed, never amended — but a value is
-- genuinely mutable, so UPDATE is granted. Reading is the database-wide SELECT above; the 0174
-- trigger pins organization_id immutable.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`work_item_custom_fields` TO 'tmanage_app'@'%';
-- x316 request tags. INSERT (tag a client request with a free-text label) and DELETE (untag). No
-- UPDATE: a tag is added or removed, never amended in place; the 0184 trigger pins organization_id
-- immutable, and reading is the database-wide SELECT above.
GRANT INSERT, DELETE         ON `tmanage`.`request_tags`          TO 'tmanage_app'@'%';
-- x257 work item recurrence. INSERT and UPDATE (a PUT upserts the single rule per item — inserts it
-- the first time, rewrites freq/interval/until in place after) and DELETE (clear the rule). Reading
-- is the database-wide SELECT above; the 0127 trigger pins organization_id immutable.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`work_item_recurrence`  TO 'tmanage_app'@'%';
-- x262 people teams. INSERT (define a team; assign a member to a team) and DELETE (unassign a
-- member). No UPDATE: a team is defined once and a member is assigned or unassigned, never amended
-- in place; the 0132 trigger pins organization_id immutable, and reading is the database-wide SELECT
-- above.
GRANT INSERT, DELETE         ON `tmanage`.`member_teams`          TO 'tmanage_app'@'%';
-- x267 project tags. INSERT (define a tag; assign a tag to a project) and DELETE (untag a project).
-- No UPDATE: a tag is defined once and an assignment is added or removed, never amended in place;
-- the 0137 trigger pins organization_id immutable, and reading is the database-wide SELECT above.
GRANT INSERT, DELETE         ON `tmanage`.`project_tags`          TO 'tmanage_app'@'%';
-- x270 file tags. INSERT (define a tag; assign a tag to a file) and DELETE (untag a file). No
-- UPDATE: a tag is defined once and an assignment is added or removed, never amended in place; the
-- 0140 trigger pins organization_id immutable, and reading is the database-wide SELECT above.
GRANT INSERT, DELETE         ON `tmanage`.`file_tags`             TO 'tmanage_app'@'%';
-- x292 (0159) work checklist templates. A template is defined (INSERT), read (the database-wide
-- SELECT) and removed (DELETE) — this slice ships define/list/delete/apply — so INSERT and DELETE
-- and **no UPDATE**: a template is defined once and removed to change it, never amended in place;
-- the 0159 trigger pins `organization_id` immutable for every credential besides. Applying a
-- template inserts into `work_item_checklist_items`, which carries its own INSERT grant above.
GRANT INSERT, DELETE         ON `tmanage`.`work_checklist_templates` TO 'tmanage_app'@'%';
-- x308 (0176) work board columns. An org-level board layout: a column is defined (INSERT), edited
-- in place (UPDATE — a PUT rewrites label/state_key/position) and removed (DELETE). Reading is the
-- database-wide SELECT above. No dispatch and no work item is written — a column is a display
-- grouping over existing states. The 0176 trigger pins organization_id immutable, so UPDATE can
-- move label/state_key/position and nothing that says which tenant the column is.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`work_board_columns`     TO 'tmanage_app'@'%';
-- x332 file folders. INSERT (create a folder; file a file into a folder), UPDATE (re-file a file:
-- move its membership row's folder_id in place — idempotent) and DELETE (delete an empty folder;
-- file a file back to root by removing its membership row). The 0198 trigger pins organization_id
-- immutable, and reading is the database-wide SELECT above.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`file_folders`          TO 'tmanage_app'@'%';
-- x333 file comments. INSERT (comment on a file) and DELETE (delete own comment). No UPDATE: a
-- comment is written once and removed, never amended in place; the 0199 trigger pins
-- organization_id immutable, and reading is the database-wide SELECT above.
GRANT INSERT, DELETE         ON `tmanage`.`file_comments`         TO 'tmanage_app'@'%';
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
-- Audit gap 8 (COL-06/09): the meeting page edits title/start/end/agenda in place, so UPDATE lands
-- with the PATCH that writes it; still no DELETE. The 0029 trigger keeps identity immutable.
GRANT INSERT, UPDATE         ON `tmanage`.`meetings`         TO 'tmanage_app'@'%';
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
-- Audit gap 8 (COL-06/09): an organiser removes an attendee (DELETE …/attendees/:attendeeId), so
-- DELETE lands with the code that writes it. No table references meeting_attendees.
GRANT INSERT, UPDATE, DELETE  ON `tmanage`.`meeting_attendees` TO 'tmanage_app'@'%';
-- BK5 (0217): client people invited to a meeting. Invited (INSERT), their own RSVP from the portal
-- (UPDATE; 0217's trigger pins the identity columns), and removed by the organiser (DELETE).
GRANT INSERT, UPDATE, DELETE  ON `tmanage`.`meeting_client_attendees` TO 'tmanage_app'@'%';
-- CAL meeting RSVP (x240). A member records their own response (INSERT) and re-answers in place
-- (UPDATE) — this slice ships an idempotent upsert PUT and a read (the database-wide SELECT) — so
-- INSERT and UPDATE and **no DELETE**: there is no un-answer endpoint, least privilege, and 0112's
-- trigger pins organization_id/meeting_id/member_id immutable (only `response`/`updated_at` may
-- change) for every credential besides. DELETE is added with the code that writes it, per this
-- file's rule that a grant names a statement that exists (the same treatment `meeting_attendees`
-- has above).
GRANT INSERT, UPDATE          ON `tmanage`.`meeting_rsvps`     TO 'tmanage_app'@'%';
-- CAL / MTG-03 meeting action items (x266). An action item is captured (INSERT), edited and toggled
-- open/done in place (UPDATE), and removed (DELETE) — this slice ships create/list/edit/delete — so
-- INSERT, UPDATE and DELETE. 0136's trigger pins organization_id/meeting_id immutable (title, owner,
-- due date and status may change) for every credential besides.
GRANT INSERT, UPDATE, DELETE  ON `tmanage`.`meeting_action_items` TO 'tmanage_app'@'%';
-- CAL meeting time-option poll (x298). An organiser proposes candidate slots (INSERT) and everyone
-- reads the tally (the database-wide SELECT); this slice has no edit-an-option or remove-an-option
-- endpoint, so INSERT and **no UPDATE and no DELETE** — least privilege, and there is no immutability
-- trigger because the withheld privilege is the control (the same treatment `meeting_series` has).
-- When an edit surface lands, the write grant is added with the code that writes it, per this file's
-- rule that a grant names a statement that exists.
GRANT INSERT                 ON `tmanage`.`meeting_time_polls` TO 'tmanage_app'@'%';
-- CAL meeting time-option poll vote (x298). An invitee records their own vote (INSERT) and re-votes
-- in place (UPDATE) — this slice ships an idempotent upsert PUT and a read (the database-wide
-- SELECT) — so INSERT and UPDATE and **no DELETE**: there is no un-vote endpoint, least privilege,
-- and 0166's trigger pins organization_id/option_id/membership_id immutable (only `choice`/
-- `updated_at` may change) for every credential besides. DELETE is added with the code that writes
-- it, per this file's rule that a grant names a statement that exists (the same treatment
-- `meeting_rsvps` has above).
GRANT INSERT, UPDATE          ON `tmanage`.`meeting_time_poll_votes` TO 'tmanage_app'@'%';
-- CAL recurrence (x129) meeting series. A series is created (INSERT) and read (the database-wide
-- SELECT); this slice has no edit or delete endpoint, so **no UPDATE and no DELETE** — least
-- privilege, and there is no immutability trigger because the withheld privilege is the control
-- (the same treatment `saved_context` has). When an edit/override surface lands (NS-13), the write
-- grant is added with the code that writes it, per this file's rule that a grant names a statement
-- that exists.
GRANT INSERT                 ON `tmanage`.`meeting_series`   TO 'tmanage_app'@'%';
-- CAL per-occurrence override (x213). An override is created and upserted in place (INSERT and
-- UPDATE — `POST` replaces the override for a date), removed (DELETE — `DELETE` restores the base
-- rule for that date) and read (the database-wide SELECT). So INSERT, UPDATE and DELETE: unlike its
-- immutable parent series this row is edited and deleted by the endpoints this slice ships, and each
-- grant names a statement that exists (this file's rule). The worker gets nothing here.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`meeting_occurrence_overrides` TO 'tmanage_app'@'%';
-- CAL agenda templates (x314). A template is created (INSERT), read (the database-wide SELECT),
-- edited in place (UPDATE — the idempotent PUT) and removed (DELETE — 204). So INSERT, UPDATE and
-- DELETE, and the 0182 trigger pins organization_id/created_by/created_at immutable for every
-- credential besides. Applying a template writes only `meeting_notes` (already granted above), never
-- this table. The worker gets nothing here. Each grant names a statement that exists (this file's rule).
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`meeting_agenda_templates` TO 'tmanage_app'@'%';
-- WK-08 (x107). A saved view is created (INSERT), read (the database-wide SELECT) and edited in
-- place (UPDATE) — this slice ships create/list/update — so INSERT and UPDATE and **no DELETE**:
-- there is no delete endpoint, least privilege, and the 0034 trigger pins organization_id and
-- owner_user_id immutable for every credential besides. DELETE is added with the code that writes
-- it, per this file's rule that a grant names a statement that exists.
GRANT INSERT, UPDATE          ON `tmanage`.`saved_views`      TO 'tmanage_app'@'%';
-- SRCH saved/recent searches (0092, x214). A saved search is created (INSERT) and deleted (DELETE),
-- and a recent is inserted and pruned (INSERT + DELETE), so INSERT and DELETE and **no UPDATE**:
-- there is no rename/edit endpoint this slice, so the missing privilege is the control that keeps a
-- row's identity and body fixed (the `saved_context`/`home_pinned_items` posture, no immutability
-- trigger and none needed). Reading is the database-wide SELECT above. The worker gets nothing here.
GRANT INSERT, DELETE         ON `tmanage`.`saved_searches`   TO 'tmanage_app'@'%';
-- SRCH saved-search sharing (0142, x272). A share is created (INSERT, idempotent on the
-- (organization_id, saved_search_id) unique key) and removed (DELETE), and never edited, so INSERT
-- and DELETE and **no UPDATE**: the missing privilege is the control that keeps a share a plain
-- present/absent toggle (the `saved_searches`/`saved_context` posture, no immutability trigger and
-- none needed). Reading is the database-wide SELECT above. The worker gets nothing here.
GRANT INSERT, DELETE         ON `tmanage`.`saved_search_shares` TO 'tmanage_app'@'%';
-- search_history (x288): INSERT + the dedupe `created_at` refresh (UPDATE) record a query; DELETE
-- clears the list and prunes to the retention cap. Identity is held immutable by the 0157 trigger.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`search_history`   TO 'tmanage_app'@'%';
-- SRCH quick-access pins (0158, x290). A pin is created (INSERT), the same-target pin refreshes its
-- label via the write's ON DUPLICATE KEY (the INSERT privilege covers it), and it is removed
-- (DELETE), so INSERT and DELETE and **no UPDATE**: there is no standalone edit endpoint, so the
-- missing privilege is the control that keeps a pin's identity fixed (the `saved_searches`/
-- `saved_context` posture, no immutability trigger and none needed). Reading is the database-wide
-- SELECT above. The worker gets nothing here — this table is the API's alone.
GRANT INSERT, DELETE         ON `tmanage`.`search_pins`      TO 'tmanage_app'@'%';
-- SRCH saved scopes (0200, x334) member-scoped named search filter scopes. A scope is created
-- (INSERT), replaced in place (UPDATE — the idempotent PUT edits name/filters) and removed (DELETE),
-- so INSERT, UPDATE and DELETE. Reading is the database-wide SELECT above. The 0200 trigger pins
-- organization_id and member_user_id immutable, so the granted UPDATE can change only the name/filters
-- and never move a scope between studios or owners. The worker gets nothing here — this table is the
-- API's alone.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`search_scopes`      TO 'tmanage_app'@'%';
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
-- CH-07 saved messages (0120, x248) membership-scoped message bookmarks. INSERT to save and DELETE
-- to unsave, and **no UPDATE**: a saved message is created and removed, never edited, so the missing
-- privilege is the control (no immutability trigger, none needed). Reading is the database-wide
-- SELECT above. The worker gets nothing here — this table is the API's alone, the `home_pinned_items`
-- posture above.
GRANT INSERT, DELETE         ON `tmanage`.`message_bookmarks` TO 'tmanage_app'@'%';
-- INBOX snooze (0129, x259) membership-scoped inbox-bundle snoozes. INSERT and UPDATE (the upsert
-- moves the snooze time in place) and DELETE (the un-snooze). Reading is the database-wide SELECT
-- above. The worker gets nothing here — this table is the API's alone, the `saved_context` posture.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`inbox_snoozes` TO 'tmanage_app'@'%';
-- CH-06 composer attachments (0144, x275) message-to-file links. INSERT to attach and DELETE to
-- detach, and **no UPDATE**: an attachment is created and removed, never edited, so the missing
-- privilege is the control (no immutability trigger, none needed). Reading is the database-wide
-- SELECT above. The worker gets nothing here — this table is the API's alone, the `home_pinned_items`
-- posture above.
GRANT INSERT, DELETE         ON `tmanage`.`message_attachments` TO 'tmanage_app'@'%';
-- INBOX source mutes (0186, x318) a member's own muted inbox sources. INSERT (mute) and DELETE
-- (un-mute) only — a mute is created and removed, never edited, so no UPDATE (the `home_pinned_items`
-- posture) and re-muting is an idempotent no-op the service resolves. Reading is the database-wide
-- SELECT above. The worker gets nothing here — this table is the API's alone.
GRANT INSERT, DELETE         ON `tmanage`.`inbox_source_mutes` TO 'tmanage_app'@'%';
-- HOME recents (0192, x324) membership-scoped recently-viewed references. INSERT and UPDATE (the
-- upsert refreshes viewed_at in place) and DELETE (a member may clear a recent). Reading is the
-- database-wide SELECT above. The worker gets nothing here — this table is the API's alone, the
-- `inbox_snoozes` upsert posture above.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`home_recent_items` TO 'tmanage_app'@'%';
-- DOC-02/DOC-03 (x112) document versions. **INSERT only** — a version is an immutable snapshot of
-- the body at a save: DOC-03's restore is a new row (forward-append), never an edit, and the 0036
-- trigger refuses UPDATE for every credential. No DELETE: a document's history is the record of how
-- it changed, so a runtime credential must not be able to erase it (the `deliverable_versions`
-- posture above).
GRANT INSERT                 ON `tmanage`.`document_versions` TO 'tmanage_app'@'%';
-- DOC revision history (0113, x241) doc revisions. **INSERT only** — a revision is an immutable
-- snapshot of the body at a capture: a restore is a new row (forward-append), never an edit, and the
-- 0113 trigger refuses UPDATE for every credential. No DELETE: a document's history is the record of
-- how it changed, so a runtime credential must not be able to erase it.
GRANT INSERT                 ON `tmanage`.`doc_revisions` TO 'tmanage_app'@'%';
-- DOC bookmarks / favorites (0114, x242) per-membership document favorites. INSERT to bookmark and
-- DELETE to unbookmark, and **no UPDATE**: a bookmark is created and removed, never edited, so the
-- missing privilege is the control (no immutability trigger, none needed). Reading is the
-- database-wide SELECT above. The worker gets nothing here — this table is the API's alone, the
-- `home_pinned_items` posture above.
GRANT INSERT, DELETE         ON `tmanage`.`doc_bookmarks`     TO 'tmanage_app'@'%';
-- DOC subscriptions (0180, x312) a member's explicit follow list over documents. INSERT to subscribe
-- and DELETE to unsubscribe, and **no UPDATE**: a subscription is created and removed, never edited, so
-- the missing privilege is the control (no immutability trigger, none needed). Reading is the
-- database-wide SELECT above. The worker gets nothing here — this table is the API's alone, the
-- `doc_bookmarks` posture above.
GRANT INSERT, DELETE         ON `tmanage`.`doc_subscriptions` TO 'tmanage_app'@'%';
-- Calendar focus blocks (0125, x255) a member's own protected time. INSERT to create a block and
-- DELETE to remove one, and **no UPDATE**: a focus block is created and removed, never edited, so the
-- missing privilege is the control (no immutability trigger, none needed). Reading is the
-- database-wide SELECT above. The worker gets nothing here — this table is the API's alone, the
-- `doc_bookmarks` posture above.
GRANT INSERT, DELETE         ON `tmanage`.`focus_blocks`      TO 'tmanage_app'@'%';
-- INBOX saved filters (0131, x261) per-membership named inbox filter sets. INSERT to save and DELETE
-- to remove, and **no UPDATE**: a saved filter is created and removed, never edited, so the missing
-- privilege is the control (no immutability trigger, none needed). Reading is the database-wide
-- SELECT above. The worker gets nothing here — this table is the API's alone, the `doc_bookmarks`
-- posture above.
GRANT INSERT, DELETE         ON `tmanage`.`inbox_saved_filters` TO 'tmanage_app'@'%';
-- Org glossary of terms (0133, x263). A term is added (INSERT), its definition edited (UPDATE), and
-- the term removed (DELETE); reading is the database-wide SELECT above. The BEFORE UPDATE trigger
-- pins the tenant, so the granted UPDATE can change only the term/definition, never move a row
-- between studios. The worker gets nothing here — this table is the API's alone.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`glossary_terms`    TO 'tmanage_app'@'%';
-- DOC collections (0134, x264) named document collections and their membership, one table. INSERT to
-- create a collection and to add a document, DELETE to remove a document, and **no UPDATE**: a
-- collection and a membership are created and removed, never edited, so the missing privilege is the
-- control (no immutability trigger, none needed — the doc_bookmarks posture above). Reading is the
-- database-wide SELECT above. The worker gets nothing here — this table is the API's alone.
GRANT INSERT, DELETE         ON `tmanage`.`doc_collections`   TO 'tmanage_app'@'%';
-- PROJ project favorites (0138, x268) per-membership project favorites for the switcher. INSERT to
-- star and DELETE to unstar, and **no UPDATE**: a favorite is created and removed, never edited, so
-- the missing privilege is the control (no immutability trigger, none needed). Reading is the
-- database-wide SELECT above. The worker gets nothing here — this table is the API's alone, the
-- `doc_bookmarks` posture above.
GRANT INSERT, DELETE         ON `tmanage`.`project_favorites` TO 'tmanage_app'@'%';
-- Document tags / labels (0139, x269) one table for tag definitions and their document assignments.
-- INSERT to define a tag and to assign one, DELETE to unassign, and **no UPDATE**: a definition's
-- name and a tag's tenant are immutable (the 0139 trigger refuses a tenant move), and there is no
-- rename path in this slice — the missing privilege is the control. Reading is the database-wide
-- SELECT above.
GRANT INSERT, DELETE         ON `tmanage`.`doc_tags`          TO 'tmanage_app'@'%';
-- Org-wide admin announcement banners (0145, x276). INSERT to post an announcement and DELETE to
-- retract one, and **no UPDATE**: an announcement is posted and removed, never edited, so the missing
-- privilege is the control (no immutability trigger, none needed) — the doc_bookmarks posture above. A
-- correction is a delete and a re-post. Reading is the database-wide SELECT above.
GRANT INSERT, DELETE         ON `tmanage`.`org_announcements` TO 'tmanage_app'@'%';
-- DOC links + backlinks (0163, x296). INSERT to link, DELETE to unlink, and **no UPDATE**: a link is
-- created and removed, never edited, so the missing privilege is the control (the 0163 BEFORE UPDATE
-- trigger refuses UPDATE besides). Reading (both the outgoing and backlinks lists) is the
-- database-wide SELECT above. The worker gets nothing here — this table is the API's alone, the
-- `doc_bookmarks` posture above.
GRANT INSERT, DELETE         ON `tmanage`.`doc_links`         TO 'tmanage_app'@'%';
-- DOC read state (0164, x297) per-membership document read cursors. INSERT to first mark a document
-- read, UPDATE to refresh `last_read_at` on a repeated mark-read (the upsert path against
-- `uq_doc_read_state_pin`), and DELETE to mark it unread — but **no other privilege**. Reading is the
-- database-wide SELECT above. The worker gets nothing here — this table is the API's alone.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`doc_read_state`   TO 'tmanage_app'@'%';
-- INS metric favorites (0171, x303) per-membership starred insight metrics. INSERT to star and
-- DELETE to unstar, and **no UPDATE**: a favorite is created and removed, never edited, so the
-- missing privilege is the control (no immutability trigger, none needed). Reading is the
-- database-wide SELECT above. The worker gets nothing here — this table is the API's alone, the
-- `doc_bookmarks` posture.
GRANT INSERT, DELETE         ON `tmanage`.`insight_metric_favorites` TO 'tmanage_app'@'%';
-- Docs "collaboration later" (0045, x132) document comments. **INSERT only** — a comment is captured
-- (INSERT) and read (the database-wide SELECT). This slice ships no edit/delete path, and the 0045
-- trigger refuses UPDATE for every credential besides; edit/delete is a later slice (NEXT-SCOPES-13)
-- that adds the privilege with the code that writes it. No DELETE.
GRANT INSERT                 ON `tmanage`.`document_comments` TO 'tmanage_app'@'%';
-- Docs review workflow (0181, x313) document reviews. **INSERT and UPDATE** — a review is requested
-- (INSERT), read (the database-wide SELECT), and decided exactly once (UPDATE state/note/decided_at).
-- The single decision is enforced in the application (409 on re-decide); there is no delete path, so
-- no DELETE. The worker gets nothing here — this table is the API's alone.
GRANT INSERT, UPDATE         ON `tmanage`.`doc_reviews`        TO 'tmanage_app'@'%';
-- DOC-04/ADM-06 (x119) document templates. **INSERT only** — a template is created (INSERT) and
-- read (the database-wide SELECT). This slice ships no editor and no removal path, and the 0039
-- trigger pins organization_id/created_by_user_id immutable for every credential; an editor is a
-- later slice that adds UPDATE with the code that writes it. No DELETE.
GRANT INSERT                 ON `tmanage`.`document_templates` TO 'tmanage_app'@'%';
-- Automations scheduled triggers (0067, x167). **INSERT only** — a schedule is created (INSERT) and
-- read (the database-wide SELECT above). This slice ships no editor and no per-schedule enable-toggle
-- endpoint, and the 0067 trigger pins organization_id/template_id immutable for every credential
-- besides; an editor / toggle is a later slice that adds UPDATE with the code that writes it. No
-- DELETE (a schedule's history is not erased by a runtime credential — the document_templates
-- posture). The worker gets nothing here: the dispatcher that will read next_run_at is Needs-Peter
-- infrastructure and gets its grant with the code that runs it.
-- 2026-10-31 live-test fix: UPDATE (turn a schedule on/off, PATCH schedules/:id; the 0067 trigger still
-- pins organization_id/template_id) and DELETE (remove a schedule; its runs stay in workflow_runs).
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`automation_schedules` TO 'tmanage_app'@'%';
-- Billing usage alerts (0083, x200). **INSERT and UPDATE** — a usage-alert rule is created (INSERT),
-- read (the database-wide SELECT above), and tuned (UPDATE of threshold_percent/active). This slice
-- ships no removal path, so **no DELETE**, and the 0083 trigger pins organization_id/created_by/metric
-- immutable for every credential besides, so UPDATE can only move the two editable columns. The worker
-- gets nothing here: threshold-alert *dispatch* (email/notification) is Needs-Peter infrastructure and
-- gets its grant with the code that runs it.
GRANT INSERT, UPDATE         ON `tmanage`.`billing_usage_alerts` TO 'tmanage_app'@'%';
-- Billing credits (0100, x226). **INSERT only** — a credit / adjustment is posted (INSERT) and read
-- (the database-wide SELECT above). The ledger is append-only: a posted credit is never edited or
-- removed, and a correction is a new offsetting entry, so **no UPDATE and no DELETE**. Immutability is
-- enforced by withholding those grants (the row carries no `updated_at` and there is no update path);
-- this is the `insight_snapshots` (0090) posture. No money moves here — the running balance is summed
-- in the application, never settled — so no worker grant either.
GRANT INSERT                 ON `tmanage`.`billing_credits`   TO 'tmanage_app'@'%';
-- Billing cost centers (0150, x281). **SELECT, INSERT and DELETE** — a cost-center definition and its
-- project assignments are created (INSERT), listed (SELECT), and removed / unassigned (DELETE). No row
-- is ever updated in place — the code changes a cost center by inserting and deleting rows, never by an
-- UPDATE — so **no UPDATE**, which is why the table needs no immutability trigger. SELECT is named
-- here explicitly (as well as via the database-wide read above) so the grant states the full set the
-- code uses. The worker gets nothing: allocation reporting is a later slice.
GRANT SELECT, INSERT, DELETE ON `tmanage`.`billing_cost_centers` TO 'tmanage_app'@'%';
-- x282 (0151) billing purchase orders. Module 19: the org's finance-issued PO references, recorded
-- (INSERT), read (the database-wide SELECT above), closed (UPDATE, open → closed) and removed
-- (DELETE) — this slice ships add/list/close/remove — so INSERT, UPDATE and DELETE. The 0151 trigger
-- pins organization_id/po_number immutable for every credential besides, so UPDATE can only move the
-- editable `status`. It is a record, never a payment: nothing here charges or stores an instrument.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`billing_purchase_orders` TO 'tmanage_app'@'%';
-- Billing plan-change requests (x284, 0153). A request is created (INSERT) and read (the database-wide
-- SELECT above); the cancel path moves `status` pending → cancelled (UPDATE). This slice ships no
-- removal path, so **no DELETE**, and the 0153 trigger pins organization_id/created_by/target_plan_code/
-- effective_on/note immutable (and forbids leaving cancelled) for every credential besides, so UPDATE
-- can only move `status`. No provider call or charge happens here — that is Needs-Peter infrastructure.
GRANT INSERT, UPDATE         ON `tmanage`.`billing_plan_change_requests` TO 'tmanage_app'@'%';
-- BILLING (x330, 0197). An org discount / adjustment record is created (INSERT), read (the database-
-- wide SELECT above) and removed (DELETE). It is never edited — a change is a delete-and-recreate —
-- so **no UPDATE**: the row carries no `updated_at` and there is no update path, and withholding the
-- grant pins immutability for every credential. No money moves here (applying a discount to a real
-- charge is Needs-Peter / Stripe), so no worker grant either.
GRANT INSERT, DELETE         ON `tmanage`.`billing_discounts` TO 'tmanage_app'@'%';
-- CLIENT-003 (x125, 0041). A project update is posted (INSERT) and read (the database-wide
-- SELECT above); `published` is set at INSERT time, and this slice ships no edit/unpublish
-- endpoint, so **no UPDATE and no DELETE** — least privilege, and the 0041 trigger pins
-- organization_id/project_id/created_by_user_id immutable for every credential besides. When the
-- publish/unpublish lifecycle lands (NEXT-SCOPES-12), UPDATE is added with the code that writes
-- it, per this file's rule that a grant names a statement that exists (the same treatment
-- `meetings` and `documents` have above).
GRANT INSERT                 ON `tmanage`.`project_updates`  TO 'tmanage_app'@'%';
-- A10 (x201 edit/unpublish, 0223 milestone link). The lifecycle above landed: `PATCH …/updates/:id`
-- rewrites title/body/milestone_id and `POST …/unpublish` flips `published`, both UPDATE
-- statements, so UPDATE is granted with them. Still no DELETE.
GRANT UPDATE                 ON `tmanage`.`project_updates`  TO 'tmanage_app'@'%';
-- SEC / Portal update comments (x203, 0084). A comment is posted (INSERT) and read (the
-- database-wide SELECT above); every row is internal-authored and there is no edit/unpublish or
-- client-reply endpoint this slice, so **no UPDATE and no DELETE** — least privilege, and the 0084
-- trigger makes the row append-only for every credential besides. When an edit/delete or the
-- client-reply lifecycle lands (Needs-Peter, a client-write cap), the privilege is added with the
-- code that writes it, per this file's rule that a grant names a statement that exists (the same
-- treatment `project_updates`, `work_item_comments` and `meetings` have above).
GRANT INSERT                 ON `tmanage`.`project_update_comments` TO 'tmanage_app'@'%';
-- POR client portal (x304, 0172) portal announcement banners. **INSERT and DELETE** — a banner is
-- posted (INSERT) and retracted (DELETE), read (the database-wide SELECT above), and **never edited**:
-- this slice ships no editor, so no UPDATE, and the missing privilege is the control (the
-- `doc_bookmarks`/`home_pinned_items` posture, no immutability trigger). The worker gets nothing here
-- — this table is the API's alone.
GRANT INSERT, DELETE         ON `tmanage`.`portal_announcements` TO 'tmanage_app'@'%';
-- SEC / Client portal messages (x322, 0190). A message is posted (INSERT) by a client contact and
-- read (the database-wide SELECT above) — the client's own thread and the studio's inbound list;
-- every row is written once and there is no edit/delete endpoint this slice, so **no UPDATE and no
-- DELETE** — least privilege, and the 0190 trigger makes the row append-only for every credential
-- besides. When an edit/delete lifecycle lands, the privilege is added with the code that writes it,
-- per this file's rule that a grant names a statement that exists (the same treatment
-- `project_update_comments`, `project_updates` and `meetings` have above).
GRANT INSERT                 ON `tmanage`.`portal_client_messages` TO 'tmanage_app'@'%';
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
-- A9 (0222). The milestone lifecycle edits a milestone (x202 PATCH: title, due date, status; A9 adds
-- description, owner and the client-visibility flag) and deletes one (A9 `DELETE …/milestones/:id`,
-- refused while anything links to it), so the statements those routes run are granted here.
GRANT UPDATE, DELETE         ON `tmanage`.`project_milestones` TO 'tmanage_app'@'%';
-- Portal risks (x140, 0049). A risk is recorded (INSERT) and read (the database-wide SELECT above);
-- `severity`, `status`, `internal_note`, `client_summary` and `published` are set at INSERT time, and
-- this slice ships no edit/unpublish endpoint, so **no UPDATE and no DELETE** — least privilege, and
-- the 0049 trigger pins organization_id/project_id/created_by_user_id immutable for every credential
-- besides. When the edit/unpublish lifecycle lands (NEXT-SCOPES-13), UPDATE is added with the code
-- that writes it, per this file's rule that a grant names a statement that exists (the same treatment
-- `project_updates`, `project_milestones`, `meetings` and `documents` have above).
GRANT INSERT                 ON `tmanage`.`project_risks`     TO 'tmanage_app'@'%';
-- Client portal access log (x237, 0109). **INSERT only** — an access event is recorded (INSERT) by
-- the internal `record()` helper and read (the database-wide SELECT above); it is append-only, so
-- there is no UPDATE and no DELETE, and the `0109` triggers refuse both at the engine for every
-- credential. Internal-only: never projected to a client. When an edit or purge lifecycle lands, the
-- statement is added with the code that writes it, per this file's rule that a grant names a
-- statement that exists (the same treatment `project_risks` and `project_milestones` have above).
GRANT INSERT                 ON `tmanage`.`portal_access_log` TO 'tmanage_app'@'%';
-- WORK intake forms (x146). **INSERT only** — a work form is created (INSERT) and read (the
-- database-wide SELECT). This slice ships no editor and no removal path; the 0052 trigger pins
-- organization_id/created_by immutable for every credential, and an editor is a later slice that
-- adds UPDATE with the code that writes it. No DELETE. Submitting a form writes no work_forms row —
-- it creates a `work_items` row through the existing work path, which is granted above.
GRANT INSERT                 ON `tmanage`.`work_forms`        TO 'tmanage_app'@'%';
-- ---- 52-20 · public intake forms ----
-- 0258: publish/unpublish moves `public_slug`, `public_enabled`, `published_at`, `updated_at`
-- (UPDATE; the 0052 trigger still pins organization_id/created_by). Still no DELETE.
GRANT UPDATE                 ON `tmanage`.`work_forms`        TO 'tmanage_app'@'%';
-- 0258 `form_submissions` (tenant): the public door appends (INSERT), triage moves `state`
-- (spam, converting, converted — UPDATE); DELETE only for the company erasure and the later
-- retention purge. SELECT rides the database-wide read.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`form_submissions`  TO 'tmanage_app'@'%';
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
-- Organization access policies (0072, x174). **INSERT and UPDATE** — the policy document is created
-- (INSERT) and edited in place (UPDATE), the two halves of the upsert (`INSERT ... ON DUPLICATE KEY
-- UPDATE`), and read (the database-wide SELECT above). **No DELETE** — a policy document is created and
-- edited, never removed by a runtime credential. The 0072 trigger pins organization_id/id immutable for
-- every credential besides, so UPDATE can move only the JSON document (and who set it, and when).
GRANT INSERT, UPDATE         ON `tmanage`.`org_policies`      TO 'tmanage_app'@'%';
-- Organization security settings (0073, x176). **INSERT and UPDATE** — the posture is set (INSERT) and
-- changed in place (UPDATE), the two halves of the upsert (`INSERT ... ON DUPLICATE KEY UPDATE`), and
-- read (the database-wide SELECT above). **No DELETE** — a posture is set and changed, never removed by
-- a runtime credential. The 0073 trigger pins organization_id immutable for every credential besides,
-- so UPDATE can move only enforce_2fa/ip_allowlist_json (and who set it, and when).
GRANT INSERT, UPDATE         ON `tmanage`.`security_settings` TO 'tmanage_app'@'%';
-- Organization IP allowlist entries (x277, 0146). **INSERT and DELETE** — an advisory allowed range is
-- added (INSERT) and removed (DELETE) and read (the database-wide SELECT). **No UPDATE** — an entry is
-- added and removed, never edited in place, and the 0146 trigger pins organization_id immutable for
-- every credential besides.
GRANT INSERT, DELETE         ON `tmanage`.`org_ip_allowlist` TO 'tmanage_app'@'%';
-- Admin security-event alert configuration (0196, x329) per-(organization, event-type) in-app alert
-- toggles. INSERT and UPDATE (the PUT upserts `enabled` in place) and DELETE (removing a key's
-- config). Reading is the database-wide SELECT above. The worker gets nothing here — this table is
-- the API's alone, the `security_settings` posture above.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`admin_security_alerts` TO 'tmanage_app'@'%';
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
-- Automation workflow templates (x162, 0063; edit x189). **INSERT + UPDATE** — a template is created
-- (INSERT), read (the database-wide SELECT) and now edited in place (UPDATE): x189 adds the editor
-- the x162 grant anticipated ("an editor is a later slice that adds UPDATE with the code that writes
-- it"). The 0063 trigger still pins organization_id/created_by immutable for every credential, so
-- UPDATE can only touch name/trigger_kind/action_kind/config_json/enabled — never identity. No
-- DELETE (there is no delete path; archive needs a column and is deferred to a migration slice).
-- Nothing executes a template here (runs are x163).
GRANT INSERT, UPDATE         ON `tmanage`.`workflow_templates` TO 'tmanage_app'@'%';
-- Automation workflow runs (x163, 0064). **INSERT only** — a run is created (INSERT) and read (the
-- database-wide SELECT). A run is append-only history: this slice ships no editor and no removal path,
-- the 0064 trigger pins organization_id/template_id immutable for every credential, and nothing
-- updates a run at all. No UPDATE, no DELETE. In-app actions in this slice have no external egress and
-- write no other tenant table, so the app needs no further privilege here.
GRANT INSERT                 ON `tmanage`.`workflow_runs`      TO 'tmanage_app'@'%';
-- Automations app/integration connections (x165). **INSERT only** — a connection is created (INSERT)
-- and read (the database-wide SELECT above). This slice ships no editor and no removal path; the 0065
-- trigger pins organization_id/app_id/created_by immutable for every credential, and an editor is a
-- later slice that adds UPDATE with the code that writes it. No DELETE. No credentials are stored in
-- the row — the application rejects secret-shaped config keys before the INSERT.
GRANT INSERT                 ON `tmanage`.`integration_connections` TO 'tmanage_app'@'%';
-- Automations webhook endpoints (x166). **INSERT and UPDATE** — an endpoint is registered (INSERT),
-- read (the database-wide SELECT), and toggled enabled/disabled (UPDATE). UPDATE writes exactly
-- `enabled`; the 0066 column-pinning trigger (`trg_webhook_endpoints_pin_columns`) refuses every
-- other column at the engine, so an endpoint's URL, event kind, secret hash and authorship are
-- immutable for the runtime credential specifically. **No DELETE**: a delete surface is a later
-- slice that adds the privilege with the code that writes it, per this file's rule that a grant names
-- a statement that exists.
GRANT INSERT, UPDATE         ON `tmanage`.`webhook_endpoints` TO 'tmanage_app'@'%';
-- Automations webhook delivery attempts (x221). **INSERT only** — a delivery attempt is recorded
-- (INSERT) by the in-app dispatch path and read back (the database-wide SELECT); it is append-only,
-- exactly like `audit_events`. Withholding UPDATE and DELETE makes each recorded attempt immutable
-- for the runtime credential, so no column-pinning trigger is needed. **No UPDATE, no DELETE.**
GRANT INSERT                 ON `tmanage`.`webhook_deliveries` TO 'tmanage_app'@'%';
-- A11Y-183 preferences (x183, module 20). **INSERT, UPDATE** — a member's accessibility settings
-- are created and then replaced in place by an `INSERT ... ON DUPLICATE KEY UPDATE` upsert against
-- `uq_a11y_preferences_org_membership`. No DELETE: a member clears settings by saving the defaults,
-- not by removing the row. SELECT is the database-wide grant.
GRANT INSERT, UPDATE         ON `tmanage`.`a11y_preferences`  TO 'tmanage_app'@'%';
-- PREF-DISPLAY display preferences (x285, module 20, migration 0154). **INSERT, UPDATE** — a
-- member's display settings (theme/density/locale/timezone/date format) are created and then
-- replaced in place by an `INSERT ... ON DUPLICATE KEY UPDATE` upsert against
-- `uq_user_display_preferences_org_membership`. No DELETE: a member clears settings by saving the
-- defaults, not by removing the row. SELECT is the database-wide grant.
GRANT INSERT, UPDATE         ON `tmanage`.`user_display_preferences` TO 'tmanage_app'@'%';
-- Automation workflow conditions (x190, 0081). **INSERT and DELETE** — a condition is created (INSERT),
-- read (the database-wide SELECT) and, since C1, removed; the 0081 trigger pins
-- organization_id/template_id/created_by immutable for every credential, and an editor is a later
-- slice that adds UPDATE with the code that writes it. A condition gates a template the run evaluator
-- reads; it writes no other tenant table, so the app needs no further privilege here.
-- C1: DELETE added — "remove a condition" (DELETE .../conditions/:conditionId), audited in the
-- same transaction. Still no UPDATE: a condition is never edited, only added or removed.
GRANT INSERT, DELETE         ON `tmanage`.`workflow_conditions` TO 'tmanage_app'@'%';
-- Automation variables (x305, 0173). **INSERT, UPDATE and DELETE** — the PUT is an upsert against the
-- `(organization_id, var_key)` natural key (a first set INSERTs, a later value UPDATEs in place), and
-- the DELETE removes one variable idempotently. SELECT is the database-wide grant above. The 0173
-- trigger pins organization_id/var_key immutable for every credential, so the upsert can only move the
-- value; the app writes no other tenant table here.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`automation_variables` TO 'tmanage_app'@'%';
-- Automation template tags (x335, 0201). **INSERT + DELETE** — a tag is created (INSERT), read (the
-- database-wide SELECT), and removed (DELETE); a re-label is a delete and a re-add, the person_skills
-- posture, so there is no UPDATE. The 0201 immutability trigger pins
-- organization_id/workflow_template_id/label/created_by for every credential, so no privilege can
-- mutate a tag in place. The app writes no other tenant table here.
GRANT INSERT, DELETE         ON `tmanage`.`automation_template_tags` TO 'tmanage_app'@'%';
-- PEOPLE allocations (x171). **INSERT only** — an allocation is created (INSERT) and read (the
-- database-wide SELECT). This slice ships no edit and no removal path; there is no allocation-column
-- lifecycle yet, so no UPDATE, and no DELETE. Reassignment or an end-date edit is a later slice that
-- adds the statement with the code that writes it, per this file's rule that a grant names a statement
-- that exists (the same treatment `work_forms` and `project_risks` have above).
GRANT INSERT                 ON `tmanage`.`person_allocations` TO 'tmanage_app'@'%';
-- Per-member weekly capacity (x170, 0068). **INSERT and UPDATE** — the PUT is an upsert against the
-- `(organization_id, membership_id)` natural key: a first set INSERTs, a later revision UPDATEs in
-- place. No DELETE — a capacity figure is set and revised, never removed by a runtime credential; the
-- 0068 trigger pins organization_id/membership_id immutable for every credential besides. Reads use
-- the database-wide SELECT above.
GRANT INSERT, UPDATE         ON `tmanage`.`person_capacity`   TO 'tmanage_app'@'%';
-- Member reporting lines (x217, migration 0095). **INSERT, UPDATE, DELETE** — the PUT is an upsert
-- against the `(organization_id, member_id)` natural key (a first set INSERTs, a revision UPDATEs the
-- manager in place), and clearing a member's manager DELETEs the row. The 0095 trigger pins
-- organization_id/member_id immutable for every credential besides; reads use the database-wide SELECT.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`member_reporting_lines` TO 'tmanage_app'@'%';
-- Member availability / out-of-office windows (x218, 0096). **INSERT, DELETE** — a window is added
-- (INSERT) and removed (DELETE), and read through the database-wide SELECT above. No UPDATE: a member
-- edits a window by delete-and-add, and the 0096 trigger refuses any amendment for every credential
-- besides, so a re-date slice adds UPDATE with the code that writes it. A removed window leaves no
-- history to protect, so DELETE is the right grant here (the person_skills posture).
GRANT INSERT, DELETE         ON `tmanage`.`member_availability` TO 'tmanage_app'@'%';
-- Person time-off (x325, migration 0193). **INSERT, DELETE** — a manager files a dated absence
-- (INSERT) and removes it (DELETE), and reads a person's entries through the database-wide SELECT
-- above. No UPDATE: an entry is created and removed, never edited, so the withheld privilege is the
-- control (no immutability trigger, none needed — the focus_blocks posture). A removed entry leaves
-- no history to protect, so DELETE is the right grant here.
GRANT INSERT, DELETE         ON `tmanage`.`person_time_off` TO 'tmanage_app'@'%';
-- People member skills (x172, migration 0070). **INSERT, DELETE** — a skill is added (INSERT) and
-- removed (DELETE), and read through the database-wide SELECT. No UPDATE: a re-label is a delete and
-- re-add, and the 0070 trigger pins organization_id/membership_id/label immutable for every
-- credential, so a level-edit slice adds UPDATE with the code that writes it. A removed skill leaves
-- no history to protect (unlike a message or a notification), so DELETE is the right grant here.
GRANT INSERT, DELETE         ON `tmanage`.`person_certifications` TO 'tmanage_app'@'%';
-- Person certifications (x326, migration 0194). **INSERT, DELETE** — a dated credential is recorded
-- (INSERT) and removed (DELETE), and read through the database-wide SELECT above. No UPDATE: a
-- certification is never amended, a correction is a delete and re-add, so the withheld UPDATE is the
-- immutability control (there is no editable column). A removed credential leaves no history to
-- protect, so DELETE is the right grant here (the person_skills posture).
GRANT INSERT, DELETE         ON `tmanage`.`person_skills`     TO 'tmanage_app'@'%';
-- Custom roles (x173, 0071; edit + clone x195). **INSERT, UPDATE** — a custom role is defined and
-- cloned (INSERT), edited in place (UPDATE, added by x195 for the name/capabilities edit path), and read
-- (the database-wide SELECT). No DELETE: removing a role is a later slice that adds that privilege with
-- the code that writes it, so the withheld DELETE stays the immutability control against deletion (no
-- trigger needed). The worker gets nothing here — this table is the API's alone.
GRANT INSERT, UPDATE         ON `tmanage`.`custom_roles`       TO 'tmanage_app'@'%';
-- ADM private member notes (0149, x280). INSERT to add a note and DELETE to remove one, and **no
-- UPDATE**: a note is append-only — its body and attribution are fixed once written, correcting one
-- is delete-and-re-add — so the missing UPDATE privilege is the control that keeps it so, backed by
-- the 0149 `BEFORE UPDATE` immutability trigger. Reading is the database-wide SELECT above. The
-- worker gets nothing here — this table is the API's alone.
GRANT INSERT, DELETE         ON `tmanage`.`member_admin_notes` TO 'tmanage_app'@'%';

-- Billing subscription (x177, migration 0074). One row per organization, upserted: INSERT to create
-- the first subscription and UPDATE to change the plan (the change is recorded as `pending_change`;
-- no charge is executed here — real payment is a later slice with an external provider). No DELETE:
-- a subscription is created and changed, never removed by the runtime credential; the 0074 trigger
-- pins organization_id immutable for every credential.
GRANT INSERT, UPDATE         ON `tmanage`.`subscriptions`     TO 'tmanage_app'@'%';
-- INS saved views (x210, module 15, 0089). **INSERT, DELETE** — a saved insights view is created
-- once and removed, never edited in place this slice, so no UPDATE. Reading is the database-wide
-- SELECT above; least privilege withholds UPDATE until an edit endpoint (and the code that writes it)
-- lands, per this file's rule that a grant names a statement that exists.
GRANT INSERT, DELETE         ON `tmanage`.`insight_saved_views` TO 'tmanage_app'@'%';
-- Insight report schedules (x228, module 15, 0101). **INSERT, DELETE** — a member's recurring
-- insights-report definition is created once and removed, never edited in place this slice, so no
-- UPDATE. `next_run_at` is computed by the application from a bound `now` and written on INSERT; there
-- is no dispatcher and no egress in this slice. Reading is the database-wide SELECT above.
GRANT INSERT, DELETE         ON `tmanage`.`insight_report_schedules` TO 'tmanage_app'@'%';
-- PREF-QUIET quiet hours (x215, module 20). **INSERT, UPDATE** — a member's notification quiet-hours
-- window is created and then replaced in place by an `INSERT ... ON DUPLICATE KEY UPDATE` upsert
-- against `uq_pref_quiet_hours_org_membership`. No DELETE: a member clears the window by saving
-- disabled, not by removing the row. SELECT is the database-wide grant.
GRANT INSERT, UPDATE         ON `tmanage`.`pref_quiet_hours` TO 'tmanage_app'@'%';
-- Billing seats (x178, migration 0075). INSERT (assign a seat) and UPDATE (release a seat by
-- setting released_at, a soft close). **No DELETE** — a seat's history is the point of the table,
-- so the withheld privilege is the control, and the 0075 trigger pins organization_id/membership_id/
-- assigned_at immutable so an UPDATE can move only released_at. Reading is the database-wide SELECT.
GRANT INSERT, UPDATE         ON `tmanage`.`billing_seats`     TO 'tmanage_app'@'%';
-- x179 (0076) invoices. **NO write grant at all**, and the absence is the mechanism. Invoice
-- history is read-only for the runtime this slice: the list and the detail read are the only
-- endpoints, and reading is the database-wide SELECT above. The rows are produced by the
-- subscription lifecycle or the seed, not by a request under this credential, so INSERT/UPDATE/
-- DELETE are withheld — there is no invoice mutation route to grant a statement for, per this
-- file's rule that a grant names a statement that exists. A provider-driven billing run that writes
-- invoices (Needs-Peter) adds the grant it needs with the code that writes it.
-- Home widget preferences (x243, module 4 Home / My Day). **INSERT, UPDATE** — a member's Home
-- widget layout is created and then replaced in place by an `INSERT ... ON DUPLICATE KEY UPDATE`
-- upsert against `uq_home_widget_prefs_org_membership`. No DELETE: a member clears their layout by
-- saving the default, not by removing the row. SELECT is the database-wide grant.
GRANT INSERT, UPDATE         ON `tmanage`.`home_widget_prefs` TO 'tmanage_app'@'%';
-- Member profiles (x216, 0094). **INSERT, UPDATE** — the profile is an upsert (`INSERT ... ON
-- DUPLICATE KEY UPDATE` on `uq_member_profiles_org_user`): the first save inserts, later saves
-- update in place. No DELETE — a profile is cleared by writing empty fields, never removed; the
-- withheld privilege is the control. The route only ever touches this table, never the GLOBAL
-- `users.display_name`.
GRANT INSERT, UPDATE         ON `tmanage`.`member_profiles`   TO 'tmanage_app'@'%';
-- x225 (0099) invoice_line_items. Same rule as its parent `invoices`: **NO write grant at all**, and
-- the absence is the mechanism. The per-invoice line read is the only endpoint; reading is the
-- database-wide SELECT above. Rows are produced by the subscription lifecycle or the seed, not by a
-- request under this credential, so INSERT/UPDATE/DELETE are withheld — the provider-driven billing
-- run that writes lines (Needs-Peter) adds the grant with the code that writes it.
-- Insight metric targets (x230, module 15, 0102). **INSERT, UPDATE** — an org-wide target per metric
-- is created and then replaced in place by an `INSERT ... ON DUPLICATE KEY UPDATE` upsert against
-- `uq_insight_targets_org_metric`. No DELETE: a target is set and re-set this slice, not removed.
-- SELECT is the database-wide grant.
GRANT INSERT, UPDATE         ON `tmanage`.`insight_targets` TO 'tmanage_app'@'%';
-- Insight metric alerts (x319, module 15, 0187). **INSERT, UPDATE, DELETE** — a member's own threshold
-- alert per metric is created and replaced in place by an `INSERT ... ON DUPLICATE KEY UPDATE` upsert
-- against `uq_insight_metric_alerts_org_member_metric` (the idempotent PUT), and DELETE lets a member
-- remove their own alert (204). SELECT is the database-wide grant.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`insight_metric_alerts` TO 'tmanage_app'@'%';
-- Insight custom reports (x320, module 15, 0188). **INSERT, UPDATE, DELETE** — a member's own custom
-- insight report is created (POST), replaced in place by an idempotent PUT (UPDATE), and removed
-- (DELETE). The 0188 BEFORE UPDATE trigger pins organization_id/owner_user_id immutable at the engine,
-- so an UPDATE can never move a row across a tenant or owner. SELECT is the database-wide grant.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`insight_custom_reports` TO 'tmanage_app'@'%';
-- PREF-DIGEST notification digest cadence (x245, module 20, 0117). **INSERT, UPDATE** — a member's
-- digest cadence is created and then replaced in place by an `INSERT ... ON DUPLICATE KEY UPDATE`
-- upsert against `uq_pref_digest_org_membership`. No DELETE: a member changes cadence by saving a new
-- value, not by removing the row. SELECT is the database-wide grant.
GRANT INSERT, UPDATE         ON `tmanage`.`pref_digest` TO 'tmanage_app'@'%';
-- Inbox flags (x260, module 4 Inbox / INBOX-001 IN-01 "Important inbox"). **INSERT, DELETE** — a
-- member's "important" star on an inbox bundle is created (flag) and removed (unflag), never edited:
-- there is no UPDATE path in the repository, so the withheld privilege is the control and no
-- immutability trigger is needed (the doc_bookmarks / home_pinned_items posture). SELECT is the
-- database-wide grant.
GRANT INSERT, DELETE         ON `tmanage`.`inbox_flags`      TO 'tmanage_app'@'%';
-- Request triage metadata (x265, module 11 Requests). **INSERT, UPDATE** — a request's category and
-- internal assignee are created and then replaced in place by an `INSERT ... ON DUPLICATE KEY UPDATE`
-- upsert against `uq_request_triage_org_request`. No DELETE: re-triaging overwrites the row; there is
-- no "un-triage" that removes it. SELECT is the database-wide grant.
GRANT INSERT, UPDATE         ON `tmanage`.`request_triage`     TO 'tmanage_app'@'%';

-- Home quick links (x273, module 4 Home / My Day). **INSERT, UPDATE, DELETE** — a member adds a
-- quick link (INSERT), reorders their list in place (UPDATE of `position`) and removes one (DELETE).
-- SELECT is the database-wide grant.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`home_quick_links` TO 'tmanage_app'@'%';

-- Per-org optional-module feature flags (x278, module 18 Administration). **INSERT, UPDATE** — a
-- flag's state is created and then replaced in place by an `INSERT ... ON DUPLICATE KEY UPDATE`
-- upsert against `uq_org_feature_flags_org_key`. No DELETE: a flag is turned off by setting
-- `enabled = 0`, not by removing the row. SELECT is the database-wide grant.
GRANT INSERT, UPDATE         ON `tmanage`.`org_feature_flags` TO 'tmanage_app'@'%';
-- Audit-log retention policy (x279, Administration module 18). **INSERT, UPDATE** — one row per
-- organization holding the retention window in days, created and then replaced in place by an
-- `INSERT ... ON DUPLICATE KEY UPDATE` upsert against `uq_audit_retention_policy_org`. No DELETE: a
-- policy is overwritten, never removed, and its history is the org's own. SELECT is the database-wide
-- grant, which is what the purge-preview COUNT over `audit_events` reads with. This slice grants no
-- write on `audit_events` itself (that table keeps its INSERT-only grant above): a preview counts, and
-- the purge is a later, separately-credentialed procedure.
GRANT INSERT, UPDATE         ON `tmanage`.`audit_retention_policy` TO 'tmanage_app'@'%';
-- PRF keyboard shortcuts (x286, module 20). **INSERT, UPDATE, DELETE** — a member rebinds a
-- command-palette action's chord with an `INSERT ... ON DUPLICATE KEY UPDATE` upsert against
-- `uq_user_shortcut_prefs_org_membership_action` (INSERT + UPDATE), and resets an action to its
-- shipped default by removing their own row (DELETE, idempotent). SELECT is the database-wide grant.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`user_shortcut_prefs` TO 'tmanage_app'@'%';
-- PREF-STARTUP default startup landing view (x287, module 20). **INSERT, UPDATE** — a member's
-- chosen landing screen is created and then replaced in place by an `INSERT ... ON DUPLICATE KEY
-- UPDATE` upsert against `uq_user_startup_prefs_org_membership`. No DELETE: a member reverts by
-- saving the default, not by removing the row. SELECT is the database-wide grant.
GRANT INSERT, UPDATE         ON `tmanage`.`user_startup_prefs` TO 'tmanage_app'@'%';
-- Inbox routing rules (x301, module Inbox). **INSERT, DELETE** — a member adds a routing rule and
-- removes their own; a rule is never edited in place (reorder is a delete-and-add in the UI), so no
-- UPDATE grant. No immutability trigger: identity is the row, and a rule carries nothing an update
-- would need to protect. SELECT is the database-wide grant.
GRANT INSERT, DELETE         ON `tmanage`.`inbox_rules`      TO 'tmanage_app'@'%';

-- Insight dashboard layouts (x302, module 16 Insights). **INSERT, UPDATE** — a member's insights-
-- dashboard tile layout is created and then replaced in place by an `INSERT ... ON DUPLICATE KEY
-- UPDATE` upsert against `uq_insight_dashboard_layouts_org_membership`. No DELETE: a member clears
-- their layout by saving the default, not by removing the row. SELECT is the database-wide grant.
GRANT INSERT, UPDATE         ON `tmanage`.`insight_dashboard_layouts` TO 'tmanage_app'@'%';

-- ID-002 credentials. `user_passwords` and `user_mfa_factors` need UPDATE — a password is
-- changed in place, and a factor records the counter of the last code it accepted on every
-- successful verification. `user_recovery_codes` needs UPDATE to spend a code and to revoke
-- a superseded batch, and DELETE is withheld: a spent code must stay spent and visible,
-- because "this code was used on the 3rd" is the sentence that distinguishes a legitimate
-- recovery from a stolen one.
GRANT INSERT, UPDATE ON `tmanage`.`user_passwords`      TO 'tmanage_app'@'%';
-- 0204 password reset links (ACC-02). INSERT (a link is requested), UPDATE (used once; older
-- links retired). No DELETE: a used or superseded link stays as evidence, like the other
-- credential tables. The worker holds nothing here.
GRANT INSERT, UPDATE ON `tmanage`.`password_reset_tokens` TO 'tmanage_app'@'%';
-- 0205 external sign-in identities ("Continue with Google"). INSERT (a Google account is linked),
-- UPDATE (`last_used_at` on each sign-in). No DELETE: unlinking is not built, and a person's
-- removal cascades from `users`. The worker holds nothing here.
GRANT INSERT, UPDATE ON `tmanage`.`user_identities`      TO 'tmanage_app'@'%';
-- 0206 platform admin (the TManage operator, /platform). Step-ups: INSERT only — a confirmation
-- expires, it is never amended. The platform audit log: INSERT only, append-only like
-- `audit_events`. Settings: INSERT and UPDATE (the one switch is an upsert). No DELETE anywhere,
-- and the worker holds nothing here.
GRANT INSERT ON `tmanage`.`platform_admin_step_ups`     TO 'tmanage_app'@'%';
GRANT INSERT ON `tmanage`.`platform_admin_audit_events` TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE ON `tmanage`.`platform_settings`   TO 'tmanage_app'@'%';
-- 0208 OAuth authorization server (MCP connector S7). Clients, grants, codes, access tokens and
-- refresh tokens: INSERT (register/consent/mint), UPDATE (soft-revoke, record used_at/last_used_at,
-- rotate). SELECT is the database-wide read above. No DELETE anywhere: codes and tokens are
-- retired by `used_at`/`revoked_at` and kept as evidence, the same posture the credential tables
-- take. The worker holds nothing here.
GRANT INSERT, UPDATE ON `tmanage`.`oauth_clients`        TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE ON `tmanage`.`oauth_grants`         TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE ON `tmanage`.`oauth_codes`          TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE ON `tmanage`.`oauth_access_tokens`  TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE ON `tmanage`.`oauth_refresh_tokens` TO 'tmanage_app'@'%';
-- 0209 pending AI actions (MCP connector S10): INSERT when an AI asks for a confirm-class action,
-- UPDATE for the single guarded pending → approved/declined/expired transition and the result.
-- No DELETE: a decided request is kept as evidence.
GRANT INSERT, UPDATE ON `tmanage`.`pending_ai_actions`   TO 'tmanage_app'@'%';
-- 0210 Google Drive storage. Connection: INSERT (first connect), UPDATE (reconnect, settings,
-- disconnect wipes the token, error state). Folders: INSERT only (a folder id never changes).
-- Attachments: INSERT, UPDATE (soft detach via `removed_at`). No DELETE anywhere; the worker
-- holds nothing here.
GRANT INSERT, UPDATE ON `tmanage`.`storage_connections`      TO 'tmanage_app'@'%';
GRANT INSERT ON `tmanage`.`google_drive_folders`             TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE ON `tmanage`.`google_drive_attachments` TO 'tmanage_app'@'%';
-- 0236 OneDrive storage (the connection reuses `storage_connections` above). Folders: INSERT
-- only (a folder item id never changes). Attachments: INSERT, UPDATE (soft detach via
-- `removed_at`). No DELETE; the worker holds nothing here.
GRANT INSERT ON `tmanage`.`onedrive_folders`                 TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE ON `tmanage`.`onedrive_attachments`     TO 'tmanage_app'@'%';
-- 0237 meetings connected to a person's own calendar. Connections and provider-event links:
-- INSERT, UPDATE (status, cursor and token rotate in place; disconnect wipes the token, never a
-- DELETE). Guests: INSERT, UPDATE (their answer from Google/Outlook), DELETE (removed from the
-- meeting; nothing references a guest row). Attachments: INSERT, UPDATE (soft removal via
-- `removed_at`). The worker holds nothing here: the sync job runs in the API process.
GRANT INSERT, UPDATE ON `tmanage`.`calendar_connections`     TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE ON `tmanage`.`meeting_external_events`  TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`meeting_guests`   TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE ON `tmanage`.`meeting_attachments`      TO 'tmanage_app'@'%';
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
-- `maintenance_windows` (Platform states, x185, 0080) gets INSERT and nothing else. The admin write
-- schedules a window (one row) and the public read reads it through the database-wide SELECT (line
-- 60); a window is never amended in place in this slice, so UPDATE and DELETE are withheld the way
-- the append-only tables above are. GLOBAL / org-less, so it is in the tenant guard's
-- NON_TENANT_TABLES; the write is authorized by `org.manage` in the controller but persists on the
-- identity path.
GRANT INSERT ON `tmanage`.`maintenance_windows` TO 'tmanage_app'@'%';
-- Wave 9 S8 (audit F07): the platform operator's unpublish (`POST /v1/platform/maintenance/:id/
-- unpublish`, PlatformAdminGuard) sets `published = 0` on one window, with its platform audit row in
-- the same transaction. UPDATE only; a window is still never deleted by a runtime credential.
GRANT UPDATE ON `tmanage`.`maintenance_windows` TO 'tmanage_app'@'%';
-- `insight_snapshots` (Insights & reporting, x211, 0090) gets INSERT and nothing else. A snapshot is
-- captured (INSERT) and read (the database-wide SELECT, line 60); it is a historical fact, never
-- amended or removed by a runtime credential, so UPDATE and DELETE are withheld the way the
-- append-only tables above are (the 0090 trigger pins every column immutable besides). A
-- retention/purge surface is a later slice that adds the privilege with the code that writes it.
GRANT INSERT ON `tmanage`.`insight_snapshots` TO 'tmanage_app'@'%';
-- `admin_export_requests` (Administration & governance, x224, 0098) gets INSERT and nothing else. A
-- request is recorded (INSERT) and read (the database-wide SELECT, line 60); it is a historical fact,
-- never amended or removed by the runtime API credential, so UPDATE and DELETE are withheld the way
-- the append-only tables above are (the 0098 trigger pins identity + request facts immutable besides).
-- Moving a request through its status lifecycle is the later async export worker's job, which is
-- granted UPDATE alongside the code that writes it — the withheld UPDATE keeps the record honest here.
GRANT INSERT ON `tmanage`.`admin_export_requests` TO 'tmanage_app'@'%';
-- D5 (0231) `privacy_exports` and `privacy_deletion_requests` get INSERT and UPDATE. A request is
-- created (INSERT) and moved through its lifecycle by the API and its in-process privacy job (UPDATE:
-- preparing -> ready/failed, scheduled -> cancelled/executed). No DELETE: who asked for an export or a
-- deletion, and when, is the record the data-rights workflow keeps.
GRANT INSERT, UPDATE ON `tmanage`.`privacy_exports`           TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE ON `tmanage`.`privacy_deletion_requests` TO 'tmanage_app'@'%';
-- `insight_annotations` (Insights & reporting, x271, 0141) gets INSERT and DELETE. An annotation is
-- posted (INSERT), read (the database-wide SELECT, line 60), and removed by its author (DELETE) —
-- the `focus_blocks` posture where the author's own DELETE is a granted privilege. It is never
-- amended in place: UPDATE is withheld and the 0141 trigger pins every column immutable for every
-- other credential besides, so "a note's substance is immutable once posted" holds.
GRANT INSERT, DELETE ON `tmanage`.`insight_annotations` TO 'tmanage_app'@'%';
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
-- `decision_comments` (x317, 0185) gets INSERT and DELETE. A comment is authored (INSERT), read
-- (the database-wide SELECT, line 60), and removed by its author (DELETE) — this slice ships
-- add/list/delete-own — so INSERT and DELETE and **no UPDATE**: a comment is never edited in place,
-- the 0185 trigger refuses UPDATE for every credential besides, and the delete destroys no history
-- the audit trail does not keep.
GRANT INSERT, DELETE ON `tmanage`.`decision_comments` TO 'tmanage_app'@'%';
-- `project_objectives` (PROJ / module 8, x124) gets INSERT and UPDATE. An objective is created
-- (INSERT), read (the database-wide SELECT, line 60), and moved through its lifecycle (UPDATE):
-- `open → met` or `open → missed`. UPDATE writes exactly `status`; the 0040 column-pinning trigger
-- (`trg_project_objectives_pin_columns`) refuses every other column at the engine, so an objective's
-- name, description, target and authorship are immutable for the runtime credential specifically.
-- **No DELETE**: an objective is the durable record of what the project set out to do.
GRANT INSERT, UPDATE ON `tmanage`.`project_objectives` TO 'tmanage_app'@'%';
-- `project_internal_risks` (PROJ / module 8, x209) gets INSERT and UPDATE. A risk is logged (INSERT),
-- read (the database-wide SELECT, line 60), and worked through its lifecycle (UPDATE): its title,
-- likelihood, impact, mitigation and status are editable. UPDATE cannot touch the identity columns —
-- the 0088 trigger (`trg_project_internal_risks_pin_identity`) refuses `id`, `organization_id`,
-- `project_id`, `created_by` and `created_at` at the engine, so a risk cannot be re-pointed at another
-- project or tenant by the runtime credential. **No DELETE**: the register is the durable record.
GRANT INSERT, UPDATE ON `tmanage`.`project_internal_risks` TO 'tmanage_app'@'%';
-- `project_templates` (PROJ / module 8, x234) gets INSERT only. A template is authored (INSERT) and
-- read (the database-wide SELECT, line 60) to list it and to instantiate a project from it; there is
-- no edit route this slice, so the runtime credential cannot amend a template. **No UPDATE, no
-- DELETE**: a later edit slice adds UPDATE (with an identity-pinning trigger) alongside the code that
-- writes it, the same posture `incidents` / `changelog_entries` take.
GRANT INSERT ON `tmanage`.`project_templates` TO 'tmanage_app'@'%';
-- `project_status_updates` (PROJ / module 8, x235) gets INSERT and nothing else. A status update is
-- posted once (INSERT) and read (the database-wide SELECT, line 60); it is a durable, point-in-time
-- record with no edit or delete path this slice. The 0107 trigger
-- (`trg_project_status_updates_immutable`) refuses every UPDATE at the engine, so the log is
-- append-only for the runtime credential specifically. **No UPDATE and no DELETE**: an update is the
-- durable record of what was said and when. Internal-only, never projected to a client.
GRANT INSERT ON `tmanage`.`project_status_updates` TO 'tmanage_app'@'%';
-- `project_budgets` (PROJ / project detail, x293, 0160) gets INSERT and UPDATE — the upsert
-- (`INSERT ... ON DUPLICATE KEY UPDATE` on `uq_project_budgets_org_project`). A budget is set (INSERT
-- on first save), read (the database-wide SELECT, line 60) to sum it against tracked effort, and
-- edited in place (UPDATE) as the planned figures change. UPDATE cannot touch the identity columns —
-- the 0160 trigger (`trg_project_budgets_pin_identity`) refuses `id`, `organization_id`,
-- `project_id`, `created_by` and `created_at` at the engine, so a budget cannot be re-pointed at
-- another project or tenant by the runtime credential. **No DELETE**: a manager clears a budget by
-- saving new figures, not by deleting the row.
GRANT INSERT, UPDATE ON `tmanage`.`project_budgets` TO 'tmanage_app'@'%';
-- `project_phases` (PROJ / module 8, x294) gets INSERT, UPDATE and DELETE. A phase is defined
-- (INSERT), read (the database-wide SELECT, line 60), a milestone is assigned into a phase (INSERT,
-- or UPDATE of `phase_id` on re-assign — idempotent), and a phase (with its assignment rows) is
-- removed (DELETE). UPDATE cannot touch the identity columns — the 0161 trigger
-- (`trg_project_phases_pin_identity`) refuses `id`, `organization_id`, `project_id`, `milestone_id`
-- and `created_at` at the engine, so a row cannot be re-pointed at another project, tenant or
-- milestone by the runtime credential.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`project_phases` TO 'tmanage_app'@'%';
-- `project_baselines` (PROJ / module 8, x295, 0162) gets INSERT and DELETE. A baseline is frozen
-- (INSERT), read (the database-wide SELECT, line 60), and a superseded one may be discarded (DELETE);
-- variance is recomputed at read time from the live milestones against the frozen JSON, so the
-- snapshot itself is never mutated. **No UPDATE** — a baseline is an immutable point-in-time record
-- (there is no `updated_at` column and no update trigger); a re-baseline is a new INSERT, not an edit.
GRANT INSERT, DELETE ON `tmanage`.`project_baselines` TO 'tmanage_app'@'%';
-- `project_custom_fields` (PROJ / module 8, x310) gets INSERT, UPDATE and DELETE. It holds both the
-- org's field definitions and each project's values in one table (row_kind discriminator): a definition
-- is created (INSERT) and removed (DELETE); a value is set idempotently (INSERT ... ON DUPLICATE KEY
-- UPDATE, hence UPDATE) and cleared (DELETE). Read via the database-wide SELECT (line 60). The 0178
-- trigger (`trg_project_custom_fields_immutable`) pins organization_id, row_kind, project_id and
-- field_key at the engine, so only a value's value_text can change for the runtime credential.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`project_custom_fields` TO 'tmanage_app'@'%';
-- `project_retro_notes` (PROJ / module 8, x311) gets INSERT and DELETE. A retro note is captured
-- (INSERT), read grouped by category (the database-wide SELECT, line 183), and an individual note is
-- removed (DELETE). **No UPDATE**: a note is a point-in-time reflection; the slice ships create/list/
-- delete only, with no edit path. Same INSERT+DELETE posture as the typed work-item links (x204).
GRANT INSERT, DELETE ON `tmanage`.`project_retro_notes` TO 'tmanage_app'@'%';
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
-- `milestone_links` (PROJ / module 8, x236) gets INSERT and DELETE. A milestone-dependency edge is
-- created (link) and removed (unlink), never edited — there is no column to change on a link, so
-- **no UPDATE** — the posture `objective_work_links` carries. Reading is the database-wide SELECT
-- above.
GRANT INSERT, DELETE ON `tmanage`.`milestone_links` TO 'tmanage_app'@'%';
-- `project_dependencies` (PROJ, x309) gets INSERT and DELETE. A cross-project dependency edge is
-- created (link) and removed (unlink), never edited — there is no column to change on an edge, so
-- **no UPDATE** — the posture `milestone_links` carries. Reading is the database-wide SELECT above.
GRANT INSERT, DELETE ON `tmanage`.`project_dependencies` TO 'tmanage_app'@'%';
-- `objective_key_results` (PROJ / module 8, x207) gets INSERT and UPDATE. A key result is created
-- (INSERT) and its body — title/target/current/unit — is revised as work progresses (UPDATE); the
-- 0087 column-pinning trigger (`trg_objective_key_results_pin_columns`) refuses every identity column
-- at the engine, so an edit can only ever move the body, never re-parent or re-attribute the row.
-- There is no delete surface this slice, so **no DELETE**. Reading is the database-wide SELECT above.
GRANT INSERT, UPDATE ON `tmanage`.`objective_key_results` TO 'tmanage_app'@'%';
-- `portal_settings` (SEC / Client portal, module 13, x238) gets INSERT and UPDATE. A project's
-- client-portal settings are created and then replaced in place: the read/upsert repository writes
-- `INSERT ... ON DUPLICATE KEY UPDATE` against `(organization_id, project_id)`, so a save is one
-- statement needing both privileges. UPDATE moves the presentation columns and the `updated_by` stamp;
-- the 0110 trigger (`trg_portal_settings_pin_identity`) refuses `id`, `organization_id`, `project_id`
-- and `created_at` at the engine, so settings cannot be re-pointed at another project or tenant by the
-- runtime credential. **No DELETE**: settings default when absent, so there is nothing a delete buys —
-- a project's portal is reset by saving the defaults, not by removing the row. Reading is the
-- database-wide SELECT (line 60).
GRANT INSERT, UPDATE ON `tmanage`.`portal_settings` TO 'tmanage_app'@'%';
-- x321 (0189) portal deliverable feedback. A client contact leaves one rating+comment on a
-- published deliverable version and may revise it: the service writes `INSERT ... ON DUPLICATE
-- KEY UPDATE` against the `(organization_id, deliverable_version_id, client_contact_user_id)`
-- unique key, so a save is one statement needing INSERT and UPDATE. UPDATE moves only `rating`,
-- `comment` and `updated_at`; the 0189 trigger (`trg_portal_feedback_immutable`) refuses the
-- tenant, version and authoring contact at the engine, so feedback cannot be re-pointed by the
-- runtime credential. **No DELETE**: a client edits their feedback, never has it removed by the
-- runtime. Reading (the staff feedback list) is the database-wide SELECT (line 60).
GRANT INSERT, UPDATE ON `tmanage`.`portal_feedback` TO 'tmanage_app'@'%';

-- x300 (0168): approval delegations. A delegator records a delegation (INSERT) and revokes it
-- (DELETE); a delegation is never edited — there is no UPDATE path in the repository, so **no
-- UPDATE** here, and the withheld privilege is the immutability control (the doc_bookmarks posture).
-- Reading is the database-wide SELECT above.
GRANT INSERT, DELETE ON `tmanage`.`approval_delegations` TO 'tmanage_app'@'%';
-- `portal_branding` (SEC / Client portal, module 13, x323) gets INSERT and UPDATE. A client
-- organization's client-facing branding is created and then replaced in place: the read/upsert
-- repository writes `INSERT ... ON DUPLICATE KEY UPDATE` against `(organization_id, client_org_scope_id)`,
-- so a save is one statement needing both privileges. UPDATE moves the presentation columns
-- (accent_color, welcome_heading, welcome_text) and the `updated_by` stamp; the 0191 trigger
-- (`trg_portal_branding_pin_identity`) refuses `id`, `organization_id`, `client_org_scope_id` and
-- `created_at` at the engine, so branding cannot be re-pointed at another client or tenant by the
-- runtime credential. **No DELETE**: branding defaults when absent, so a client's portal is reset by
-- saving the defaults, not by removing the row. Reading is the database-wide SELECT (line 60).
GRANT INSERT, UPDATE ON `tmanage`.`portal_branding` TO 'tmanage_app'@'%';
-- `org_branding` (ADM / org identity, module 18, x327, migration 0195) gets INSERT and UPDATE. A
-- studio's org-wide internal-chrome branding is created and then replaced in place: the read/upsert
-- repository writes `INSERT ... ON DUPLICATE KEY UPDATE` against `(organization_id)`, so a save is one
-- statement needing both privileges. UPDATE moves the branding columns and the `updated_by` stamp; the
-- 0195 trigger (`trg_org_branding_pin_identity`) refuses `id`, `organization_id` and `created_at` at
-- the engine, so a branding row cannot be re-pointed at another tenant by the runtime credential.
-- **No DELETE**: branding defaults when absent, so a studio resets its chrome by saving the defaults,
-- not by removing the row. Reading is the database-wide SELECT (line 60), which every authenticated
-- member exercises via `work.read`.
GRANT INSERT, UPDATE ON `tmanage`.`org_branding` TO 'tmanage_app'@'%';
-- `organization_logos` (C6, migration 0229) gets INSERT, UPDATE and DELETE. Uploading a logo is one
-- `INSERT ... ON DUPLICATE KEY UPDATE` against `(organization_id)`; Remove deletes the row, since an
-- absent row is "no logo" and there is nothing to keep. The 0229 trigger pins `id`,
-- `organization_id` and `created_at`. Reading is the database-wide SELECT (line 60).
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`organization_logos` TO 'tmanage_app'@'%';

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
-- BK3-left: the direct-message pair row (participants, cursor) for the socket subscription check
-- and the recipient re-check (`direct-message-store.ts`). `direct_messages` is not read.
GRANT SELECT ON `tmanage`.`direct_conversations`     TO 'tmanage_worker'@'%';

-- CQ-12: the collaboration notices and the automation runner (`collaboration-store.ts`). The
-- recipient's mail toggle, quiet hours and per-kind opt-out (`notification_preferences`,
-- `notification_kind_prefs` — the quiet-hours read already needed the first); the title an
-- email names (`documents`, `meetings`); the enabled rules for a trigger (`workflow_templates`)
-- and the run history the runner appends to (`workflow_runs`, read where it writes). No message
-- or comment body is read: the notices name who and where, never what was said.
GRANT SELECT ON `tmanage`.`notification_preferences` TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`notification_kind_prefs`  TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`documents`                TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`meetings`                 TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`workflow_templates`       TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`workflow_runs`            TO 'tmanage_worker'@'%';
-- C1: a rule fires only when its saved conditions match (`automation-conditions-store.ts`), and
-- the due-soon sweep reads its own claims where it writes them (`due-soon-store.ts`).
GRANT SELECT ON `tmanage`.`workflow_conditions`      TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`workflow_due_soon_fires`  TO 'tmanage_worker'@'%';
-- H1: a custom-role member's capability set, joined tenant-scoped beside `memberships` wherever the
-- relay checks a role (`principal-role.ts`), so custom-role members are not skipped. Read only.
GRANT SELECT ON `tmanage`.`custom_roles`             TO 'tmanage_worker'@'%';

-- Read where it writes. MariaDB reads to write: an `UPDATE … WHERE` needs SELECT on the
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
-- CQ-12 (AUT-01): a rule that fires appends its run. INSERT only, the API's own posture: a run
-- is history and is never changed or removed.
GRANT INSERT         ON `tmanage`.`workflow_runs`       TO 'tmanage_worker'@'%';
-- C1: the due-soon sweep claims one (rule, item, day) before it runs the rule. INSERT only.
GRANT INSERT         ON `tmanage`.`workflow_due_soon_fires` TO 'tmanage_worker'@'%';

-- ─────────────────────────────────────────────────────────────────────────────
-- Migration user
-- ─────────────────────────────────────────────────────────────────────────────
-- Owns the schema. Used only by the migrator, never by a running application process.
-- `packages/config` refuses to boot when DATABASE_URL equals DATABASE_MIGRATION_URL, so
-- collapsing the two into one credential is a validation error rather than a code review
-- someone might skip.
--
-- Created here as well as by `compose.yaml`'s database-user variable, because this file
-- must also work against a server that was not provisioned by that compose file — a CI
-- service container, or a Hostinger database created through the panel. MariaDB refuses
-- `GRANT` to a user that does not exist (`NO_AUTO_CREATE_USER`, on by default: 1133), so
-- the create cannot be skipped.
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

-- ---- platform-admin v2 · PA-02 ----
-- 0239/0240 platform admin team, preset mapping, support sessions (global tables): INSERT and
-- UPDATE (add, change preset/permissions, disable; a support session ends by `ended_at`). No
-- DELETE: removing an admin disables the row, which stays as evidence. SELECT is the
-- database-wide read. 0241 `audit_event_changes`: INSERT only, append-only like `audit_events`.
-- `platform_admin_audit_events` keeps its INSERT-only grant above. The worker holds nothing here.
GRANT INSERT, UPDATE ON `tmanage`.`platform_admins`             TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE ON `tmanage`.`platform_permission_presets` TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE ON `tmanage`.`platform_support_sessions`   TO 'tmanage_app'@'%';
GRANT INSERT ON `tmanage`.`audit_event_changes`                 TO 'tmanage_app'@'%';

-- ---- platform-admin v2 · PA-01 ----
-- 0242 `membership_permission_overrides`: INSERT (add an override) and UPDATE (revoke it by
-- `revoked_at`). No DELETE: a removed override stays as the record of who gave what. SELECT is
-- the database-wide read. The worker holds nothing here.
GRANT INSERT, UPDATE ON `tmanage`.`membership_permission_overrides` TO 'tmanage_app'@'%';

-- ---- platform-admin v2 · PA-03 ----
-- 0245 content soft delete (SPEC P7). A delete from the product now sets `deleted_at`,
-- `deleted_by_user_id`, `deleted_reason` and `purge_after` instead of removing the row, so the
-- app needs UPDATE on the content tables that were INSERT(+DELETE)-only. The 0245 triggers admit
-- only those four columns on the append-only tables; what was said stays immutable.
GRANT UPDATE ON `tmanage`.`work_item_comments`      TO 'tmanage_app'@'%';
GRANT UPDATE ON `tmanage`.`work_item_files`         TO 'tmanage_app'@'%';
-- R5 slice 2 (0272): the same UPDATE resolves/reopens an anchored comment thread
-- (`resolved_at`, `resolved_by_user_id`); the 0245 trigger does not pin those columns.
GRANT UPDATE ON `tmanage`.`document_comments`       TO 'tmanage_app'@'%';
GRANT UPDATE ON `tmanage`.`decision_comments`       TO 'tmanage_app'@'%';
GRANT UPDATE ON `tmanage`.`request_comments`        TO 'tmanage_app'@'%';
GRANT UPDATE ON `tmanage`.`request_messages`        TO 'tmanage_app'@'%';
GRANT UPDATE ON `tmanage`.`direct_messages`         TO 'tmanage_app'@'%';
GRANT UPDATE ON `tmanage`.`message_attachments`     TO 'tmanage_app'@'%';
GRANT UPDATE ON `tmanage`.`file_comments`           TO 'tmanage_app'@'%';
GRANT UPDATE ON `tmanage`.`project_update_comments` TO 'tmanage_app'@'%';
-- The worker's `--sweep-purge` (apps/worker/src/jobs/purge-sweeper.ts) is the only hard delete of
-- content: SELECT to find rows past `purge_after`, DELETE to remove them. The bound is in the job —
-- every DELETE names the organization, the ids it selected and `purge_after <= now` again — since a
-- grant cannot be row-scoped. `file_assets` is not here: a stored file is erased by the existing
-- file purge path, which also removes the object.
GRANT SELECT, DELETE ON `tmanage`.`messages`                 TO 'tmanage_worker'@'%';
GRANT SELECT, DELETE ON `tmanage`.`work_items`               TO 'tmanage_worker'@'%';
GRANT SELECT, DELETE ON `tmanage`.`direct_conversations`     TO 'tmanage_worker'@'%';
GRANT SELECT, DELETE ON `tmanage`.`direct_messages`          TO 'tmanage_worker'@'%';
GRANT SELECT, DELETE ON `tmanage`.`message_attachments`      TO 'tmanage_worker'@'%';
GRANT SELECT, DELETE ON `tmanage`.`work_item_comments`       TO 'tmanage_worker'@'%';
GRANT SELECT, DELETE ON `tmanage`.`work_item_files`          TO 'tmanage_worker'@'%';
GRANT SELECT, DELETE ON `tmanage`.`documents`                TO 'tmanage_worker'@'%';
GRANT SELECT, DELETE ON `tmanage`.`document_comments`        TO 'tmanage_worker'@'%';
GRANT SELECT, DELETE ON `tmanage`.`decisions`                TO 'tmanage_worker'@'%';
GRANT SELECT, DELETE ON `tmanage`.`decision_comments`        TO 'tmanage_worker'@'%';
GRANT SELECT, DELETE ON `tmanage`.`meetings`                 TO 'tmanage_worker'@'%';
GRANT SELECT, DELETE ON `tmanage`.`meeting_attachments`      TO 'tmanage_worker'@'%';
GRANT SELECT, DELETE ON `tmanage`.`request_messages`         TO 'tmanage_worker'@'%';
GRANT SELECT, DELETE ON `tmanage`.`request_comments`         TO 'tmanage_worker'@'%';
GRANT SELECT, DELETE ON `tmanage`.`file_comments`            TO 'tmanage_worker'@'%';
GRANT SELECT, DELETE ON `tmanage`.`project_update_comments`  TO 'tmanage_worker'@'%';
GRANT SELECT, DELETE ON `tmanage`.`google_drive_attachments` TO 'tmanage_worker'@'%';
GRANT SELECT, DELETE ON `tmanage`.`onedrive_attachments`     TO 'tmanage_worker'@'%';
-- The restore window the sweep honours is read from `platform_settings` only by the API; the
-- worker compares `purge_after` (already computed at delete time) with the database clock.

-- ---- platform-admin v2 · PA-10 ----
-- 0244 platform feature flags, per-organization forced overrides and the platform banner (global
-- tables): INSERT and UPDATE. No DELETE: removing a forced override sets its `removed_at` (forcing
-- it again clears it); Delete on an announcement unpublishes it and sets `archived`. SELECT is the database-wide read.
-- `maintenance_windows` already holds INSERT and UPDATE (0080 + wave 9): PA-10's edit, publish and
-- "End now" (`ended_at`) are UPDATEs on that grant, so nothing is added for it. The worker holds
-- nothing here.
GRANT INSERT, UPDATE ON `tmanage`.`platform_feature_flags`      TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE ON `tmanage`.`platform_org_flag_overrides` TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE ON `tmanage`.`platform_announcements`      TO 'tmanage_app'@'%';

-- ---- platform-admin v2 · PA-07 ----
-- 0243 `organization_limits` (tenant table): INSERT and UPDATE — the operator sets or clears an
-- override; a cleared override is a row of NULLs, never a DELETE. SELECT is the database-wide read.
-- The new `organizations` columns ride the existing UPDATE grant.
GRANT INSERT, UPDATE ON `tmanage`.`organization_limits` TO 'tmanage_app'@'%';
-- The worker's organization purge (apps/worker/src/jobs/purge-organizations.ts, a PURGE_HOOKS
-- entry of `--sweep-purge`) hands an organization whose restore window has passed to the privacy
-- erasure path: it records an executed company deletion (INSERT on `privacy_deletion_requests`)
-- and closes the organization (UPDATE `archived_at`/`suspended_at` on `organizations`, which it
-- already reads). It never reads the requests table — the organization it closes leaves the due
-- set in the same transaction — and deletes nothing itself: the API's privacy job erases the rows.
GRANT UPDATE ON `tmanage`.`organizations`              TO 'tmanage_worker'@'%';
GRANT INSERT ON `tmanage`.`privacy_deletion_requests`  TO 'tmanage_worker'@'%';

-- ---- platform-admin v2 · PA-05 ----
-- The worker's Support-session sweeper (apps/worker/src/jobs/support-session-sweeper.ts, every
-- minute and `--sweep-support-sessions`) ends sessions past `expires_at`: it reads and stamps the
-- session row, offboards the hidden `platform_support` membership (or restores the admin's own
-- row), bumps `organizations.policy_version` and writes `support.session_ended` (audit_events,
-- INSERT already held) and `platform.support_session_ended`. No DELETE anywhere. The UPDATE on
-- `organizations` repeats PA-07's line on purpose: each job states what it needs.
GRANT SELECT, UPDATE ON `tmanage`.`platform_support_sessions`   TO 'tmanage_worker'@'%';
GRANT UPDATE ON `tmanage`.`memberships`                         TO 'tmanage_worker'@'%';
GRANT UPDATE ON `tmanage`.`organizations`                       TO 'tmanage_worker'@'%';
GRANT INSERT ON `tmanage`.`platform_admin_audit_events`         TO 'tmanage_worker'@'%';

-- ---- platform-admin v2 · PA-06 ----
-- 0247 adds `users.disabled_at`, `disabled_reason`, `two_step_required_at` and `sessions.ip_first`,
-- `ip_last`. Every People write (profile, disable/enable, reset or require two-step, end a session)
-- rides grants the API already holds: UPDATE on `users`, `sessions`, `user_mfa_factors` and
-- `user_recovery_codes`, INSERT on `credential_change_notices`, `authentication_events` and
-- `platform_admin_audit_events`. No new grant, no DELETE.

-- ---- platform-admin v2 · PA-09 ----
-- 0246 `platform_export_jobs` (global): the API inserts a queued export, lists them and marks one
-- `deleted` (UPDATE — never DELETE). SELECT rides the database-wide read.
GRANT INSERT, UPDATE ON `tmanage`.`platform_export_jobs`        TO 'tmanage_app'@'%';
-- The worker's export job (apps/worker/src/jobs/export-jobs.ts, `--run-exports` and its loop)
-- claims queued jobs and stamps them ready/failed/expired, and reads the rows each scope exports:
-- the org action log (metadata only — `metadata_json` and `audit_event_changes` are never read),
-- sessions (no token hash), the platform admin log, organizations and people. The
-- `organizations`, `users` and `memberships` reads are already held above. NOT
-- `authentication_events`: the relay never reads the security log (least-privilege.db.test.ts),
-- so the API writes a sign-ins export itself, at request time.
GRANT SELECT, UPDATE ON `tmanage`.`platform_export_jobs`        TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`audit_events`                        TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`sessions`                            TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`platform_admin_audit_events`         TO 'tmanage_worker'@'%';

-- ---- 56-02 FieldCipher ----
-- 0249 `key_rotations` (global). The API queues a rotation (POST /v1/platform/keys/rotate, later
-- slice) — INSERT; SELECT rides the database-wide read. The worker's rotation job
-- (apps/worker/src/jobs/field-cipher-rotation.ts) claims, resumes and finishes it, and its CLI can
-- queue one. It re-encrypts the connector refresh tokens in place: SELECT + UPDATE on the two
-- connection tables, compare-and-swap on `refresh_token_enc` only. No DELETE anywhere, and still
-- nothing on `user_mfa_factors` (MFA seeds rotate through the API's `mfa:encrypt-seeds`).
GRANT INSERT ON `tmanage`.`key_rotations`                       TO 'tmanage_app'@'%';
GRANT SELECT, INSERT, UPDATE ON `tmanage`.`key_rotations`       TO 'tmanage_worker'@'%';
GRANT SELECT, UPDATE ON `tmanage`.`storage_connections`         TO 'tmanage_worker'@'%';
GRANT SELECT, UPDATE ON `tmanage`.`calendar_connections`        TO 'tmanage_worker'@'%';

-- ---- 55-21 · usability measurement ----
-- 0251 `product_events` (tenant-owned): the API inserts a session's own metadata-only events
-- (`POST /v1/organizations/:orgSlug/events` and `.../portal/events`). SELECT rides the
-- database-wide read (the Platform admin scoreboard aggregates). No UPDATE, no DELETE: events are
-- append-only; the 13-month retention purge is a follow-up with its own worker grant.
GRANT INSERT ON `tmanage`.`product_events`                      TO 'tmanage_app'@'%';

-- ---- 56-05 ----
-- 0250 `rate_limit_buckets` (global): the API upserts a window (INSERT … ON DUPLICATE KEY UPDATE
-- needs INSERT and UPDATE) and sweeps rows untouched for 2 h (DELETE — this table only; the rows
-- are peppered hashes kept ≤ 48 h for minimisation). SELECT rides the database-wide read.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`rate_limit_buckets` TO 'tmanage_app'@'%';
-- 0250 `org_quota_counters` (tenant table): INSERT and UPDATE only — a day's counter is charged
-- by upsert and never deleted.
GRANT INSERT, UPDATE ON `tmanage`.`org_quota_counters`         TO 'tmanage_app'@'%';

-- ---- 51-11 · e-mail deliverability ----
-- 0252 `email_suppressions` (global): the API records a one-click unsubscribe by upsert
-- (INSERT … ON DUPLICATE KEY UPDATE needs INSERT and UPDATE). No DELETE — re-subscribing is a
-- later signed-in flow. SELECT rides the database-wide read. The worker reads it before each
-- notification send.
GRANT INSERT, UPDATE ON `tmanage`.`email_suppressions`         TO 'tmanage_app'@'%';
GRANT SELECT ON `tmanage`.`email_suppressions`                 TO 'tmanage_worker'@'%';

-- ---- 51-09 · backups ----
-- 0253 `platform_backup_runs` (global): written only by scripts/ops/backup.mjs and
-- restore-drill.mjs through the operator's migration credential; the API reads it for
-- /healthz/deep through the database-wide SELECT. No grant here on purpose (users-sql.test.ts).

-- ---- 56-32 · host capacity ----
-- 0254 `host_capacity_readings` (global): the API's capacity sampler appends a reading every
-- 5 minutes and a nightly one, and purges rows older than 90 days. No UPDATE: a reading is never
-- amended. SELECT rides the database-wide read.
GRANT INSERT, DELETE ON `tmanage`.`host_capacity_readings`     TO 'tmanage_app'@'%';

-- ---- 56-31 · mail lanes ----
-- 0256 `mail_queue` / `mail_hour_windows` (global). The API enqueues every message (INSERT only;
-- SELECT rides the database-wide read for GET /v1/platform/mail/health). The worker drainer
-- claims (UPDATE … claim_token, then SELECT by token), marks sent/deferred/failed (UPDATE),
-- purges rows 7 days after sent/failed (DELETE — the queue is transient delivery state, never
-- work a person made), and enqueues its own notification and alert mail (INSERT). It counts each
-- mailbox's hour with an upsert on `mail_hour_windows` (INSERT … ON DUPLICATE KEY UPDATE, read
-- where it writes), and reads the lane pauses and hour ceilings from `platform_settings`.
GRANT INSERT ON `tmanage`.`mail_queue`                         TO 'tmanage_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `tmanage`.`mail_queue` TO 'tmanage_worker'@'%';
GRANT SELECT, INSERT, UPDATE ON `tmanage`.`mail_hour_windows`  TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`platform_settings`                  TO 'tmanage_worker'@'%';

-- ---- 52-21 · public-endpoint abuse engine ----
-- 0255 `org_block_rules` (tenant): an organization's block list, added and removed behind
-- `org.security.manage`; UPDATE for a reason edit. SELECT rides the database-wide read.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`org_block_rules`    TO 'tmanage_app'@'%';
-- 0255 `public_abuse_events` (global): one row per assessed public action, appended and purged
-- after 30 days. No UPDATE: a decision is never amended.
GRANT INSERT, DELETE ON `tmanage`.`public_abuse_events`        TO 'tmanage_app'@'%';
-- 0255 `public_challenges` (global): issued, counted (attempts), solved and purged once expired.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`public_challenges`  TO 'tmanage_app'@'%';

-- ---- 56-07 · public link system ----
-- 0257 `public_links` (tenant): created, opened (uses, last_opened_at), decided and revoked
-- (UPDATE); DELETE only for the company erasure. SELECT rides the database-wide read.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`public_links`       TO 'tmanage_app'@'%';
-- 0257 `public_link_events` (tenant): append-only evidence. No UPDATE: an event is never amended;
-- DELETE only for the company erasure.
GRANT INSERT, DELETE ON `tmanage`.`public_link_events`         TO 'tmanage_app'@'%';
-- 0257 `public_link_codes` (tenant): issued (replaced on resend), counted and deleted on success.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`public_link_codes`  TO 'tmanage_app'@'%';

-- ---- 52-08 · quotes ----
-- 0259 `quotes` (tenant): created, edited while draft, sent and decided (UPDATE); DELETE only for
-- the company erasure. SELECT rides the database-wide read.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`quotes`             TO 'tmanage_app'@'%';
-- 0259 `quote_lines` (tenant): replaced as a set (DELETE + INSERT) while the quote is a draft.
-- No UPDATE: a line is never amended in place.
GRANT INSERT, DELETE ON `tmanage`.`quote_lines`                TO 'tmanage_app'@'%';

-- ---- 52-23 · money foundations ----
-- 0260 `org_finance_profiles` (tenant): first save INSERTs, later saves UPDATE; DELETE only for the
-- company erasure. SELECT rides the database-wide read.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`org_finance_profiles`   TO 'tmanage_app'@'%';
-- 0260 `org_tax_rates` (tenant): seeded with INSERT ... ON DUPLICATE KEY UPDATE (needs UPDATE),
-- edited and archived (UPDATE); DELETE only for the company erasure.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`org_tax_rates`          TO 'tmanage_app'@'%';
-- 0260 `org_document_sequences` (tenant): ensured with ON DUPLICATE KEY UPDATE, advanced under
-- FOR UPDATE (UPDATE); DELETE only for the company erasure.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`org_document_sequences` TO 'tmanage_app'@'%';
-- 0260 `org_exchange_rates` (tenant): append-only manual rates. No UPDATE: a rate is never amended.
GRANT INSERT, DELETE ON `tmanage`.`org_exchange_rates`             TO 'tmanage_app'@'%';

-- ---- 56-17 · vulnerability disclosure ----
-- 0262 `security_reports` (global): inserted by the anonymous report door, acknowledged_at and
-- the platform triage (status, credit) are UPDATEs. SELECT rides the database-wide read. The app
-- gets no DELETE: retention is the worker's (below).
GRANT INSERT, UPDATE ON `tmanage`.`security_reports`           TO 'tmanage_app'@'%';
-- 56-17 follow-up: the worker's 24-month purge (apps/worker/src/jobs/security-report-purge.ts)
-- reads and DELETEs rows past created_at + 24 months in 500-row batches, and the 56-02 key
-- rotation re-encrypts `reporter_email_enc` in place (compare-and-swap on that column only, the
-- same table-level UPDATE shape as the connection tables). Its count-only audit row uses the
-- existing INSERT on `platform_admin_audit_events`.
GRANT SELECT, UPDATE, DELETE ON `tmanage`.`security_reports`   TO 'tmanage_worker'@'%';

-- ---- 56-11 · audit hash chain ----
-- 0261 `audit_heads` (tenant): created on an organization's first chained write (INSERT … ON
-- DUPLICATE KEY UPDATE no-op, which needs UPDATE too) and advanced by every audit write. No DELETE.
GRANT INSERT, UPDATE ON `tmanage`.`audit_heads`                TO 'tmanage_app'@'%';
-- The worker's backfill inserts the chain-start head for organizations without one; never UPDATE
-- (the head belongs to the API writer). SELECT for the anchor job.
GRANT SELECT, INSERT ON `tmanage`.`audit_heads`                TO 'tmanage_worker'@'%';
-- 0261 `audit_anchors` (tenant) and `platform_audit_anchors` (global): written once per day by the
-- worker (INSERT IGNORE), never updated or deleted. The app only reads them (database-wide SELECT).
GRANT SELECT, INSERT ON `tmanage`.`audit_anchors`              TO 'tmanage_worker'@'%';
GRANT SELECT, INSERT ON `tmanage`.`platform_audit_anchors`     TO 'tmanage_worker'@'%';

-- ---- 56-23 · security signals ----
-- 0263 `security_signals` (tenant, nullable org): the worker detector upserts and marks them
-- notified; the app only reads (database-wide SELECT) and DELETEs them in the company erasure.
-- `platform_alert_rules` (global): the app updates on/off/threshold; the worker stamps
-- `last_fired_at`. Detector sources are SELECT only. NOT `authentication_events`: the relay never
-- reads the security log (least-privilege.db.test.ts) — `credential_stuffing` is skipped until
-- that is decided otherwise (see lane-56-23.md).
GRANT DELETE ON `tmanage`.`security_signals`                    TO 'tmanage_app'@'%';
GRANT UPDATE ON `tmanage`.`platform_alert_rules`                TO 'tmanage_app'@'%';
GRANT SELECT, INSERT, UPDATE ON `tmanage`.`security_signals`    TO 'tmanage_worker'@'%';
GRANT SELECT, UPDATE ON `tmanage`.`platform_alert_rules`        TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`public_link_events`                  TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`rate_limit_buckets`                  TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`webhook_deliveries`                  TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`platform_backup_runs`                TO 'tmanage_worker'@'%';

-- ---- 52-01 · timer (backend half) ----
-- 0265 `time_timers` (tenant): start INSERTs, the heartbeat UPDATEs `last_heartbeat_at`, stop / force
-- / company erasure DELETE. SELECT rides the database-wide read.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`time_timers`            TO 'tmanage_app'@'%';
-- `work_item_time_logs` stays INSERT, DELETE for the app: no edit statement exists yet (52-02/52-03
-- add it with its own grant); a timer stop is an INSERT.
-- Worker auto-stop (`jobs/timer-autostop.ts`): reads old timers with their org settings, deletes the
-- timer, files one entry (and may read the log it writes). SELECT on `work_items` and INSERT on
-- `audit_events` are already held.
GRANT SELECT, DELETE ON `tmanage`.`time_timers`                     TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`org_policies`                            TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`org_finance_profiles`                    TO 'tmanage_worker'@'%';
GRANT SELECT, INSERT ON `tmanage`.`work_item_time_logs`             TO 'tmanage_worker'@'%';

-- ---- R4 slice 2 · proofing viewer derivatives ----
-- 0267 `file_previews` (tenant): the preview job runs in the API process (in-process on Hostinger,
-- `FILE_PREVIEW_INPROCESS`), so the app credential inserts the pending rows, claims and records
-- them (UPDATE; the trigger pins identity and makes `object_key` write-once), and DELETEs them when
-- a version's derivatives are swept or the company is erased. SELECT rides the database-wide read.
-- Nothing on the worker credential: no worker code touches derivatives.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`file_previews`          TO 'tmanage_app'@'%';

-- ---- R4 slice 5 · proofing threads ----
-- 0268 `review_threads` / `review_comments` (tenant): the app writes threads and comments (INSERT),
-- resolves, moves, edits and soft-deletes them (UPDATE; the triggers pin identity and make a
-- thread's audience immutable). A delete from the product is a soft delete (PA-03); DELETE is held
-- for the company erasure only, as for `file_previews`. SELECT rides the database-wide read. The
-- worker's `--sweep-purge` hard-deletes rows past their restore window.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`review_threads`         TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`review_comments`        TO 'tmanage_app'@'%';
GRANT SELECT, DELETE ON `tmanage`.`review_comments`                TO 'tmanage_worker'@'%';
GRANT SELECT, DELETE ON `tmanage`.`review_threads`                 TO 'tmanage_worker'@'%';

-- ---- R4 slice 12 · review notices ----
-- The relay's review consumers name the file a comment or a decision is about ("Maya commented on
-- Homepage Concept") and tell the person who uploaded it: SELECT on `file_assets` (name, owner,
-- project). Read only — the worker never writes or removes a file row (see the purge note above).
GRANT SELECT ON `tmanage`.`file_assets`                            TO 'tmanage_worker'@'%';

-- ---- R4 slice 11 · decisions on plain files ----
-- 0269 `file_review_decisions` (tenant): the app records Approve / Request changes (INSERT). The
-- rows are append-only (a BEFORE UPDATE trigger refuses every change), so no UPDATE; DELETE is held
-- for the company erasure only. SELECT rides the database-wide read. Nothing on the worker.
GRANT INSERT, DELETE ON `tmanage`.`file_review_decisions`         TO 'tmanage_app'@'%';

-- ---- R4 slice 13 · Figma links ----
-- 0270 `figma_connections` / `figma_links` / `figma_frames` (tenant): the app stores a member's
-- encrypted Figma token (INSERT, UPDATE on reconnect, DELETE on disconnect), attaches links
-- (INSERT, UPDATE for the soft delete) and records frame snapshots (INSERT, UPDATE); the snapshot
-- job runs in the API process. DELETE on links and frames is held for the company erasure. SELECT
-- rides the database-wide read. Nothing on the worker.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`figma_connections`      TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`figma_links`            TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`figma_frames`           TO 'tmanage_app'@'%';

-- ---- R7 slice 1 · one storage for every chat ----
-- 0275 `user_presence` / `link_previews` (tenant): the app upserts a person's heartbeat (INSERT,
-- UPDATE) and creates the pending preview row when a message with a link is posted (INSERT);
-- DELETE on both is held for the company erasure. SELECT rides the database-wide read. The worker
-- unfurls the link (SSRF-guarded) and records the result: INSERT for a message the app did not
-- stage, UPDATE to mark ready / failed, and SELECT where it writes (claiming pending rows; the
-- census requires the worker to read every table it writes). The new columns on
-- `conversations`, `conversation_memberships`, `messages` and `conversation_read_state` ride the
-- table-level grants those tables already have. 0276 copies direct messages as the migrator.
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`user_presence`          TO 'tmanage_app'@'%';
GRANT INSERT, UPDATE, DELETE ON `tmanage`.`link_previews`          TO 'tmanage_app'@'%';
GRANT SELECT, INSERT, UPDATE ON `tmanage`.`link_previews`          TO 'tmanage_worker'@'%';

-- ---- R12 slice 1 · IP intelligence ----
-- 0280 `ip_lookups` (global, no tenant): the app writes the IP cache on every sign-in and session
-- refresh (INSERT a new address, UPDATE to refresh it after 30 days and bump `last_seen_at`); SELECT
-- is stated with the writes it pairs with. The worker's retention sweep reads and deletes rows unseen
-- for GEOIP_RETENTION_DAYS (SELECT, DELETE) — the cache is derived data, never work a person made.
-- The new `authentication_events` and `sessions` columns ride the existing table-level grants.
GRANT SELECT, INSERT, UPDATE ON `tmanage`.`ip_lookups`             TO 'tmanage_app'@'%';
GRANT SELECT, DELETE ON `tmanage`.`ip_lookups`                     TO 'tmanage_worker'@'%';

-- ---- R13 slice 5 · 57-14 Growth rollups ----
-- 0284 `platform_growth_rollups` (global, no tenant): the worker's nightly growth job upserts the
-- rollups (SELECT, INSERT, UPDATE on the unique key) and deletes rows older than 13 months
-- (DELETE) — derived numbers, never work a person made. The app's SELECT rides the database-wide
-- read (the Growth route reads only). The job reads its sources: `product_events` (sign-up source,
-- cohort retention by actor hash), `subscriptions` (MRR) and `approvals` (turnaround); the
-- organizations, projects, invitations, work items, decisions and project clients it counts are
-- already readable. Ids, hashes and timestamps only — no content column is selected (PRIV-06).
GRANT SELECT, INSERT, UPDATE, DELETE ON `tmanage`.`platform_growth_rollups` TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`product_events`                         TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`subscriptions`                          TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`approvals`                              TO 'tmanage_worker'@'%';

-- ---- R13 slice 4 · working calendar ----
-- 0283 `org_working_calendars` / `org_holidays` (tenant): the app reads and writes the company
-- calendar and project overrides (INSERT, UPDATE with the version check), adds, imports and
-- removes holidays (INSERT, DELETE), and DELETEs both for the company erasure; SELECT is stated with
-- the writes it pairs with. The worker's due-soon sweep and weekend hold read the company calendar
-- and its holidays (SELECT only — the worker never writes a calendar).
GRANT SELECT, INSERT, UPDATE, DELETE ON `tmanage`.`org_working_calendars` TO 'tmanage_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `tmanage`.`org_holidays`          TO 'tmanage_app'@'%';
GRANT SELECT ON `tmanage`.`org_working_calendars`                  TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`org_holidays`                           TO 'tmanage_worker'@'%';

-- ---- R13 slice 2 · outbound webhooks v2 ----
-- 0281 adds columns only; the app's grants on `webhook_endpoints` (INSERT, UPDATE: create, rotate,
-- pause/resume, events) and `webhook_deliveries` (INSERT: a manual retry or a replay stages a
-- pending row) are unchanged. The worker delivers: it reads the endpoints and trips the breaker
-- (SELECT, UPDATE on `webhook_endpoints` — `failure_streak`, `status`, `paused_reason`), and it
-- settles each attempt and schedules the next (INSERT, UPDATE on `webhook_deliveries`; SELECT was
-- granted with 56-23). The event payload is read from `outbox_events` and the admin notice is
-- written to `notifications` under grants the relay already holds. Never DELETE on either table.
GRANT SELECT, UPDATE ON `tmanage`.`webhook_endpoints`              TO 'tmanage_worker'@'%';
GRANT INSERT, UPDATE ON `tmanage`.`webhook_deliveries`             TO 'tmanage_worker'@'%';

-- ---- R15 slice c · Slack / Teams channel notices (Phase 0) ----
-- 0289 `integration_channel_links` / `integration_channel_posts` (tenant): the app creates, lists,
-- resumes and removes a pasted channel (SELECT, INSERT, UPDATE, DELETE on links; the ledger rows go
-- with a removed link by ON DELETE CASCADE) and stages a test post (SELECT, INSERT on posts). The
-- worker stages one post per matching link inside the event's transaction and settles it
-- (SELECT, INSERT, UPDATE on posts), and trips the breaker (SELECT, UPDATE on links). Never DELETE
-- for the worker.
GRANT SELECT, INSERT, UPDATE, DELETE ON `tmanage`.`integration_channel_links` TO 'tmanage_app'@'%';
GRANT SELECT, INSERT ON `tmanage`.`integration_channel_posts`      TO 'tmanage_app'@'%';
GRANT SELECT, UPDATE ON `tmanage`.`integration_channel_links`      TO 'tmanage_worker'@'%';
GRANT SELECT, INSERT, UPDATE ON `tmanage`.`integration_channel_posts` TO 'tmanage_worker'@'%';

-- ---- R15-b · 52-03 period locks ----
-- 0288 `time_period_locks` (tenant): finance closes a window (INSERT, or UPDATE to reopen a row of
-- the same month) and stamps the entry count and the reopen (UPDATE); a lock row is history and no
-- statement deletes one, so **no DELETE**. SELECT is stated with the writes. The lock stamps
-- `locked_at` on the window's `work_item_time_logs` entries and the unlock clears it — the first
-- UPDATE statement on that table, so its UPDATE is granted here (the 0288 triggers keep every data
-- column of a locked entry fixed). The worker reads neither.
GRANT SELECT, INSERT, UPDATE ON `tmanage`.`time_period_locks`    TO 'tmanage_app'@'%';
GRANT UPDATE ON `tmanage`.`work_item_time_logs`                   TO 'tmanage_app'@'%';

-- ---- R15-a · 52-04 rates ----
-- 0287 `rate_cards` / `rate_card_entries` / `member_cost_rates` (tenant): finance managers create,
-- edit, archive and delete cards, entries and cost rates; members' time entries read them to take
-- a price snapshot. The worker reads the two card tables (later budget/invoice jobs) and never
-- `member_cost_rates` (a salary proxy). Re-pricing unbilled entries updates the snapshot columns of
-- `work_item_time_logs`, so its UPDATE is stated here too (the same grant R15-b states for locks).
GRANT SELECT, INSERT, UPDATE, DELETE ON `tmanage`.`rate_cards`        TO 'tmanage_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `tmanage`.`rate_card_entries` TO 'tmanage_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `tmanage`.`member_cost_rates` TO 'tmanage_app'@'%';
GRANT UPDATE ON `tmanage`.`work_item_time_logs`                   TO 'tmanage_app'@'%';
GRANT SELECT ON `tmanage`.`rate_cards`                             TO 'tmanage_worker'@'%';
GRANT SELECT ON `tmanage`.`rate_card_entries`                      TO 'tmanage_worker'@'%';

-- ---- R16-c · 52-07 expenses ----
-- 0292 `expenses` (tenant): a member records, edits, submits and deletes an own draft (DELETE);
-- approvers approve or reject (UPDATE); finance exports (SELECT). The 0292 triggers keep a locked
-- row's data columns fixed and refuse its DELETE. The worker holds nothing on it.
GRANT SELECT, INSERT, UPDATE, DELETE ON `tmanage`.`expenses`          TO 'tmanage_app'@'%';

-- ---- R16-f · 54-11 contact suggestions (Phase 0) ----
-- 0295 `contact_suggestions` (tenant, per user): the app imports a caller's contacts file (INSERT,
-- or UPDATE of the same address to refresh `expires_at`), lists the caller's own unexpired rows
-- (SELECT), deletes the caller's expired rows on each import and clears the caller's list
-- (DELETE). Expiry is lazy, so the worker reads and writes nothing here.
GRANT SELECT, INSERT, UPDATE, DELETE ON `tmanage`.`contact_suggestions` TO 'tmanage_app'@'%';
