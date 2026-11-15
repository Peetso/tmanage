-- 0345_deliverable_delete — a deliverable can be deleted, with Undo (FIX6 item 8, live UX test
-- 69836a13 O-P1-9).
--
-- The owner or a project manager deletes a deliverable that was made by mistake. It is a soft
-- delete, like files (0245): the row stays, `deleted_at` hides it from the team's list and from
-- the client portal at once, and Undo (restore) clears it again. A deliverable the client approved
-- is never deleted (the service refuses it), because that approval is a record the agency relies on.
--
-- `deliverables` (TENANT, 0211) gains:
--   - `deleted_at`: when it was deleted; NULL = live;
--   - `deleted_by_user_id`: who deleted it (an id only).
--
-- MariaDB-safe (live is MariaDB 11.8): two plain NULL columns, no default expression, no CHECK.

ALTER TABLE deliverables
  ADD COLUMN deleted_at         DATETIME(3) NULL AFTER updated_at,
  ADD COLUMN deleted_by_user_id CHAR(36)    NULL AFTER deleted_at;
