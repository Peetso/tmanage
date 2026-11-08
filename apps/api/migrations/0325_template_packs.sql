-- 0325_template_packs — which built-in template packs a workspace has installed (54-22).
--
-- ## What this migration is for
--
-- The Templates screen shows a gallery of template packs: each pack is a bundle of project
-- templates, docs and automations. The packs themselves are built into the code
-- (`projects/template-packs.catalog.ts`), so no pack content is stored here and no live data
-- changes. Installing a pack copies its project templates into `project_templates` (0106) and
-- writes one `template_packs` row, so the gallery can show the pack as installed and a second
-- install of the same pack is refused.
--
-- - `pack_key` is the catalog key of the pack (`agency-client-launch`, ...).
-- - `templates_created` is how many templates the install added (a template whose name was
--   already in use in the workspace is skipped, not overwritten).
-- - `installed_by` / `installed_at` record who installed it and when.
--
-- TENANT: keyed `(organization_id, id)`; `(organization_id, pack_key)` is unique, which is the
-- backstop for two installs racing each other.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATETIME(3), no generated columns, no CHECK, no functional or partial indexes,
-- utf8mb4_unicode_ci. Additive only: one new table.

CREATE TABLE template_packs (
  id                     CHAR(36)      NOT NULL,
  organization_id        CHAR(36)      NOT NULL,
  pack_key               VARCHAR(64)   NOT NULL,
  templates_created      INT UNSIGNED  NOT NULL DEFAULT 0,
  installed_by           CHAR(36)      NOT NULL,
  installed_at           DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_template_packs_org_id (organization_id, id),
  UNIQUE KEY uq_template_packs_org_pack (organization_id, pack_key)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
