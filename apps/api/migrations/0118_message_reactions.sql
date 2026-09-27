-- 0118_message_reactions — chat message reactions (Chat module, CH-07 "Message actions", x246).
--
-- Governing sources: 22/41-SCREEN CH-07 "Message actions" (PRD "…mentions, attachments, reactions…");
-- 38-MODULE-MAP §Chat; 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys,
-- `(organization_id, id)` on every tenant table); 07-DATA-MODEL §9 (index prefixes lead with
-- `organization_id`); ADR-0001 (MySQL has no row-level security; the withheld privilege and the
-- tenant/membership predicates are the control).
--
-- ## Migration number
--
-- Pass 24 reserves 0118-0144 in slice-id order; x246's reservation is 0118 (pass24-queue header
-- migration map). The highest migration present on this slice's base (origin/master after pass 23)
-- is lower — the sibling pass branches land the intervening numbers from branches not yet integrated
-- here. The migrator applies files in ascending numeric order and a gap is legitimate (it rejects
-- only a NEW file numbered *below* an applied one), so 0118 on this base is correct; nothing depends
-- on the literal 0118 beyond the filename, and the integrator renumbers with the reservations if
-- they move.
--
-- ## What this is
--
-- One member's one emoji reaction on one message. A member adds a reaction (idempotent), removes
-- their own (idempotent), and anyone who can read the channel reads the tally grouped by emoji.
--
--   * The reaction belongs to a **membership** (`membership_id`), not a bare user id: it is the
--     acting seat's, self-scoped, and a member may only add or remove their own — the DELETE path
--     is predicated on `membership_id = the acting membership`, so one member can never clear
--     another's reaction, and the tally's "did I react" is that membership's own rows.
--   * `emoji` is a short string drawn from a fixed application allowlist (the controller refuses
--     anything else with 400), stored verbatim; the column is deliberately not an ENUM so widening
--     the allowlist is an application change, not a migration.
--
-- ## Uniqueness and idempotency
--
-- `uq_message_reactions_identity (organization_id, message_id, membership_id, emoji)` is what makes
-- the add idempotent: a second add of the same (message, membership, emoji) collides on this key and
-- the repository upserts in place rather than adding a duplicate. The tally's group-by counts
-- distinct memberships per emoji because a membership can hold at most one row per emoji here.
--
-- ## Grants and immutability
--
-- The runtime credential is granted INSERT and DELETE and **no UPDATE**: a reaction is added and
-- removed, never edited (the emoji IS the row), so the missing UPDATE privilege keeps a row's
-- identity fixed and no immutability trigger is needed because no credential may UPDATE at all.

CREATE TABLE message_reactions (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The message reacted to. References messages (id) — messages carries a plain PRIMARY KEY (id),
  -- so a single-column FK is available; the tenant predicate on every read keeps the reaction and
  -- its message in the same studio.
  message_id      CHAR(36)     NOT NULL,
  -- The reacting seat. References memberships (id); a reaction is a membership's, and self-scoping
  -- the add/remove to `context.membershipId` is what keeps one member from touching another's.
  membership_id   CHAR(36)     NOT NULL,
  -- The reaction glyph, from the application's fixed allowlist. VARCHAR(24) holds the longest
  -- allowed grapheme cluster (a base glyph plus a variation selector or ZWJ sequence) with room to
  -- spare; not an ENUM, so the allowlist widens in code rather than by ALTER TABLE.
  emoji           VARCHAR(24)  NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries (25-AUTH §6), so a future child
  -- can reference this row without a cross-tenant path and the isolation corpus is satisfied.
  UNIQUE KEY uq_message_reactions_org_id (organization_id, id),
  -- Idempotency: one row per (message, membership, emoji). The add upserts against this key.
  UNIQUE KEY uq_message_reactions_identity (organization_id, message_id, membership_id, emoji),
  -- The tally index: every reaction on one message, grouped by emoji. Leads with `organization_id`
  -- per 07-DATA-MODEL §9, then `message_id` (the equality predicate) and `emoji` (the group key).
  KEY ix_message_reactions_message (organization_id, message_id, emoji),
  CONSTRAINT fk_message_reactions_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_message_reactions_message
    FOREIGN KEY (message_id) REFERENCES messages (id),
  CONSTRAINT fk_message_reactions_membership
    FOREIGN KEY (membership_id) REFERENCES memberships (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
