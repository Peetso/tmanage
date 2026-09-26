-- 0050_home_pinned_items — HOME-05 follow-up: pin work/projects/documents to Home (x144).
--
-- Governing sources: 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX.md §Home HOME-05 ("Saved/pinned"),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md §5-6 (scoped writes, composite (organization_id,
-- id) foreign keys), 07-DATA-MODEL.md §9 (every composite index begins with organization_id),
-- ADR-0001 (MySQL has no row-level security; layers 3-5 replace it).
--
-- ## Migration numbering
--
-- Numbered 0050 as reserved by NEXT-SCOPES-12 (pass-20 reserves 0042…0059 in id order). The highest
-- migration on this slice's base is lower — the pass-19 branches (0042…0049) land on master from
-- sibling branches not yet integrated here. The migrator applies files in ascending numeric order
-- and a gap is legitimate (migrator.db.test treats versions as a set, not positions), so 0050 on
-- this base is correct; the integrator renumbers only if a collision appears after the merges.
--
-- ## What this is, and how it differs from saved_context (0035)
--
-- This is the HOME-05 *follow-up* the audit named: a second, deliberately simpler pin surface keyed
-- by **membership**, not user, and pinning the three coarse Home targets — a work item, a project,
-- or a document. `saved_context` (0035) is the older per-user pin over four fine entity kinds
-- grouped by project; this table is its membership-scoped sibling and shares nothing with it. One
-- row per pin: a reference an acting membership chose to keep on their Home. It stores the reference
-- (target_kind + target_id) only, never a copy of the target's title or content — resolving a pin to
-- a live title/preview is the deferred read fan-out (NEXT-SCOPES-13).
--
-- ## target_id carries NO foreign key, deliberately
--
-- The table target_id points at depends on target_kind (work_items, projects, documents), so a
-- single FK cannot express it — the same reason file_assets.object_id (0016) and saved_context.
-- entity_id (0035) carry none. Tenant safety does not rest on an FK here: the service resolves
-- target_id tenant-scoped BEFORE the write, so a missing or cross-tenant id is a 404 with no row
-- written, never a stored dangling reference.
--
-- ## Pins are per membership, and are created and removed, never edited
--
-- A pin belongs to exactly one membership in one tenant. The only writes are INSERT (pin) and
-- DELETE (unpin): there is no UPDATE path in the repository, no UPDATE grant in scripts/db/
-- users.sql, so the withheld privilege is the control and no immutability trigger is needed.
-- uq_home_pinned_items_pin makes a duplicate pin a collision at the engine — the service turns it
-- into a 409 — rather than a second row.

CREATE TABLE home_pinned_items (
  id                CHAR(36)                               NOT NULL,
  organization_id   CHAR(36)                               NOT NULL,
  -- The membership whose pinned set this row belongs to. A pin is private to it: the list and the
  -- unpin are both scoped by membership_id = the acting context's membership, so one member never
  -- sees or removes another's pins even inside the same tenant. The composite FK below binds it to
  -- a membership of this same tenant.
  membership_id     CHAR(36)                               NOT NULL,
  -- Which kind of Home target the reference points at. An ENUM rather than a free string so a typo
  -- is a write error, and so the three kinds HOME-05's follow-up names are the only ones storable.
  target_kind       ENUM('work','project','document')      NOT NULL,
  -- The referenced target. No FK (see the header): the target table depends on target_kind.
  target_id         CHAR(36)                               NOT NULL,
  created_at        DATETIME(3)                            NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The composite key every tenant-owned table carries, the target of the composite FKs that bind
  -- child rows within one tenant.
  UNIQUE KEY uq_home_pinned_items_org_id (organization_id, id),
  -- Idempotency guard turned conflict: the same membership pinning the same target twice collides
  -- here rather than creating a second row. target_kind is part of the key so two kinds never share
  -- an id space by accident.
  UNIQUE KEY uq_home_pinned_items_pin (organization_id, membership_id, target_kind, target_id),
  -- 07-DATA-MODEL §9: the one read that exists — a membership's pins, newest first, id breaking ties
  -- for a total order.
  KEY ix_home_pinned_items_org_membership (organization_id, membership_id, created_at, id),
  CONSTRAINT fk_home_pinned_items_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
