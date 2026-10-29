-- 0247_users_disabled_two_step — the operator can disable an account and require two-step.
--
-- ## What this migration is for
--
-- Platform admin v2, People (SPEC §4 B2/B3, §6 0243 users part, split out to this number). Three
-- plain nullable columns on `users`:
--
--   * `disabled_at` / `disabled_reason` — a platform admin disabled the account (reason required,
--     5–500 characters). While `disabled_at` is set, sign-in and every session refuse with the
--     ordinary neutral message and `authentication_events.reason = 'account_disabled'`. Enabling
--     the account clears both columns; nothing else about the person changes.
--   * `two_step_required_at` — the operator asked for two-step at the next sign-in (or reset the
--     person's two-step). Until the person holds a confirmed factor, every organization route
--     answers 403 `two_step_required` and the enrolment routes stay open (the semantics of the
--     company switch in `two-step-requirement.guard.ts`).
--
-- `sessions` gains `ip_first` / `ip_last` (SPEC §6 0241, not shipped with 0241): the address a
-- session was first used from and the latest one, stamped by the session check, shown on B3.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain nullable columns, no default expression, no generated column, no CHECK, no index.
-- Additive only: code written before this migration ignores the columns.

ALTER TABLE users
  ADD COLUMN disabled_at DATETIME(3) NULL,
  ADD COLUMN disabled_reason VARCHAR(500) NULL,
  ADD COLUMN two_step_required_at DATETIME(3) NULL;

ALTER TABLE sessions
  ADD COLUMN ip_first VARCHAR(45) NULL,
  ADD COLUMN ip_last VARCHAR(45) NULL;
