-- 0234_search_recency_indexes — global search reads newest-first without sorting the tenant.
--
-- H2 (L5 load run, PERF-03 near miss): search filters work-item titles and message bodies with
-- `LIKE '%term%'` and orders `updated_at DESC, id ASC` with a small LIMIT. With only the
-- organization prefix indexed, every search scanned and filesorted the tenant's whole table
-- (10,002 work-item rows examined per call at 10k items). These indexes match the predicate prefix
-- and the ORDER BY exactly, so the server walks rows newest-first and stops once LIMIT rows match.
--
-- The substring match itself is unchanged on purpose: a FULLTEXT index matches whole words (a
-- search for "sign" would stop finding "design") and a prefix index only serves `LIKE 'term%'`, so
-- either would change which rows search returns. MariaDB has no n-gram parser to close that gap.
--
-- MariaDB-safe: plain secondary keys. `DESC` key parts are honoured from MariaDB 10.8 and parsed
-- (then ignored, a harmless ascending key) before it. No generated column, no CHECK, no JSON.

ALTER TABLE work_items
  ADD KEY ix_work_items_org_updated (organization_id, updated_at DESC, id);

ALTER TABLE messages
  ADD KEY ix_messages_org_updated (organization_id, updated_at DESC, id);
