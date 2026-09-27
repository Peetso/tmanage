-- 0106_project_templates — FEAT: Reusable project templates (PROJ / module 8, x234).
--
-- Migration number: the pass-23 queue reserves 0106 for x234. The migrator applies files in
-- ascending numeric order and a gap is not an error (it rejects only a NEW file numbered *below* an
-- applied one), so 0106 on top of the base's highest applied migration is correct. If integration
-- renumbers the reservation, the integrator renumbers this file with it; nothing here depends on the
-- literal 0106 beyond the filename.
--
-- Governing sources: 38-MODULE-MAP §Projects & portfolio, 07-DATA-MODEL §9 (index prefixes lead with
-- `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this is, and what it is not
--
-- The portfolio (x206–x209) can run projects but has no way to stamp out a new one from a saved
-- shape. This table holds a **reusable project template**: a `name`, an optional `description`, and a
-- `default_objectives_json` — the objective titles a project made from this template should start
-- with. It is a definition a studio authors once and instantiates many times.
--
-- ## Org-scoped, not project-owned
--
-- Unlike `project_objectives` (0040) or `project_internal_risks` (0088), a template belongs to the
-- **organization**, not to a project — there is no `project_id`. Authorization is therefore org-scoped
-- (`project.manage`), not relation-gated on a project. The tenant key is `(organization_id, id)`, the
-- shape every tenant-scoped table carries so a future child can reference a template without a
-- cross-tenant path.
--
-- ## Name is unique per tenant
--
-- `uq_project_templates_org_name` makes a template name unique within its organization: the create
-- path pre-checks the name inside the transaction and maps a collision to 409, and this key is the
-- backstop for the race the pre-check cannot see. Cross-tenant names never collide — the key leads
-- with `organization_id`.
--
-- ## Immutable this slice
--
-- A template is authored and instantiated; there is no edit route yet. The runtime credential is
-- granted INSERT only on this table (see `scripts/db/users.sql`), so the application cannot amend a
-- template. When an edit slice ships it adds the UPDATE grant with the code that writes it (and a
-- column-pinning trigger for the identity columns), the same posture `incidents` / `changelog_entries`
-- take.

CREATE TABLE project_templates (
  id                       CHAR(36)     NOT NULL,
  organization_id          CHAR(36)     NOT NULL,
  -- `organizations.name` / `projects.name` are VARCHAR(190); a template name is the same kind of
  -- short label, and matching the width keeps the unique key comparable.
  name                     VARCHAR(190) NOT NULL,
  -- Optional prose describing what the template is for. Nullable — a template may be named before its
  -- description is written.
  description              TEXT         NULL,
  -- The objective titles a project made from this template should start with, as a JSON array of
  -- strings. Nullable — a template may declare no default objectives. Validated and bounded in the
  -- application (a bounded array of non-empty strings); the column stores the checked value.
  default_objectives_json  JSON         NULL,
  -- The person who authored the template — the service passes `context.userId`.
  created_by               CHAR(36)     NOT NULL,
  created_at               DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_project_templates_org_id (organization_id, id),
  -- A template name is unique within its organization; the create path maps a collision to 409 and
  -- this is the structural backstop. Leads with `organization_id` per 07-DATA-MODEL §9.
  UNIQUE KEY uq_project_templates_org_name (organization_id, name),
  -- The index the templates are listed by: this tenant's templates, in creation order.
  KEY ix_project_templates_org_created (organization_id, created_at),
  CONSTRAINT fk_project_templates_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
