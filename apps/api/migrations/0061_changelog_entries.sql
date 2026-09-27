-- 0061_changelog_entries — GLOBAL (org-less) product-changelog entries (Public site, module 1, x160).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Public site (changelog / product
-- updates); AUDIT-2026-09-27-whole-project.md rank #1 (Public site Missing — no changelog);
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (this table carries no tenant key and so is registered
-- as a global table, not a tenant one).
--
-- ## Migration number
--
-- Pass 21 reserves 0060–0080 in slice-id order; x160's reservation is 0061 (NEXT-SCOPES-13 header).
-- The highest migration present on this slice's base (master bcfe397) is 0052; 0053–0060 are
-- reserved by sibling branches not yet integrated, so 0061 sits above every reservation. The
-- migrator applies files in ascending numeric order and a gap is not an error (it rejects only a
-- NEW file numbered *below* an applied one), so 0061 on top of 0052 is correct on this base. If the
-- integration renumbers the reservations, the integrator renumbers this file with them; nothing
-- here depends on the literal 0061 beyond the filename.
--
-- ## What this migration is for
--
-- The public marketing site has no changelog: nowhere a prospective or current customer can read
-- what shipped. This is the smallest table that supports one — a flat list of published product
-- updates, each with a version handle, a title, a Markdown body and a category. It is deliberately
-- **global**: a changelog is one public record for the product, not a per-tenant one, so the table
-- carries no `organization_id` and is registered in `NON_TENANT_TABLES` (tenant-guard.ts) rather
-- than `TENANT_TABLES`.
--
-- ## Read-only from the application
--
-- The public `GET /v1/public/site/changelog` route only SELECTs (published rows, newest first).
-- No application write path exists in this slice — entries are authored by a later admin slice — so
-- `scripts/db/users.sql` withholds INSERT/UPDATE/DELETE on this table from `tmanage_app`; the
-- database-wide SELECT grant is all the public read needs. See that file and users-sql.test.ts.

CREATE TABLE changelog_entries (
  id           CHAR(36)     NOT NULL,
  -- The version handle shown beside the entry, e.g. `2026.09` or `v1.4.0`. A short free string,
  -- not parsed — display only.
  version      VARCHAR(100) NOT NULL,
  title        VARCHAR(300) NOT NULL,
  -- The entry body as Markdown source. Rendered by the client; stored whole.
  body_md      TEXT         NOT NULL,
  -- `feature` | `fix` | `security`. VARCHAR with application validation rather than a SQL ENUM, so
  -- a new category is an application change, not a migration — the same choice `work_forms` (0052)
  -- makes for its field types.
  category     VARCHAR(32)  NOT NULL,
  -- Whether the entry is live on the public page. Drafts (`published = 0`) are never returned by
  -- the public read.
  published    TINYINT(1)   NOT NULL DEFAULT 0,
  -- When the entry went live, and the key the public list is ordered by (newest first). NULL for a
  -- draft; the public read requires it non-NULL as well as `published = 1`.
  published_at DATETIME(3)  NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The index the public read walks: published entries in published-at order, id breaking ties.
  KEY ix_changelog_published (published, published_at, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
