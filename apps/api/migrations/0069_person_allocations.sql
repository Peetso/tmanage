-- 0069_person_allocations — a project's people allocations (PEOPLE / module 14, x171 slice).
--
-- Migration number: 0069, the number pass-21 reserves for x171 (queue header). The migrator applies
-- files in ascending numeric order and a gap is not an error (it rejects only a NEW file numbered
-- *below* an applied one), so 0069 on top of the base's highest (0052 on master bcfe397) is correct.
-- Nothing here depends on the literal 0069 beyond the filename; if integration renumbers, the file is
-- renumbered with it.
--
-- Governing sources: 38-MODULE-MAP §People & capacity (allocation view), 07-DATA-MODEL §9 (index
-- prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant
-- keys), 23-ERD-AND-STATE-MACHINES §2 (`PROJECT ||--o{ …` project-owned records).
--
-- ## What this migration is for
--
-- The People module advertises a capacity/allocation view; there was no table to hold who is
-- allocated to what. This is a person's allocation to a project at rest: which membership, which
-- project, what percentage of their time (1..100), an optional start and end date, and when the row
-- was created. It is deliberately *not* a time-phased capacity model or an actuals ledger — this table
-- carries only what an allocation *is*.
--
-- ## Project-owned and person-owned, tenant-scoped like every sibling
--
-- `project_id` and `membership_id` are both `NOT NULL`. The composite foreign keys
-- `fk_person_allocations_project_tenant` (`(organization_id, project_id)` → `projects`) and
-- `fk_person_allocations_membership_tenant` (`(organization_id, membership_id)` → `memberships`) bind
-- each id to a row of the *same* tenant — a cross-tenant project or membership id does not exist as a
-- pair even when both ids exist individually, so an allocation can only ever name a project and a
-- member of its own studio.
--
-- ## Percentage is bounded at the engine too
--
-- `percent` is a `TINYINT UNSIGNED` with a `CHECK (percent BETWEEN 1 AND 100)`. The controller
-- rejects an out-of-range percent with a 400 before the write, but a direct SQL session bypasses the
-- application layers (ADR-0001), so the bound lives here as well. The "one active allocation per
-- (project, membership)" rule is enforced in the controller (409): an active allocation is one whose
-- `end_date IS NULL`, and MySQL treats NULLs as distinct in a UNIQUE index, so the rule is an
-- application invariant rather than a partial unique key.

CREATE TABLE person_allocations (
  id                 CHAR(36)        NOT NULL,
  organization_id    CHAR(36)        NOT NULL,
  -- NOT NULL. An allocation belongs to a project; see the note above.
  project_id         CHAR(36)        NOT NULL,
  -- NOT NULL. The membership (a person in this studio) being allocated.
  membership_id      CHAR(36)        NOT NULL,
  -- The share of the member's time this allocation represents, 1..100. Bounded by the CHECK below.
  percent            TINYINT UNSIGNED NOT NULL,
  -- Optional calendar dates, carried as 'YYYY-MM-DD' strings (07-DATA-MODEL §Dates): the window the
  -- allocation applies to. NULL start means "already in effect"; NULL end means "ongoing" (active).
  start_date         DATE            NULL,
  end_date           DATE            NULL,
  created_at         DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_person_allocations_org_id (organization_id, id),
  -- The index a project's allocations are listed by: this tenant's allocations for this project, in
  -- creation order. Leads with `organization_id` per 07-DATA-MODEL §9.
  KEY ix_person_allocations_org_project (organization_id, project_id, created_at),
  -- The index the "active allocation for this (project, membership)" lookup uses.
  KEY ix_person_allocations_org_project_member (organization_id, project_id, membership_id),
  CONSTRAINT chk_person_allocations_percent CHECK (percent BETWEEN 1 AND 100),
  CONSTRAINT fk_person_allocations_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_person_allocations_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
