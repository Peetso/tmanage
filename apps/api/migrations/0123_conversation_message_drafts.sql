-- 0123_conversation_message_drafts — a member's unsent composer draft for one conversation, so
-- what they were typing survives navigating away and back (module Chat, CH-06 "Composer", x251).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Chat (CH-06 composer / unsent state);
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys); 07-DATA-MODEL §9 (index prefixes
-- lead with organization_id). Distinct from `messages` (0007): a message is a sent, sequenced,
-- append-only row in the transcript; a draft is a single mutable scratch row that never enters the
-- transcript and is cleared the moment the member sends or discards.
--
-- ## Migration number
--
-- The pass-24 map reserves 0123 for x251. The migrator applies files in ascending numeric order and
-- a gap is not an error (it rejects only a NEW file numbered *below* an applied one), so 0123 is
-- correct on this base; nothing here depends on the literal number beyond the filename.
--
-- ## One row per member per conversation, keyed by membership
--
-- A row is one membership's draft for one conversation, keyed `(organization_id, conversation_id,
-- membership_id)` — tenant-owned like `pref_quiet_hours` (0093) and registered in the query guard's
-- TENANT_TABLES. It is keyed to `membership_id`, not the global `user_id`: a draft is scoped to who
-- the caller is *in this studio* and never leaves the tenant, and the composite foreign key binds the
-- row to a membership of this same organization. The route has no path or query that could name
-- another membership — the acting membership comes from the authenticated principal — so a caller
-- reads, writes and clears their own draft and no other. The conversation is resolved and its
-- membership gate applied before any of this table is touched (message-drafts.service.ts).
--
-- ## body_json is the draft, stored whole
--
-- The draft — `{ "body": "<composer text>" }` — is a small object read and written as one, never
-- queried across rows, so it is one JSON column rather than typed columns. The composer text length
-- is bounded by the application (message-drafts.controller.ts) exactly as a posted message is; over
-- the cap is a 400 and nothing is written. Absence of a row is "no draft", which is the shipped
-- default, so "never typed" and "cleared" are one behaviour, not two.
--
-- ## The write is one upsert; identity is immutable
--
-- The service writes `INSERT ... ON DUPLICATE KEY UPDATE` against
-- `uq_conversation_message_drafts_identity`, so a second save updates in place and a lost update is
-- not expressible. `updated_at` follows the column's `ON UPDATE`. `organization_id`,
-- `conversation_id` and `membership_id` are what a row *is*; the BEFORE UPDATE trigger pins them at
-- the engine (ADR-0001 layers 3 and 4 are application-side and a direct SQL session bypasses both).
-- This slice grants the app INSERT, UPDATE (the upsert) and DELETE — clearing a draft on send is an
-- ordinary removal, and there is no history a draft is the record of.

CREATE TABLE conversation_message_drafts (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The conversation this draft belongs to, bound within its own tenant by the composite FK below.
  conversation_id CHAR(36)     NOT NULL,
  -- The membership whose draft this row holds. Private to it: the read, the upsert and the delete are
  -- all scoped by membership_id = the acting context's membership, so one member never sees, replaces
  -- or clears another's draft even inside the same tenant. The composite FK binds it to a membership
  -- of this same organization.
  membership_id   CHAR(36)     NOT NULL,
  -- The draft, stored whole: `{ "body": "<composer text>" }`. Shape and length are validated by the
  -- application; the column stores it whole.
  body_json       JSON         NOT NULL,
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                               ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, the target of the composite FKs
  -- that bind child rows within one tenant (and the isolation corpus requires it).
  UNIQUE KEY uq_conversation_message_drafts_org_id (organization_id, id),
  -- One row per member per conversation. This is the upsert key: the service writes
  -- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in place.
  UNIQUE KEY uq_conversation_message_drafts_identity (organization_id, conversation_id, membership_id),
  CONSTRAINT fk_conversation_message_drafts_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The conversation, bound within its own tenant: the composite key refuses a conversation id from
  -- outside this row's organization, so a draft can never cite a conversation in another studio.
  CONSTRAINT fk_conversation_message_drafts_conversation_tenant
    FOREIGN KEY (organization_id, conversation_id) REFERENCES conversations (organization_id, id),
  -- The membership, bound within its own tenant, the same way `pref_quiet_hours` binds its.
  CONSTRAINT fk_conversation_message_drafts_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A row's tenant, conversation and membership are what it is and are immutable; only the draft and
-- updated_at change. The trigger holds identity at the engine, the reason every other identity
-- trigger in this schema exists.
DELIMITER $$

CREATE TRIGGER trg_conversation_message_drafts_immutable
BEFORE UPDATE ON conversation_message_drafts FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversation_message_drafts.organization_id is immutable';
  END IF;
  IF NEW.conversation_id <> OLD.conversation_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversation_message_drafts.conversation_id is immutable';
  END IF;
  IF NEW.membership_id <> OLD.membership_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversation_message_drafts.membership_id is immutable';
  END IF;
END$$

DELIMITER ;
