-- 0332_security_signal_review — an owner marks a security signal reviewed (56-23, R44 L2).
--
-- ## What this migration is for
--
-- The owner's Security signals screen lists the company's own signals and lets an owner say
-- "I have looked at this one". Two nullable columns on `security_signals` (0263):
--
-- - `reviewed_at` — when it was marked reviewed; NULL = not reviewed (every existing row).
-- - `reviewed_by_user_id` — who marked it. No foreign key (the 0257 convention).
--
-- The API sets both together, once, in one tenant-scoped UPDATE that names the caller's own
-- `organization_id` (platform rows, NULL organization, are never reachable). The worker's upsert
-- never writes them. `scripts/db/users.sql` adds UPDATE for `tmanage_app` on the table.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Two plain nullable columns and one ordinary index: no generated columns, no CHECK, no foreign
-- keys. Additive only.

ALTER TABLE security_signals
  ADD COLUMN reviewed_at         DATETIME(3) NULL AFTER notified_at,
  ADD COLUMN reviewed_by_user_id CHAR(36)    NULL AFTER reviewed_at;

CREATE INDEX ix_security_signals_org_reviewed ON security_signals (organization_id, reviewed_at);
