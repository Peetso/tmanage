-- 0091_meeting_occurrence_overrides — per-occurrence overrides of a recurring meeting series
-- (CAL per-occurrence override, x213).
--
-- Governing sources: 38-MODULE-MAP §Calendar & meetings (per-occurrence override deferred by
-- NEXT-SCOPES-12, taken up here); 07-DATA-MODEL §9 (every composite index begins with
-- organization_id); 0043_meeting_series.sql (the parent series this table decorates).
--
-- ## Migration numbering
--
-- Numbered 0091 as reserved by NEXT-SCOPES-14 (pass 22). The number is a set member, not a
-- position (migrator.db.test treats gaps as legitimate); the integrator renumbers only on a
-- collision after the parallel pass-22 merges.
--
-- ## What this table is
--
-- One row per **overridden occurrence** of a recurring series (0043). A series is a *rule* whose
-- occurrences are expanded on read in a bounded window and never materialised; this table records
-- the exceptions to that rule for one occurrence date:
--
--   · a `cancelled` occurrence — the series' expansion drops that date;
--   · a `moved` occurrence — the expansion replaces the original date with `new_date` (and may carry
--     an optional `new_start_time` and `new_title`).
--
-- The override is keyed by the *original* occurrence date (`occurrence_date`), the date the rule
-- itself falls on, so the merge that applies overrides over the base expansion is deterministic:
-- exactly one override per (series, original date), enforced by the unique key below. There is one
-- override per occurrence date, so `POST` upserts (INSERT or UPDATE) and `DELETE` removes it,
-- restoring the base rule for that date.
--
-- ## Tenant scope and the composite foreign key
--
-- Org-scoped like its parent — a series names no project. `(organization_id, id)` is unique so a
-- future child could bind to the same tenant, and the foreign key onto the series is the *composite*
-- (organization_id, series_id) → meeting_series (organization_id, id), so an override can never name
-- a series in another tenant (ADR-0001 layer 1). A cross-tenant series id therefore cannot be
-- referenced even by a caller who forged one; the runtime never reaches this because the service
-- resolves the series tenant-scoped first (404).
--
-- ## status is an ENUM; the moved fields are nullable and the service enforces their coherence
--
-- `status` is a closed two-value vocabulary the application owns, so an ENUM rather than a free
-- string. `new_date`, `new_start_time` and `new_title` are meaningful only for a `moved` override and
-- are NULL for a `cancelled` one; that coherence (a cancelled row carries no move fields, a moved row
-- carries a new_date) is enforced in the service where the message can be a helpful 400, not by a
-- CHECK that would answer a bare constraint error.

CREATE TABLE meeting_occurrence_overrides (
  id                   CHAR(36)                          NOT NULL,
  organization_id      CHAR(36)                          NOT NULL,
  -- The series this override decorates. Bound to the same tenant by the composite FK below.
  series_id            CHAR(36)                          NOT NULL,
  -- The ORIGINAL occurrence date the rule falls on, the override's key. A calendar date carried as
  -- 'YYYY-MM-DD' (the 0012 DATE convention), never an instant.
  occurrence_date      DATE                              NOT NULL,
  -- What happens to that occurrence. ENUM so the two kinds are the only ones storable.
  status               ENUM('moved','cancelled')         NOT NULL,
  -- For a `moved` override: the new calendar date, and optionally a new time-of-day and title. All
  -- NULL for a `cancelled` override (the service enforces this).
  new_date             DATE                              NULL,
  new_start_time       TIME                              NULL,
  -- `meeting_series.title` is VARCHAR(300); an overridden title is the same kind of short handle.
  new_title            VARCHAR(300)                      NULL,
  created_by_user_id   CHAR(36)                          NOT NULL,
  created_at           DATETIME(3)                       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- POST upserts an existing override in place, so this row is edited, unlike its parent series.
  updated_at           DATETIME(3)                       NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                                         ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries.
  UNIQUE KEY uq_meeting_occurrence_overrides_org_id (organization_id, id),
  -- One override per (series, original occurrence date): the upsert target and the merge invariant.
  UNIQUE KEY uq_meeting_occurrence_overrides_series_date
    (organization_id, series_id, occurrence_date),
  -- 07-DATA-MODEL §9: the read that exists — a series' overrides, to merge over its expansion.
  KEY ix_meeting_occurrence_overrides_org_series (organization_id, series_id),
  CONSTRAINT fk_meeting_occurrence_overrides_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The composite tenant-bound reference onto the parent series (ADR-0001 layer 1): an override can
  -- never name a series in another tenant.
  CONSTRAINT fk_meeting_occurrence_overrides_series
    FOREIGN KEY (organization_id, series_id) REFERENCES meeting_series (organization_id, id),
  -- The actor. References users (id) without organization_id because a user is not tenant-owned —
  -- the shape meeting_series.created_by_user_id uses (fk_meeting_series_creator).
  CONSTRAINT fk_meeting_occurrence_overrides_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
