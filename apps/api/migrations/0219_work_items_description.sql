-- 0219_work_items_description — a work item's description (A6, Figma fq7-work-item-detail).
--
-- The work item detail shows a Description card above the checklist, and the Edit work item
-- dialog edits it. Until now a work item had a title and nothing longer, so the text had no home.
-- One nullable column on the existing tenant-scoped table: NULL means "no description" (every row
-- before this migration, and every item nobody wrote one for). The route bounds it at 5000
-- characters, so an oversize value is a 400 rather than a store that silently truncates.
-- Plain ADD COLUMN with no default, no CHECK and no generated column: the live host is MariaDB,
-- and this schema keeps to the syntax both engines read the same way.

ALTER TABLE work_items
  ADD COLUMN description TEXT NULL AFTER title;
