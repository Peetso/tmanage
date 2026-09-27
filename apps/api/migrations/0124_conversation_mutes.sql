-- 0124_conversation_mutes — a member's own mute/unmute state for one conversation (module Chat,
-- CH-09 "Channel details" settings, x252).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Chat; 25-AUTHORIZATION-AND-TENANT-
-- ISOLATION §6 (composite tenant keys); 07-DATA-MODEL §9 (index prefixes lead with organization_id).
-- This is a per-member notification preference on a conversation — "do not notify me about this
-- channel" — read and written whole, self-scoped, and dispatch-neutral this slice (nothing reads it
-- to suppress a notification yet; the row is the durable preference the later dispatch change honours).
--
-- ## Migration number
--
-- The pass-24 queue reserves 0124 for x252. The migrator applies files in ascending numeric order and
-- a gap is not an error (it rejects only a NEW file numbered *below* an applied one), so 0124 is
-- correct on this base; nothing here depends on the literal number beyond the filename.
--
-- ## One row per member per conversation, keyed by membership
--
-- A row is one membership's mute flag on one conversation, keyed `(organization_id, conversation_id,
-- membership_id)` — tenant-owned like `pref_quiet_hours` (0093) and registered in the query guard's
-- TENANT_TABLES. It is keyed to `membership_id`, not the global `user_id`: the state is scoped to who
-- the caller is *in this studio* and never leaves the tenant. Composite foreign keys bind the row to a
-- conversation and a membership of this same organization, so a mute row can never cite either from
-- another studio. The route resolves the conversation within the tenant before it authorizes, so a
-- conversation in another studio is a 404 and no row is ever written for it.
--
-- ## The write is one upsert; identity is immutable
--
-- The service writes `INSERT ... ON DUPLICATE KEY UPDATE` against
-- `uq_conversation_mutes_org_conv_membership`, so a second save flips the flag in place and a lost
-- update is not expressible. `muted` is a boolean (TINYINT(1)); the application rejects a non-boolean
-- with 400 before any write. `updated_at` follows the column's `ON UPDATE`. This slice grants the app
-- INSERT and UPDATE (the upsert), no DELETE — a member unmutes by saving `false`, not by removing the
-- row. `organization_id`, `conversation_id` and `membership_id` are what a row *is*; the BEFORE UPDATE
-- trigger pins them at the engine (ADR-0001 layers 3 and 4 are application-side and a direct SQL
-- session bypasses both).

CREATE TABLE conversation_mutes (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The conversation this mute state applies to, bound within its own tenant by the composite FK.
  conversation_id CHAR(36)     NOT NULL,
  -- The membership whose mute state this row holds. Private to it: the read and the upsert are both
  -- scoped by membership_id = the acting context's membership, so one member never sees or replaces
  -- another's state even inside the same tenant. The composite FK binds it to a membership of this
  -- same organization.
  membership_id   CHAR(36)     NOT NULL,
  -- Whether this member has muted the conversation. A boolean; the application rejects a non-boolean
  -- body with 400 before any write. Unmute is `0`, not a deleted row.
  muted           TINYINT(1)   NOT NULL DEFAULT 0,
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                               ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, the target of the composite FKs
  -- that bind child rows within one tenant (and the isolation corpus requires it).
  UNIQUE KEY uq_conversation_mutes_org_id (organization_id, id),
  -- One row per member per conversation. This is the upsert key: the service writes
  -- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in place.
  UNIQUE KEY uq_conversation_mutes_org_conv_membership (organization_id, conversation_id, membership_id),
  CONSTRAINT fk_conversation_mutes_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The conversation, bound within its own tenant: the composite key refuses a conversation id from
  -- outside this row's organization.
  CONSTRAINT fk_conversation_mutes_conversation_tenant
    FOREIGN KEY (organization_id, conversation_id) REFERENCES conversations (organization_id, id),
  -- The membership, bound within its own tenant: the composite key refuses a membership id from
  -- outside this row's organization.
  CONSTRAINT fk_conversation_mutes_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A row's tenant, conversation and membership are what it is and are immutable; only `muted` and
-- updated_at change. The trigger holds identity at the engine, the reason every other identity
-- trigger in this schema exists.
DELIMITER $$

CREATE TRIGGER trg_conversation_mutes_immutable
BEFORE UPDATE ON conversation_mutes FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversation_mutes.organization_id is immutable';
  END IF;
  IF NEW.conversation_id <> OLD.conversation_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversation_mutes.conversation_id is immutable';
  END IF;
  IF NEW.membership_id <> OLD.membership_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversation_mutes.membership_id is immutable';
  END IF;
END$$

DELIMITER ;
