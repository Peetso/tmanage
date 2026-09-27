-- 0096_member_availability — a member's out-of-office / availability windows (module 14 People &
-- capacity, x218).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §People & capacity; 25-AUTHORIZATION-
-- AND-TENANT-ISOLATION §6 (composite tenant keys); 07-DATA-MODEL §9 (index prefixes lead with
-- organization_id). Distinct from x170 weekly capacity (person_capacity — hours per week) and x215
-- quiet-hours (pref_quiet_hours — a per-day time-of-day window): this is a dated *out-of-office*
-- window — a member is away between two calendar dates — read by the member themselves and by the
-- team (a read of one member's windows).
--
-- ## Migration number
--
-- The pass-23 map reserves 0096 for x218. The migrator applies files in ascending numeric order and a
-- gap is not an error (it rejects only a NEW file numbered *below* an applied one), so 0096 is correct
-- on this base; nothing here depends on the literal number beyond the filename.
--
-- ## Many windows per member, keyed by membership within the tenant
--
-- Unlike person_capacity (one row per member) this is a *list*: a member has zero or more OOO windows.
-- A row is one window of one membership in one studio, tenant-owned like person_skills (0070) and
-- registered in the query guard's TENANT_TABLES. It is keyed to member_id (a membership), never the
-- global user_id: an availability window is scoped to who the caller is *in this studio* and never
-- leaves the tenant. The composite foreign key binds the row to a membership of this same
-- organization, so a cross-tenant member_id is a non-existent pair rather than a leak — the engine
-- half of the trap the controller also enforces in code (a cross-tenant :membershipId is a 404).
--
-- ## kind is a small fixed vocabulary, validated by the application
--
-- kind names why the member is away (vacation, sick, holiday, personal, other). It is a VARCHAR the
-- application validates against a fixed allowlist (availability.controller.ts) — the same division
-- person_skills.level and other small vocabularies use — so an unknown kind is a 400 with no write.
-- start_date and end_date bound the window; the application refuses end_date < start_date (400, no
-- write) using bound Date values, never the admin-pool clock.
--
-- ## Added and removed, immutable while it exists
--
-- A window is added (INSERT) and removed (DELETE) — a member edits by delete-and-add, never UPDATE —
-- so the runtime credential is granted INSERT and DELETE and no UPDATE (scripts/db/users.sql), and the
-- BEFORE UPDATE trigger refuses any amendment for every credential besides, the work_item_files
-- (0086) and work_item_dependencies (0011) defence-in-depth posture.

CREATE TABLE member_availability (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The membership whose OOO window this row holds. The composite FK below binds it to a membership
  -- of this same organization, so a window can never cite a member of another studio.
  member_id       CHAR(36)     NOT NULL,
  -- The window bounds, inclusive. The application refuses end_date < start_date (400) using bound
  -- Date values, never the database clock.
  start_date      DATE         NOT NULL,
  end_date        DATE         NOT NULL,
  -- Why the member is away. A small fixed vocabulary validated by the application against an
  -- allowlist; an unknown value is a 400 with no write.
  kind            VARCHAR(20)  NOT NULL,
  -- An optional free-text note. Length is bounded by the application (400).
  note            VARCHAR(500),
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, the target of the composite FKs
  -- that bind child rows within one tenant (and the isolation corpus requires it).
  UNIQUE KEY uq_member_availability_org_id (organization_id, id),
  -- The index the list read is served by: this tenant's windows for one member, in start-date (then
  -- id) order. Leads with organization_id per §9.
  KEY ix_member_availability_member (organization_id, member_id, start_date, id),
  CONSTRAINT fk_member_availability_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The membership, bound within its own tenant: the composite key refuses a membership id from
  -- outside this row's organization, so an availability window can never cite a membership in another
  -- studio.
  CONSTRAINT fk_member_availability_member_tenant
    FOREIGN KEY (organization_id, member_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A window is immutable while it exists: it is added and removed, never edited. The trigger holds
-- that at the engine — ADR-0001 layers 3 and 4 are application-side and a direct SQL session bypasses
-- both — for the credentials that do hold UPDATE. The runtime credential holds none (users.sql), so
-- this is defence in depth, the work_item_files posture.
DELIMITER $$

CREATE TRIGGER trg_member_availability_immutable
BEFORE UPDATE ON member_availability FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'member_availability rows are immutable; a window is delete-and-add, not UPDATE';
END$$

DELIMITER ;
