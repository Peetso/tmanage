-- 0352_support_sla — the SLA layer on 55-17's support threads (57-10, plan 57-M12).
--
-- ## What this migration is for
--
-- A support thread now carries what it is about (`category`), how urgent the writer says it is
-- (`priority`), and the SLA captured when it was opened: the organization's plan
-- (`plan_id_at_open`), the business-hours timezone (`sla_timezone`), and the first-response and
-- resolution targets in business minutes. Capturing them at opening means a later plan change or
-- policy edit never moves an open clock (57 SUP-03).
--
-- - `first_response_at` is written by the server on the first platform-authored reply only — the
--   writer has no field that sets it (SUP-05).
-- - The resolution clock pauses while the thread is `waiting` on the customer: `sla_paused_at` is
--   the start of the pause in progress, `sla_paused_minutes` the business minutes of finished ones.
-- - `sla_breached` is the last breach state the server computed on a write (either target missed),
--   for the inbox filter and the monthly report; reads recompute it live (`support/support-sla.ts`).
--
-- Policy (targets per plan and priority, Sun–Thu 09:00–18:00) is data in `support-sla.ts`, not a
-- table: no new table (57-10 "Data model").
--
-- TENANT: unchanged — `support_threads` stays keyed `(organization_id, id)`, and the new columns are
-- read and written through the same statements in `support.repository.ts`.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- One ALTER of plain columns with constant defaults, DATETIME(3), no generated columns, no CHECK, a
-- plain composite index. Existing rows get `question` / `normal` and NULL targets: a thread opened
-- before this migration shows no SLA clock rather than an invented one.

ALTER TABLE support_threads
  ADD COLUMN category                    VARCHAR(24)   NOT NULL DEFAULT 'question',
  ADD COLUMN priority                    VARCHAR(16)   NOT NULL DEFAULT 'normal',
  ADD COLUMN plan_id_at_open             VARCHAR(64)   NULL,
  ADD COLUMN sla_timezone                VARCHAR(64)   NULL,
  ADD COLUMN sla_first_response_minutes  INT UNSIGNED  NULL,
  ADD COLUMN sla_resolution_minutes      INT UNSIGNED  NULL,
  ADD COLUMN first_response_at           DATETIME(3)   NULL,
  ADD COLUMN sla_paused_at               DATETIME(3)   NULL,
  ADD COLUMN sla_paused_minutes          INT UNSIGNED  NOT NULL DEFAULT 0,
  ADD COLUMN sla_breached                TINYINT(1)    NOT NULL DEFAULT 0,
  ADD KEY ix_support_threads_sla (status, sla_breached, created_at);
