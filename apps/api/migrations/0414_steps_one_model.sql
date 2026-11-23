-- 0414_steps_one_model — one model for the steps inside a work (work area plan 2026-11-23,
-- decision D3; lane WA slice W-API-3).
--
-- ## What this migration is for
--
-- Steps existed twice: `work_item_checklist_items` (0051: label, done, position) and
-- `work_item_subtasks` (0175: title, is_done, position). Two tables for one idea is the defect
-- class "duplicate model" (ENGINEERING-RULES, fix the whole class). The checklist is the one the
-- work page shows, so it becomes the single model:
--
-- - `assignee_membership_id` (NULL = nobody) and `due_on` (a calendar day, NULL = none): the owner
--   asked for a to-do list inside a work where a step can have a person and a date.
-- - `source_subtask_id`: the `work_item_subtasks.id` a step was copied from (NULL for every step
--   made as a step). The unique key makes the copy below idempotent (DA-8) and keeps the
--   provenance for the later contract migration, which can check the copy row by row.
--
-- ## Data: every subtask becomes a step of the same work, after the work's own steps
--
-- A work's existing steps keep their order; its subtasks follow in their own order, done stays
-- done. The subtasks HTTP routes are retired in the same release (their writes would no longer be
-- seen), and the import that wrote subtasks writes steps. `work_item_subtasks` itself stays for
-- expand–contract (DA-6): the previous release may still read it during the overlap, and a later
-- contract migration drops it once the copy is verified (`source_subtask_id` count equals the
-- subtask count).
--
-- ## MariaDB-safe (live is MariaDB 11.8) and re-runnable
--
-- Three NULL columns and one index, online (ALGORITHM=INPLACE, LOCK=NONE; DA-7). No CHECK, no
-- generated column, no trigger, no foreign key. The copy is guarded by NOT EXISTS on
-- `source_subtask_id`, so a re-run after a stop writes nothing twice (DA-8).

ALTER TABLE work_item_checklist_items
  ADD COLUMN assignee_membership_id CHAR(36) NULL,
  ADD COLUMN due_on                 DATE     NULL,
  ADD COLUMN source_subtask_id      CHAR(36) NULL,
  ADD UNIQUE KEY uq_work_item_checklist_items_source (organization_id, source_subtask_id),
  ALGORITHM=INPLACE, LOCK=NONE;

INSERT INTO work_item_checklist_items
  (id, organization_id, work_item_id, label, done, position, created_at, source_subtask_id)
SELECT
  UUID(),
  s.organization_id,
  s.parent_work_item_id,
  s.title,
  s.is_done,
  s.position + COALESCE((
    SELECT MAX(c.position) + 1
    FROM work_item_checklist_items c
    WHERE c.organization_id = s.organization_id
      AND c.work_item_id = s.parent_work_item_id
      AND c.source_subtask_id IS NULL
  ), 0),
  s.created_at,
  s.id
FROM work_item_subtasks s
WHERE NOT EXISTS (
  SELECT 1 FROM work_item_checklist_items d
  WHERE d.organization_id = s.organization_id AND d.source_subtask_id = s.id
);
