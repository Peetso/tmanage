-- 0078_user_preferences — PREF-001: per-member appearance & accessibility preferences (x182).
--
-- Governing sources: 38-MODULE-MAP.md §Preferences & accessibility (module 20, audit Partial 1.0 —
-- the appearance/locale surface absent), 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md §5-6 (scoped
-- writes, composite (organization_id, id) foreign keys), 07-DATA-MODEL.md §9 (every composite index
-- begins with organization_id), ADR-0001 (MySQL has no row-level security; layers 3-5 replace it).
--
-- ## Migration numbering
--
-- Numbered 0078 as reserved by the pass-21 queue header (x182 = 0078, in slice-id order). The
-- migrator applies files in ascending numeric order and treats versions as a set, not positions
-- (migrator.db.test), so a gap on this base is legitimate; the integrator renumbers only if a
-- collision appears after the merges.
--
-- ## What this is, and how it differs from notification_preferences (0022)
--
-- This is the appearance/locale surface: one row per membership per studio holding that member's own
-- theme, locale and interface density. `notification_preferences` (0022) is the delivery-channel
-- surface, keyed by user; this is its sibling and shares nothing with it. The settings are stored as
-- a single fixed-key JSON blob (prefs_json) rather than a column per setting: the set grows as the
-- appearance surface does, and the write validator (a closed allowlist per key) — not the column
-- shape — is what keeps a value the app cannot render out of the blob.
--
-- ## Own-principal: keyed by membership, created and replaced, never removed
--
-- A row belongs to exactly one membership in one tenant. The only writes are INSERT (first save) and
-- UPDATE (replace) — the `INSERT ... ON DUPLICATE KEY UPDATE` upsert against
-- uq_user_preferences_org_membership. There is no DELETE path in the repository and no DELETE grant
-- in scripts/db/users.sql, so a member cannot be silently reverted to defaults they did not choose.
-- The read and the upsert are both scoped by membership_id = the acting context's membership, so one
-- member never reads or overwrites another's row even inside the same tenant.

CREATE TABLE user_preferences (
  id                CHAR(36)                               NOT NULL,
  organization_id   CHAR(36)                               NOT NULL,
  -- The membership whose settings this row holds. A preference is private to it: the read and the
  -- upsert are both scoped by membership_id = the acting context's membership. The composite FK below
  -- binds it to a membership of this same tenant.
  membership_id     CHAR(36)                               NOT NULL,
  -- The settings, as a fixed-key JSON object { theme, locale, density }. The write validator checks
  -- each key against a closed allowlist before the upsert, so an off-list value is a 400, never
  -- stored — the column type is JSON, the vocabulary is the code's.
  prefs_json        JSON                                   NOT NULL,
  created_at        DATETIME(3)                            NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)                            NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                                                    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The composite key every tenant-owned table carries, the target of the composite FKs that bind
  -- child rows within one tenant.
  UNIQUE KEY uq_user_preferences_org_id (organization_id, id),
  -- The upsert key: one settings row per membership per studio. A second save for the same member
  -- collides here and becomes the UPDATE arm of the upsert rather than a duplicate row.
  UNIQUE KEY uq_user_preferences_org_membership (organization_id, membership_id),
  CONSTRAINT fk_user_preferences_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
