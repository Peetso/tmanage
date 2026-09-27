-- 0122_conversation_read_state — a member's last-read position per conversation, and the unread
-- count computed from it (module CHAT / conversations, x250).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Chat (CH-05 "unread position",
-- CH-04 participant state); 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC §5-6 (scoped writes,
-- composite (organization_id, id) foreign keys); 07-DATA-MODEL §9 (every composite index begins
-- with organization_id); ADR-0001 (MySQL has no row-level security; layers 3-5 replace it).
--
-- ## Migration number
--
-- The pass-24 queue map reserves 0122 for x250. The highest migration present on this slice's base
-- (origin/master 174cf4f) is 0093; 0094-0121 are reserved by sibling pass-19..24 branches not yet
-- integrated. The migrator applies files in ascending numeric order and a gap is not an error (it
-- rejects only a NEW file numbered below an applied one), so 0122 on top of 0093 is correct on this
-- base. If the integration renumbers the reservations, the integrator renumbers this file with them.
--
-- ## One row per member per conversation, keyed by membership
--
-- A row is one membership's last-read position in one channel, keyed `(organization_id,
-- conversation_id, membership_id)`. It is keyed to `membership_id`, not the global `user_id`: the
-- position is scoped to who the caller is in this studio and never leaves the tenant, and the
-- composite foreign key binds the row to a membership of this same organization. The route has no
-- path or body field that could name another membership — the acting membership comes from the
-- authenticated principal — so a caller reads and upserts their own row and no other.
--
-- ## `last_read_message_id` is validated by the application, not a foreign key
--
-- `messages` carries no `(organization_id, id)` unique key to bind to: its key is
-- `(organization_id, id, depth)` (0007, so a reply's parent can be forced to be a root). A composite
-- FK on `(organization_id, last_read_message_id)` therefore has no target. The application closes the
-- gap instead — the service resolves the message tenant-scoped and refuses a `last_read_message_id`
-- that does not belong to this conversation with a 400 before any write, so a read position can never
-- cite a message from another conversation or another tenant.
--
-- ## The write is one upsert; identity is immutable
--
-- The repository writes `INSERT ... ON DUPLICATE KEY UPDATE` against
-- `uq_conversation_read_state_member`, so a second mark-read updates in place and a lost update is
-- not expressible. Only `last_read_message_id`, `read_at` and `updated_at` change; the tenant,
-- conversation and membership are what a row is, and the BEFORE UPDATE trigger pins them at the
-- engine. This slice grants the app INSERT and UPDATE (the upsert), no DELETE — a read position is
-- only ever advanced, never removed.

CREATE TABLE conversation_read_state (
  id                    CHAR(36)     NOT NULL,
  organization_id       CHAR(36)     NOT NULL,
  -- The conversation this read position is in. The composite FK below binds it to the tenant.
  conversation_id       CHAR(36)     NOT NULL,
  -- The membership whose read position this row holds. Private to it: the read and the upsert are
  -- both scoped by membership_id = the acting context's membership, so one member never sees or
  -- replaces another's position even inside the same tenant.
  membership_id         CHAR(36)     NOT NULL,
  -- The last message this member has read in the conversation. Not a foreign key (see the header):
  -- the application resolves it tenant-scoped and refuses one from another conversation with a 400.
  last_read_message_id  CHAR(36)     NOT NULL,
  -- When the position was last advanced. Set by the application on every upsert.
  read_at               DATETIME(3)  NOT NULL,
  updated_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                     ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, the target of the composite
  -- FKs that bind child rows within one tenant (and the isolation corpus requires it).
  UNIQUE KEY uq_conversation_read_state_org_id (organization_id, id),
  -- One row per member per conversation. This is the upsert key: the repository writes
  -- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second mark-read updates in place. Leads
  -- with organization_id per 07-DATA-MODEL §9.
  UNIQUE KEY uq_conversation_read_state_member (organization_id, conversation_id, membership_id),
  CONSTRAINT fk_conversation_read_state_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The conversation, bound within its own tenant: the composite key refuses a conversation id from
  -- outside this row's organization.
  CONSTRAINT fk_conversation_read_state_conversation_tenant
    FOREIGN KEY (organization_id, conversation_id) REFERENCES conversations (organization_id, id),
  -- The membership, bound within its own tenant: a position can never cite a membership in another
  -- studio.
  CONSTRAINT fk_conversation_read_state_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A row's tenant, conversation and membership are what it is and are immutable; only the read
-- position and its timestamps change. The trigger holds identity at the engine, the reason every
-- other identity trigger in this schema exists.
DELIMITER $$

CREATE TRIGGER trg_conversation_read_state_immutable
BEFORE UPDATE ON conversation_read_state FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversation_read_state.organization_id is immutable';
  END IF;
  IF NEW.conversation_id <> OLD.conversation_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversation_read_state.conversation_id is immutable';
  END IF;
  IF NEW.membership_id <> OLD.membership_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversation_read_state.membership_id is immutable';
  END IF;
END$$

DELIMITER ;
