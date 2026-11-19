-- 0380_work_signals — the signals engine (62-27, 62-A1a, B05).
--
-- ## What this migration is for
--
-- The worker job `signals-sweeper` runs eight pure rules (`packages/domain/src/signals/`) over a
-- company's work once an hour and files what they find here. No model is called anywhere. The
-- whole surface sits behind the per-organization flag `business_briefing` (default off).
--
-- - `work_signals` (TENANT): one row per rule, subject and day — "this task is stale", "this
--   invoice is 9 days overdue". `uq_work_signals_dedupe` (organization, rule, subject, day) is the
--   dedupe key: two sweeps racing on one day write one row (`INSERT IGNORE`); the sweeper also
--   waits 24 hours from a subject's last signal before raising it again. A row holds ids, the
--   measured figure and the threshold in force, never a title or an amount's text. `notify` says
--   whether the rule was on when it fired: an off rule still files its signal (the Home briefing
--   shows it) but sends no notice. A notice goes through the outbox
--   (`work_signal.raised.v1`) and is told to the people the owner chose, resolved at delivery.
--   `seen_at` is the last sweep that still found the condition: every sweep moves it (and the
--   measured figure) on the subject's latest row, so "open" means `seen_at` equals the last sweep
--   of the organization (62-A1b, the Home briefing) and a condition that cleared drops out at once.
-- - `work_signal_settings` (TENANT): the owner's choice per rule — on/off, threshold, who is told.
--   No row = the catalogue default, on. One row per rule (`uq_work_signal_settings_rule`).
-- - `work_signal_sweeps` (TENANT): one row per organization, the time of its last finished sweep
--   (written in the same transaction as that sweep's signals). The briefing's "As of <time>".
--
-- Every time here comes from a bound value the sweeper or the API passes in, never the database
-- clock.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATE and DATETIME(3), no CHECK, no generated column, no JSON column, no
-- functional or partial index, no trigger, no foreign key (the 0257 convention). Each statement
-- is one CREATE; the migrator resumes an interrupted file at its first unapplied statement and
-- treats "already exists" on that one statement as applied.

CREATE TABLE work_signals (
  id              CHAR(36)    NOT NULL,
  organization_id CHAR(36)    NOT NULL,
  rule_key        VARCHAR(48) NOT NULL,
  subject_type    VARCHAR(32) NOT NULL,
  subject_id      CHAR(36)    NOT NULL,
  project_id      CHAR(36)    NULL,
  signal_day      DATE        NOT NULL,
  measure         INT         NOT NULL,
  threshold       INT         NOT NULL,
  notify          TINYINT(1)  NOT NULL,
  raised_at       DATETIME(3) NOT NULL,
  seen_at         DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_work_signals_org_id (organization_id, id),
  UNIQUE KEY uq_work_signals_dedupe (organization_id, rule_key, subject_id, signal_day),
  KEY ix_work_signals_subject_time (organization_id, rule_key, subject_id, raised_at),
  KEY ix_work_signals_day (organization_id, signal_day, rule_key),
  KEY ix_work_signals_project (organization_id, project_id, signal_day),
  KEY ix_work_signals_seen (organization_id, seen_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE work_signal_settings (
  id                 CHAR(36)    NOT NULL,
  organization_id    CHAR(36)    NOT NULL,
  rule_key           VARCHAR(48) NOT NULL,
  enabled            TINYINT(1)  NOT NULL,
  threshold          INT         NOT NULL,
  recipient          VARCHAR(32) NOT NULL,
  updated_by_user_id CHAR(36)    NULL,
  created_at         DATETIME(3) NOT NULL,
  updated_at         DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_work_signal_settings_org_id (organization_id, id),
  UNIQUE KEY uq_work_signal_settings_rule (organization_id, rule_key)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE work_signal_sweeps (
  id              CHAR(36)    NOT NULL,
  organization_id CHAR(36)    NOT NULL,
  swept_at        DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_work_signal_sweeps_org_id (organization_id, id),
  -- One row per organization: the upsert target of every sweep.
  UNIQUE KEY uq_work_signal_sweeps_org (organization_id)
)ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
