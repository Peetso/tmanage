-- 0412_work_item_assignees_single_source — work area plan (2026-11-23), owner ask "several
-- workers per work: make work_item_assignees the single source".
--
-- Until now an item with no doer rows read its owner (`work_items.owner_user_id`) as its only
-- doer (0318's "no rows means the owner is the only doer"), so who does a task lived in two
-- places and every reader had to remember both. From this migration on every owned item has a
-- doer row for its owner, and the application keeps it so: `WorkItemsRepository.create`,
-- `update`, `transitionState` and `clearOwnerForUser` write the rows in the same transaction as
-- the owner. `owner_user_id` stays as the denormalised lead doer (the first doer row) that
-- 40-odd readers sort and filter by (expand only, DA-6: nothing is dropped).
--
-- The back-fill: one `doer` row for each item whose owner is a member of the item's
-- organization and has no doer row yet. `created_at` is the item's own creation time, so the
-- owner sorts first ("lead first" is oldest first) ahead of any doer row added later. Items
-- whose owner is not a member (an id the membership FK would refuse) are left as they are; the
-- readers' owner fallback still shows them. Re-running inserts nothing (NOT EXISTS, DA-8).
--
-- MariaDB-safe (Hostinger): a plain INSERT ... SELECT, no generated column, no CHECK, no
-- functional index, no IF NOT EXISTS. Grants unchanged (the API already inserts here, users.sql).

INSERT INTO work_item_assignees (organization_id, work_item_id, membership_id, role, created_at)
SELECT wi.organization_id, wi.id, m.id, 'doer', wi.created_at
FROM work_items wi
INNER JOIN memberships m
  ON m.organization_id = wi.organization_id
  AND m.user_id = wi.owner_user_id
WHERE wi.owner_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM work_item_assignees x
    WHERE x.organization_id = wi.organization_id
      AND x.work_item_id = wi.id
      AND x.membership_id = m.id
      AND x.role = 'doer'
  );
