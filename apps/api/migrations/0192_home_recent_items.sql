-- 0192_home_recent_items — a member's own recently-viewed entities (module HOME / My Day, x324).
--
-- Governing sources: 38-MODULE-MAP §Home / My Day (recents rail); 22-SCREEN §Home; 25-AUTHORIZATION-
-- AND-TENANT-ISOLATION §6 (composite tenant keys, scoped writes); 07-DATA-MODEL §9 (every composite
-- index prefix begins with organization_id); ADR-0001 (MySQL has no row-level security; the
-- application layers replace it, and the withheld privilege is a control).
--
-- ## What this migration is for
--
-- The Home "Recently viewed" rail: as a member opens an entity the client records a view, and Home
-- shows that member their most-recently-viewed references, newest first. One `home_recent_items` row
-- is the fact "this membership last viewed this object at this instant". It stores the *reference*
-- only (`object_type` + `object_id`), never a copy of the target and no resolved title, so a recent
-- row can leak nothing about an entity the caller could not otherwise see (reference-only, the
-- `home_pinned_items` target_id posture, 0050). The read is bounded to a fixed cap, so a member's
-- recents can never be an unbounded scan (the x93/x102 unbounded-read precedent).
--
-- ## An object reference is `object_type` + `object_id`, not a foreign key
--
-- `object_type` is one of a fixed allowlist and `object_id` names a row in a different table per
-- type, so `object_id` carries no foreign key. Tenant safety is not an FK on the target: it is that
-- every read and the upsert are scoped by `organization_id = context` (the layer-3 tenant guard
-- registers this table), the object reference is stored verbatim, and no title is resolved
-- server-side — so the rail can never disclose an entity in, or a reference owned by, another studio.
-- An `object_type` off the allowlist is refused at the route with a 400 and no upsert.
--
-- ## Recents are per membership, keyed for upsert, identity immutable
--
-- A row is one membership's last view of one object in one studio, keyed `(organization_id,
-- membership_id, object_type, object_id)`. It is keyed to `membership_id`, not the global `user_id`:
-- a recent is scoped to who the caller is *in this studio* and never leaves the tenant, and the
-- composite foreign key binds the row to a membership of this same organization. The write is one
-- `INSERT ... ON DUPLICATE KEY UPDATE viewed_at` against that unique key, so re-viewing the same
-- object refreshes the time in place rather than creating a second row (idempotent PUT). Recents are
-- private to a membership — every read and the upsert are scoped by `membership_id`. A row's tenant,
-- membership, type and id are what it *is* and are immutable; only `viewed_at` changes, and the
-- BEFORE UPDATE trigger pins identity at the engine (ADR-0001 layers 3 and 4 are application-side and
-- a direct SQL session bypasses both). This slice grants the app INSERT, UPDATE (the upsert), DELETE
-- and SELECT.

CREATE TABLE home_recent_items (
  id              CHAR(36)      NOT NULL,
  organization_id CHAR(36)      NOT NULL,
  -- The membership whose recents this row holds. Private to it: the read and the upsert are scoped by
  -- membership_id = the acting context's membership, so one member never sees or moves another's
  -- recents even inside the same tenant. The composite FK below binds it to a membership of this same
  -- organization.
  membership_id   CHAR(36)      NOT NULL,
  -- The kind of object viewed, off a fixed allowlist the API validates against before any write. No
  -- foreign key: the object lives in a different table per type, so the tenant boundary is the scoped
  -- read/write here, not an FK (the home_pinned_items target_id posture). An off-allowlist value is a
  -- 400 at the route with no row.
  object_type     VARCHAR(40)   NOT NULL,
  -- The viewed object's id, stored verbatim as a reference. No FK, no title resolved server-side, so
  -- a recent row discloses nothing about the target beyond the reference the caller already supplied.
  object_id       CHAR(36)      NOT NULL,
  -- The instant the caller last viewed the object. Set from a bound Date at the write, never the
  -- database clock, so the admin connection's CURRENT_TIMESTAMP can never leak into the ordering. The
  -- rail reads newest-first by this column.
  viewed_at       DATETIME(3)   NOT NULL,
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, the target of the composite FKs
  -- that bind child rows within one tenant (and the isolation corpus requires it).
  UNIQUE KEY uq_home_recent_items_org_id (organization_id, id),
  -- One row per member per object per studio. This is the upsert key: the service writes
  -- `INSERT ... ON DUPLICATE KEY UPDATE viewed_at` against it, so a second view of the same object
  -- refreshes the time in place. Leads with organization_id per 07-DATA-MODEL §9.
  UNIQUE KEY uq_home_recent_items_object (organization_id, membership_id, object_type, object_id),
  -- 07-DATA-MODEL §9: the one read that exists — a membership's recents, newest first then id for a
  -- total, deterministic order under the fixed cap.
  KEY ix_home_recent_items_org_membership (organization_id, membership_id, viewed_at, id),
  CONSTRAINT fk_home_recent_items_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The membership, bound within its own tenant: the composite key refuses a membership id from
  -- outside this row's organization, so a recent can never cite a membership in another studio.
  CONSTRAINT fk_home_recent_items_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A row's tenant, membership, object type and object id are what it is and are immutable; only
-- viewed_at changes. The trigger holds identity at the engine, the reason every other identity
-- trigger in this schema exists.
DELIMITER $$

CREATE TRIGGER trg_home_recent_items_immutable
BEFORE UPDATE ON home_recent_items FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'home_recent_items.organization_id is immutable';
  END IF;
  IF NEW.membership_id <> OLD.membership_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'home_recent_items.membership_id is immutable';
  END IF;
  IF NEW.object_type <> OLD.object_type THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'home_recent_items.object_type is immutable';
  END IF;
  IF NEW.object_id <> OLD.object_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'home_recent_items.object_id is immutable';
  END IF;
END$$

DELIMITER ;
