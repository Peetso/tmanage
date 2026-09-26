-- 0057_notification_kind_prefs — per-kind notification opt-out (Notifications module 17, x152).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Notifications (per-kind
-- preferences — the carried "per-kind notif opt-out" gap NS-11 named); 22-SCREEN-BY-SCREEN-SPEC
-- TM-27 Preferences (notification channels/quiet hours/digest — this is the finer opt-out sitting
-- beside that coarse pref); 24-EVENT-CATALOG §6 (a notification is a reference envelope; who is
-- told what is a preference); 25-AUTHORIZATION-AND-TENANT-ISOLATION §5-6 (scoped writes, composite
-- (organization_id, id) keys); 07-DATA-MODEL §9 (every composite index begins with organization_id).
--
-- ## Migration numbering
--
-- Numbered 0057 as reserved by NEXT-SCOPES-12 (pass 20 reserves 0042…0059 in slice-id order). The
-- migrator applies files in ascending numeric order and treats versions as a set — a gap is
-- legitimate (a version reserved by a sibling branch not yet integrated here), so 0057 on this base
-- is correct; the integrator renumbers only if a collision appears after the merges. Nothing here
-- depends on the literal 0057 beyond the filename.
--
-- ## What this is, and how it differs from notification_preferences (0022)
--
-- `notification_preferences` (0022) is the coarse per-person row: the two channels, the digest
-- window, quiet hours — keyed by (organization_id, user_id). This is its finer sibling: one row per
-- (membership, kind) recording whether that one kind of notification is wanted. The coarse pref says
-- "email me"; this says "…but not about files". It stores the intent only — honouring a disabled
-- kind at delivery time (the bundler/relay suppressing a send) is the deferred half, recorded out of
-- scope in the status doc, exactly as 0022's quiet hours were stored before INBOX-001 read them.
--
-- ## Keyed by membership, not user, and own only
--
-- A pin/preference private to one seat in one studio is keyed by membership, like home_pinned_items
-- (0050): the composite FK (organization_id, membership_id) binds the row to a membership of this
-- same tenant, and every read and write is scoped by membership_id = the acting context's, so one
-- member never sees or changes another's opt-outs even inside the same tenant. There is no path or
-- body field that could name a different membership.
--
-- ## kind is a closed ENUM; absence is "enabled"
--
-- kind is an ENUM of the person-facing notification families (client_request, work_item, message,
-- file). A value outside the set is a write error at the engine, and the route rejects it 400 before
-- the write — the vocabulary is closed and a new family is a deliberate schema change. A kind with no
-- row is enabled: an account that has opted out of nothing is reachable about everything, the same
-- "absence is the default" 0022 takes, so "never set" and "set to enabled" are one behaviour.
--
-- ## Upsert, never a second row; created and updated, never identity-mutated
--
-- The only write is INSERT … ON DUPLICATE KEY UPDATE against uq_notification_kind_prefs_pref, so a
-- second save of the same (membership, kind) updates enabled in place rather than adding a row. The
-- runtime credential holds INSERT and UPDATE only (no DELETE): a preference is set and re-set, never
-- removed by a runtime session. updated_at follows the column's ON UPDATE.

CREATE TABLE notification_kind_prefs (
  id                CHAR(36)     NOT NULL,
  organization_id   CHAR(36)     NOT NULL,
  -- The membership whose opt-out this row belongs to. Private to it: the list and the upsert are
  -- both scoped by membership_id = the acting context's membership. The composite FK below binds it
  -- to a membership of this same tenant.
  membership_id     CHAR(36)     NOT NULL,
  -- The person-facing notification family this row's setting governs. ENUM, not a free string, so a
  -- typo is a write error and only the four families a person can opt out of are storable.
  kind              ENUM('client_request','work_item','message','file') NOT NULL,
  -- Whether this kind is wanted. TRUE by default — the safe default for being reached is
  -- "reachable" — so a row that exists only to disable a kind carries FALSE explicitly.
  enabled           BOOLEAN      NOT NULL DEFAULT TRUE,
  updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                 ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The composite tenant-unique every table in this schema carries, the target of the composite FKs
  -- that bind child rows within one tenant.
  UNIQUE KEY uq_notification_kind_prefs_org_id (organization_id, id),
  -- The upsert key: one row per membership per kind. A second save of the same pair updates in place
  -- rather than adding a row, and this same prefix (organization_id, membership_id) is the order the
  -- one read — a membership's per-kind settings — is served by.
  UNIQUE KEY uq_notification_kind_prefs_pref (organization_id, membership_id, kind),
  CONSTRAINT fk_notification_kind_prefs_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
