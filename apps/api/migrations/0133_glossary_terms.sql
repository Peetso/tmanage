-- 0133_glossary_terms — an org glossary of terms and their definitions (module Docs, DOC hub
-- "…decision register, glossary", GLOSSARY, x263).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Docs and knowledge" (the decision
-- register and glossary the DOC hub lists); 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC §5-6 (scoped
-- writes, the (organization_id, id) composite key); 07-DATA-MODEL §9 (every composite index begins
-- with organization_id); ADR-0001 (MySQL has no row-level security; layers 3-5 replace it).
--
-- ## What this migration is for
--
-- The Docs hub names a glossary alongside the decision register; there was no table for it on master
-- (verified). A `glossary_terms` row is the fact "in this studio, this term means this". A member
-- with the doc-authoring capability adds a term, edits its definition, or removes it; any member who
-- may read docs searches and reads the glossary. The glossary is org-wide, not per-membership or
-- per-document — a shared vocabulary the whole studio sees.
--
-- ## Migration number
--
-- The pass-24 queue map reserves 0133 for x263. The migrator applies files in ascending numeric
-- order and a gap is not an error (it rejects only a NEW file numbered below an applied one), so
-- 0133 on top of this slice's base is correct; if the integration renumbers the reservations, the
-- integrator renumbers this file with them.
--
-- ## Terms are unique per studio, case-insensitively
--
-- `uq_glossary_terms_org_term` makes a repeated term within one organization a collision at the
-- engine. The column collation is utf8mb4_unicode_ci, so "API" and "api" collide as one term — the
-- service treats that collision as a 409 conflict and inserts nothing. The term and definition are
-- editable (PATCH) and the row is removable (DELETE); only the tenant is immutable, pinned by the
-- BEFORE UPDATE trigger below (the reason every identity trigger in this schema exists).
--
-- ## Tenant-scoped, and a term belongs to exactly one studio
--
-- `organization_id` is NOT NULL and carries the `(organization_id, id)` key every tenant-scoped
-- table holds; the composite FK binds it to `organizations (id)`. An unscoped
-- `SELECT ... FROM glossary_terms` would be every studio's glossary on the server, so the query
-- guard's TENANT_TABLES scopes its reads and writes.

CREATE TABLE glossary_terms (
  id                CHAR(36)      NOT NULL,
  organization_id   CHAR(36)      NOT NULL,
  -- The term itself. VARCHAR under a case-insensitive collation so a duplicate in any case collides
  -- on uq_glossary_terms_org_term. The application also refuses an empty or over-length term (400)
  -- before the write; the column ceiling is the backstop.
  term              VARCHAR(190)  NOT NULL,
  -- What the term means in this studio. TEXT: a definition is a short paragraph, not a document. The
  -- application refuses an empty or over-length definition (400) before the write.
  definition        TEXT          NOT NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                  ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries.
  UNIQUE KEY uq_glossary_terms_org_id (organization_id, id),
  -- One term per studio, case-insensitively (the column's ci collation). A duplicate add collides
  -- here rather than creating a second row; the service maps the collision to 409. Leads with
  -- organization_id per 07-DATA-MODEL §9.
  UNIQUE KEY uq_glossary_terms_org_term (organization_id, term),
  -- 07-DATA-MODEL §9: the read that exists — a studio's terms in alphabetical order, id breaking ties
  -- for a total order. Also serves the prefix search (term LIKE 'q%') the list route takes.
  KEY ix_glossary_terms_org_term (organization_id, term, id),
  CONSTRAINT fk_glossary_terms_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A row's tenant is what it is and is immutable; only the term, definition, and updated_at change.
-- The trigger holds identity at the engine, the reason every other identity trigger in this schema
-- exists.
DELIMITER $$

CREATE TRIGGER trg_glossary_terms_immutable
BEFORE UPDATE ON glossary_terms FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'glossary_terms.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
