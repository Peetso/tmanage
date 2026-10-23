-- 0225_decision_detail — the Decision detail page (Figma 376:17695 task 10, frames 384:3835 /
-- 384:4073, slice A15).
--
-- The page shows four things a decision row could not hold:
--
-- - **`number`** — the short register number the page prints as `DEC-014`. Allocated per
--   organization at insert (the repository reads `MAX(number) + 1` inside the insert's transaction;
--   `uq_decisions_org_number` is the backstop for a race). Existing rows are numbered here in the
--   order they were recorded, so the oldest decision of every studio is `DEC-001`.
-- - **`rationale`** — "Why we decided this". Optional prose, so TEXT NULL.
-- - **`source_message_id`** — the chat message the decision came from ("Source" card). Optional.
--   The service resolves it inside the tenant and the decision's project before it is written; there
--   is no foreign key because `messages` carries no `(organization_id, id)` key a child may
--   reference (only `uq_messages_org_id_depth`), the reason 0119 gives.
-- - **`audience`** — "Visible to": the team only, or the team and the project's client people.
--
-- The 0038 column-pinning trigger lists the columns that may never change; none of these four is in
-- it, so the backfill below and the page's Edit (rationale, audience) are allowed by the engine.
-- `users.sql` already grants the runtime credential UPDATE on `decisions` (DEC-01-b).
--
-- MariaDB-safe: plain columns, an ENUM, a unique key and a window-function backfill (MariaDB 10.2+,
-- MySQL 8); no generated column, no CHECK, no functional index.

ALTER TABLE decisions
  ADD COLUMN number INT UNSIGNED NULL AFTER project_id,
  ADD COLUMN rationale TEXT NULL AFTER statement,
  ADD COLUMN source_message_id CHAR(36) NULL AFTER meeting_id,
  ADD COLUMN audience ENUM('internal','client_visible') NOT NULL DEFAULT 'internal' AFTER status;

UPDATE decisions AS d
  INNER JOIN (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY organization_id ORDER BY created_at, id) AS seq
      FROM decisions
  ) AS ranked ON ranked.id = d.id
  SET d.number = ranked.seq;

-- Left NULLable on purpose: a fixture or a direct SQL insert that predates this column still works
-- (several NULLs never collide in a unique key), while every row the API writes carries a number.
ALTER TABLE decisions
  ADD UNIQUE KEY uq_decisions_org_number (organization_id, number);
