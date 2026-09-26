-- 0059_onboarding_progress — ON-10 guided tour progress: track a member's completion of a fixed
-- set of tour steps (x155).
--
-- Governing sources: 38-MODULE-MAP §Onboarding (ON-10 "sample / guided tour"),
-- 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX §Onboarding, 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC §5-6
-- (scoped writes, composite (organization_id, id) foreign keys), 07-DATA-MODEL §9 (every composite
-- index begins with organization_id), ADR-0001 (MySQL has no row-level security; layers 3-5 replace
-- it).
--
-- ## Migration numbering
--
-- Numbered 0059 as reserved by NEXT-SCOPES-12 (pass-20 reserves 0042…0059 in id order; ON-10 is the
-- last, 0059). The highest migration on this slice's base is lower — the sibling pass-20 branches
-- (0053…0058) land on master separately. The migrator applies files in ascending numeric order and
-- a gap is legitimate (the migrator treats versions as a set, not positions), so 0059 on this base
-- is correct; the integrator renumbers only if a collision appears after the merges.
--
-- ## What this is, and what it is not
--
-- One row per (membership, step) the member has completed: the progress of an acting user through
-- ON-10's fixed guided tour. The step set is a closed ENUM the application also validates against
-- (`onboarding-tour.steps.ts`); a value outside it is a write error at the engine as well as a 400
-- in the route, so an unknown step can never be stored. Sample-data seeding and dismissable
-- coach-marks are deferred (NS-13): this table stores completion progress only, nothing about the
-- content of a tour step.
--
-- ## Progress is per membership, own-scoped, and idempotent
--
-- A row belongs to exactly one membership in one tenant. The only write is the completion upsert:
-- re-completing a step the member already finished is a no-op at the engine (the unique key turns a
-- second insert into a conflict the repository swallows), never a duplicate row. There is no update
-- of a stored row's identity and no delete path, so `onboarding_progress` carries INSERT alone in
-- scripts/db/users.sql — the withheld privileges are the control, no immutability trigger needed. A
-- member reads and writes only their own progress: every read and the upsert are scoped by
-- membership_id = the acting context's membership, so one member never sees or advances another's
-- tour even inside the same tenant.

CREATE TABLE onboarding_progress (
  id                CHAR(36)                               NOT NULL,
  organization_id   CHAR(36)                               NOT NULL,
  -- The membership whose tour progress this row records. Progress is private to it: the list and the
  -- completion upsert are both scoped by membership_id = the acting context's membership, so one
  -- member never sees or advances another's tour even inside the same tenant. The composite FK below
  -- binds it to a membership of this same tenant.
  membership_id     CHAR(36)                               NOT NULL,
  -- Which fixed tour step this row marks complete. An ENUM rather than a free string so a typo is a
  -- write error, and so the closed step set ON-10 names is the only thing storable. Kept in lockstep
  -- with `onboarding-tour.steps.ts`, which the route validates against (unknown step → 400, no row).
  step              ENUM(
                      'welcome',
                      'create_project',
                      'invite_team',
                      'explore_work',
                      'share_portal'
                    )                                      NOT NULL,
  completed_at      DATETIME(3)                            NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The composite key every tenant-owned table carries, the target of the composite FKs that bind
  -- child rows within one tenant.
  UNIQUE KEY uq_onboarding_progress_org_id (organization_id, id),
  -- Idempotency guard turned conflict: the same membership completing the same step twice collides
  -- here rather than creating a second row. step is part of the key so a member can complete each of
  -- the fixed steps exactly once.
  UNIQUE KEY uq_onboarding_progress_step (organization_id, membership_id, step),
  -- 07-DATA-MODEL §9: the one read that exists — a membership's completed steps, in completion order,
  -- id breaking ties for a total order.
  KEY ix_onboarding_progress_org_membership (organization_id, membership_id, completed_at, id),
  CONSTRAINT fk_onboarding_progress_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
