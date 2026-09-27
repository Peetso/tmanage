-- 0155_user_shortcut_prefs — a member's own keyboard-shortcut overrides: the chord they have bound
-- to a command-palette action, or the reset that returns it to the shipped default (module 20
-- Preferences & accessibility, PRF keyboard shortcuts, x286).
--
-- Governing sources: 42-INTERACTION §keyboard (the app ships a fixed shortcut map and a member may
-- rebind an action); 22-SCREEN PRF (the preferences keyboard screen); 38-MODULE-MAP §Preferences;
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys); 07-DATA-MODEL §9 (index
-- prefixes lead with organization_id). Complements the command palette (x181): the action_key is a
-- command id from that fixed registry, so this table can only ever override an action the palette
-- already declares.
--
-- ## Migration number
--
-- The pass-25 queue map reserves 0155 for x286. The highest migration present on this slice's base
-- (master 5b3fcf08) is 0115; 0116-0154 are reserved by sibling pass-24/25 branches not yet
-- integrated. The migrator applies files in ascending numeric order and a gap is not an error (it
-- rejects only a NEW file numbered below an applied one), so 0155 on top of 0115 is correct on this
-- base. If the integration renumbers the reservations, the integrator renumbers this file with them.
--
-- ## One row per member per action per studio, keyed by membership
--
-- A row is one membership's override of one action in one studio, keyed `(organization_id,
-- membership_id, action_key)` — tenant-owned like `home_widget_prefs` (0115) and `a11y_preferences`
-- (0079), registered in the query guard's TENANT_TABLES. It is keyed to `membership_id`, not the
-- global `user_id`: the override is scoped to who the caller is in this studio and never leaves the
-- tenant, and the composite foreign key binds the row to a membership of this same organization. The
-- route has no path or query that could name another membership — the acting membership comes from
-- the authenticated principal — so a caller reads, rebinds, and resets their own rows and no other's.
--
-- ## action_key is validated against the palette's fixed registry; chord against a fixed grammar
--
-- Both `action_key` and `chord` are validated by the application (`shortcut-prefs.controller.ts` /
-- `.service.ts`) before an INSERT: an action_key that is not a command id in the palette's registry
-- is a 400 and nothing is written, and a chord that does not match the allowed grammar (zero or more
-- modifiers plus one key) is a 400 and nothing is written — the same division `a11y_preferences.
-- a11y_json` (0079) uses. Absence of a row means the action resolves to its shipped default, so
-- "never rebound" and "reset to default" are one behaviour, not two.
--
-- ## The rebind is one upsert; the reset is a delete; identity is immutable
--
-- The repository writes `INSERT ... ON DUPLICATE KEY UPDATE` against
-- `uq_user_shortcut_prefs_org_membership_action`, so a second rebind of the same action updates in
-- place and a lost update is not expressible. `updated_at` follows the column's `ON UPDATE`. A reset
-- is a DELETE of the caller's own `(membership, action)` row, idempotent (no row is still a success).
-- This slice grants the app INSERT, UPDATE (the upsert) and DELETE (the reset). `organization_id`,
-- `membership_id` and `action_key` are what a row is; the BEFORE UPDATE trigger pins them at the
-- engine so an UPDATE can move only the chord and updated_at.

CREATE TABLE user_shortcut_prefs (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  -- The membership whose override this row holds. Private to it: the read and the write are both
  -- scoped by membership_id = the acting context's membership, so one member never sees, rebinds or
  -- resets another's shortcut even inside the same tenant. The composite FK below binds it to a
  -- membership of this same organization.
  membership_id    CHAR(36)     NOT NULL,
  -- The command-palette action this row rebinds. Validated by the application against the palette's
  -- fixed command registry; an unknown key is a 400 and nothing is written.
  action_key       VARCHAR(64)  NOT NULL,
  -- The chord bound to the action, e.g. `Ctrl+K` or `Ctrl+Shift+P`. Validated by the application
  -- against the allowed grammar (zero or more modifiers plus one key); a malformed chord is a 400.
  chord            VARCHAR(64)  NOT NULL,
  updated_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, the target of the composite FKs
  -- that bind child rows within one tenant (and the isolation corpus requires it).
  UNIQUE KEY uq_user_shortcut_prefs_org_id (organization_id, id),
  -- One row per member per action per studio. This is the upsert key: the repository writes
  -- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a repeated rebind updates in place.
  UNIQUE KEY uq_user_shortcut_prefs_org_membership_action
    (organization_id, membership_id, action_key),
  CONSTRAINT fk_user_shortcut_prefs_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The membership, bound within its own tenant: the composite key refuses a membership id from
  -- outside this row's organization, so an override can never cite a membership in another studio.
  CONSTRAINT fk_user_shortcut_prefs_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A row's tenant, membership and action are what it is and are immutable; only the chord and
-- updated_at change. The trigger holds identity at the engine, the reason every other identity
-- trigger in this schema exists.
DELIMITER $$

CREATE TRIGGER trg_user_shortcut_prefs_immutable
BEFORE UPDATE ON user_shortcut_prefs FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'user_shortcut_prefs.organization_id is immutable';
  END IF;
  IF NEW.membership_id <> OLD.membership_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'user_shortcut_prefs.membership_id is immutable';
  END IF;
  IF NEW.action_key <> OLD.action_key THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'user_shortcut_prefs.action_key is immutable';
  END IF;
END$$

DELIMITER ;
