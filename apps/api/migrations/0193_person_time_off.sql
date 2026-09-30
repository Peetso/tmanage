-- 0193_person_time_off — module 14 People & capacity: dated time-off entries for a person (x325).
--
-- Governing sources: 38-MODULE-MAP §People & capacity (time off / PTO); 22-SCREEN §Person detail;
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC §5-6 (scoped writes, composite (organization_id, …)
-- foreign keys); 07-DATA-MODEL §9 (every composite index prefix begins with organization_id);
-- ADR-0001 (MySQL has no row-level security; the application layers replace it, and the withheld
-- privilege is a control).
--
-- ## Why this table exists
--
-- The People module records a member's weekly capacity (0070), their per-day quiet hours, and their
-- recurring weekly availability (`member_availability`, 0096, x218). None of those record a discrete,
-- dated *absence* a manager files against a person for capacity context — "away 2026-10-01..05,
-- vacation". This table is that store: one row is the fact "this person is off between `starts_on`
-- and `ends_on`, of `kind`, in this studio". Stored records only — there is no approval workflow and
-- no dispatch; a manager files an entry and later removes it.
--
-- ## Distinct from member_availability (0096)
--
-- `member_availability` is a member managing *their own* recurring out-of-office windows behind
-- `work.read`. This is a *manager* filing dated absences *for another person* behind `org.manage`,
-- keyed by the person's `(organization_id, person_user_id)` — the `member_profiles` (0094) posture,
-- resolved membership -> (organization_id, user_id) before any write — not by the acting membership.
--
-- ## Keyed by (organization_id, person_user_id); created and removed, never edited
--
-- The person is bound to a membership of THIS tenant by the composite FK below, so an entry can never
-- be filed for a non-member or a cross-tenant user; the route resolves the membership by
-- (organization_id, :userId) first, so an unknown or cross-tenant person is a 404 with no write. An
-- entry is added (INSERT) and removed (DELETE), never edited — so the runtime credential is granted
-- INSERT and DELETE and no UPDATE (scripts/db/users.sql), and the withheld privilege is the control
-- (the `focus_blocks` 0125 posture; no immutability trigger, none needed). `kind` is a small fixed
-- vocabulary validated by the application (vacation, sick, other); the application refuses
-- `ends_on < starts_on` (400, no insert) comparing bound Date values, never the database clock.

CREATE TABLE person_time_off (
  id               CHAR(36)      NOT NULL,
  organization_id  CHAR(36)      NOT NULL,
  -- The person this absence is filed against. Bound to a membership of THIS tenant by the composite
  -- FK below; the pair (organization_id, person_user_id) is resolved from the membership before the
  -- write, so an entry can never be stored for a non-member or a cross-tenant user.
  person_user_id   CHAR(36)      NOT NULL,
  -- The absence bounds, inclusive. The application refuses ends_on < starts_on (400) using bound Date
  -- values, never the admin connection's CURRENT_TIMESTAMP (the admin-pool-clock trap).
  starts_on        DATE          NOT NULL,
  ends_on          DATE          NOT NULL,
  -- Why the person is away (vacation, sick, other). A VARCHAR validated against the fixed application
  -- allowlist — an unknown kind is a 400 with no write — not an ENUM, so the vocabulary can grow in a
  -- later slice without an ALTER, the posture member_availability.kind and other small vocabularies use.
  kind             VARCHAR(20)   NOT NULL,
  note             VARCHAR(500)  NULL,
  -- The acting user who filed the entry (global users row, like every other created_by_user_id).
  created_by_user_id CHAR(36)    NOT NULL,
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries.
  UNIQUE KEY uq_person_time_off_org_id (organization_id, id),
  -- 07-DATA-MODEL §9: the read that exists — a person's entries in this studio, by start then id for a
  -- total, deterministic order; a bounded range GET filters overlap over this same prefix.
  KEY ix_person_time_off_org_person (organization_id, person_user_id, starts_on, id),
  CONSTRAINT fk_person_time_off_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- Tenant-scoped referential integrity: the (organization_id, person_user_id) pair must name a
  -- membership of this same tenant, so an entry can never be filed for a non-member or a cross-tenant
  -- user (the member_profiles composite-FK posture).
  CONSTRAINT fk_person_time_off_member_tenant
    FOREIGN KEY (organization_id, person_user_id) REFERENCES memberships (organization_id, user_id),
  -- The acting user, a global users row like every other created_by_user_id in the schema.
  CONSTRAINT fk_person_time_off_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
