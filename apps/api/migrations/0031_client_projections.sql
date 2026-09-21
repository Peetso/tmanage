-- 0031_client_projections — the immutable client-safe projection of a published version (x97).
--
-- Governing sources: 09-MVP-PRD.md §FR-05 ("Reviewer sees the governed/published version"),
-- 12-PERMISSION-MATRIX.md §1 ("Publish to client" / "View client projection", and the allowlisted
-- client fields), 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md §4 (the `deliverable.publish` and
-- `client_projection.read` capabilities) and §7 (the client-safe projection pattern: "publishing is
-- an internal capability that transactionally creates an immutable client-safe version"),
-- 07-DATA-MODEL.md §9 (every composite index begins with organization_id). Audit #9. Builds on the
-- deliverable_versions / approvals heart of 0027 (x92).
--
-- ## What this table is
--
-- A `client_projections` row is the immutable client-facing view of one governed
-- `deliverable_versions` row. §7 is explicit that a client never reads the internal record and
-- never writes projection JSON: an internal `deliverable.publish` freezes the governed version's
-- exact `content_hash` together with a client-safe payload carrying only the allowlisted fields
-- (12-PERMISSION-MATRIX §1: public/client title, summary, milestone state, committed/forecast date,
-- published risk, deliverable version, decision, approved contacts — and never internal cost,
-- estimates, staff review, private threads, risk rationale, security metadata or other-client
-- data). The forbidden fields are excluded by construction at the service, never fetched here.
--
-- ## Append-only, one projection per governed version
--
-- Publishing is a one-way act. A version is projected exactly once: the UNIQUE
-- (organization_id, deliverable_version_id) makes a second publish of the same version a
-- duplicate-key error the service maps to 409, so "re-publish of an already-projected version is
-- refused" holds at the engine, not only in application code. Every column is identity — the
-- tenant, the project, the deliverable, the bound version, the frozen hash, the payload, and who
-- published it and when — so there is nothing to UPDATE: the BEFORE UPDATE trigger refuses any
-- change outright, the same defence-in-depth the immutability triggers on deliverable_versions and
-- audit_events give (ADR-0001 layers 3 and 4 are application-side; a direct SQL session bypasses
-- both). The runtime credential is granted INSERT only (scripts/db/users.sql): no UPDATE, no DELETE.

CREATE TABLE client_projections (
  id                        CHAR(36)     NOT NULL,
  organization_id           CHAR(36)     NOT NULL,
  -- Tenant-scoped by project (acceptance 1). The composite FK below makes a cross-tenant project
  -- reference structurally impossible.
  project_id                CHAR(36)     NOT NULL,
  -- The logical deliverable this projects. Denormalised from the bound version, as on `approvals`,
  -- so a deliverable's projections list newest-first without a join back through the version.
  deliverable_id            CHAR(36)     NOT NULL,
  -- The exact governed version this froze. The composite FK binds it within the same tenant.
  deliverable_version_id    CHAR(36)     NOT NULL,
  -- The frozen identity of the published bytes — the governed version's own lowercase hex SHA-256
  -- digest (content-hash.ts), captured at publish time and never re-derived.
  content_hash              CHAR(64)     NOT NULL,
  -- The client-safe payload: only the allowlisted fields of 12-PERMISSION-MATRIX §1. Structured
  -- content is allowed as JSON (25 §5); nothing that decides ownership, permissions or state lives
  -- here — those are the typed columns above. The service builds this from an allowlist, so a
  -- forbidden field can never reach it.
  projection                JSON         NOT NULL,
  published_by_user_id      CHAR(36)     NOT NULL,
  published_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_client_projections_org_id (organization_id, id),
  -- Append-only: one projection per governed version. A second publish of the same version is a
  -- duplicate-key error (acceptance 2), not a silent overwrite.
  UNIQUE KEY uq_client_projections_org_version (organization_id, deliverable_version_id),
  -- 07-DATA-MODEL §9: a deliverable's projections, newest-first.
  KEY ix_client_projections_org_deliverable
    (organization_id, deliverable_id, published_at),
  CONSTRAINT fk_client_projections_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  -- The version is bound within the same tenant: the composite target is
  -- deliverable_versions (organization_id, id).
  CONSTRAINT fk_client_projections_version_tenant
    FOREIGN KEY (organization_id, deliverable_version_id)
    REFERENCES deliverable_versions (organization_id, id),
  CONSTRAINT fk_client_projections_published_by
    FOREIGN KEY (published_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

-- A client projection is immutable in full. Every column is identity-defining — re-pointing the
-- version, editing the frozen hash, or rewriting the client-safe payload would silently change
-- what a client was shown after the fact. There is no legitimate UPDATE, so the trigger refuses
-- all of them; §FR-05's "changed governed content creates new version" is a new deliverable
-- version and a new projection, never an edit of this row.
CREATE TRIGGER trg_client_projections_immutable
BEFORE UPDATE ON client_projections FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'client_projections rows are immutable';
END$$

DELIMITER ;
