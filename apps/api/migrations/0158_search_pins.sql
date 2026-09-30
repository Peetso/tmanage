-- 0158_search_pins — pinned search results / quick-access entities (Search module 16, SRCH quick
-- access, x290).
--
-- Governing sources: 38-MODULE-MAP §Search quick access (pins on top of the SRCH-01 global search
-- x111, its ranking x148 and saved/recent x214); 22-SCREEN SR; 25-AUTHORIZATION-AND-TENANT-ISOLATION
-- §6 (composite tenant keys, `(organization_id, id)` on every tenant table); 07-DATA-MODEL §9 (index
-- prefixes lead with `organization_id`); ADR-0001 (MySQL has no row-level security; the withheld
-- privilege and the tenant/owner predicates are the control).
--
-- ## Migration number
--
-- Pass 25 reserves 0145-0173 in slice-id order; x290's reservation is 0158 (pass-25 queue header
-- map). The highest migration present on this slice's base (origin/master after pass 24) is lower —
-- the sibling pass-24/25 branches land the intervening numbers from branches not yet integrated
-- here. The migrator applies files in ascending numeric order and a gap is legitimate (it rejects
-- only a NEW file numbered *below* an applied one), so 0158 on this base is correct; nothing here
-- depends on the literal 0158 beyond the filename, and the integrator renumbers with the
-- reservations if they move.
--
-- ## What this is
--
-- Recent history (x214) and suggestions remember queries; this remembers *results*. A member pins
-- an indexed entity — a work item, a document, a meeting or a project — for quick access, lists
-- their pins, and unpins. A pin stores only a **type + id reference** (`object_type`, `object_id`)
-- and a display `label` the client caches; it holds no copy of the entity's body. The resolver
-- reads the target's read side later, so a pin to an object the caller may no longer read simply
-- renders as unavailable — the reference discloses nothing on its own.
--
-- Every row is **private to one member in one studio**: `organization_id` scopes the tenant and
-- `membership_id` the owner (the membership identity the roster uses, per the x255/x256/x271
-- self-feature precedent), so every read, the pin and the unpin carry both predicates and one member
-- never sees another's pins even inside the same studio. A pin id that names another member's row or
-- another studio's row resolves to nothing — the service answers 404 on DELETE, never a leak that
-- the row exists.
--
-- ## Idempotence and the unique key
--
-- A pin is identified for the member by (object_type, object_id): pinning the same entity twice is a
-- no-op, not a duplicate row, so `uq_search_pins_member_target (organization_id, membership_id,
-- object_type, object_id)` is the idempotence guard the PUT relies on (INSERT … ON DUPLICATE KEY
-- refreshes the label). DELETE is idempotent too — unpinning an absent pin is a 204.
--
-- ## Grants and immutability
--
-- The runtime credential is granted INSERT and DELETE and **no UPDATE**: a pin is created (or its
-- label refreshed via ON DUPLICATE KEY, which the INSERT privilege covers) and removed. The label
-- refresh is the only mutation and it rides the INSERT, so no standalone UPDATE privilege is granted
-- and the withheld privilege keeps identity (`organization_id`/`membership_id`/`object_type`/
-- `object_id`) fixed — the `saved_context`/`home_pinned_items` posture, no immutability trigger and
-- none needed. Reading is the database-wide SELECT.

CREATE TABLE search_pins (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The owner, named by their membership row (the identity the roster and the other self-features
  -- use), kept inside the tenant by the composite FK to memberships (organization_id, id).
  membership_id   CHAR(36)     NOT NULL,
  -- The pinned entity's kind, from the fixed indexed-entity allowlist the application enforces
  -- ('work_item' | 'document' | 'meeting' | 'project'). VARCHAR(64) matches `search_index.object_type`
  -- / `audit_events.object_type`; an off-allowlist value is refused with a 400 before any write.
  object_type     VARCHAR(64)  NOT NULL,
  -- The pinned entity's id. A bare reference — the resolver reads the target's read side later, so a
  -- pin to a non-readable object renders as unavailable rather than leaking the entity.
  object_id       CHAR(36)     NOT NULL,
  -- A short display label the client caches for the quick-access strip. The row holds no other copy
  -- of the entity; VARCHAR(300) matches the title columns search ranges over.
  label           VARCHAR(300) NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries (25-AUTH §6), so a future child
  -- can reference this row without a cross-tenant path and the isolation corpus is satisfied.
  UNIQUE KEY uq_search_pins_org_id (organization_id, id),
  -- One member's pin of one entity is unique: the idempotence guard the PUT relies on (a repeat pin
  -- refreshes the label rather than adding a row). Leads with `organization_id` per 07-DATA-MODEL §9.
  UNIQUE KEY uq_search_pins_member_target (organization_id, membership_id, object_type, object_id),
  -- The listing index: one member's pins, newest first. Leads with `organization_id`, then
  -- `membership_id` (the equality predicate), then `created_at` and `id` (the order).
  KEY ix_search_pins_org_member (organization_id, membership_id, created_at, id),
  CONSTRAINT fk_search_pins_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_search_pins_member
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
