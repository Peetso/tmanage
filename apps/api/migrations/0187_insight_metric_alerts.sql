-- 0187_insight_metric_alerts — a member's own threshold alert on one insights metric (module 15,
-- Insights & reporting, x319).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Insights & reporting (metric alerts);
-- 22-SCREEN §Insights dashboard; 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys);
-- 07-DATA-MODEL §9 (index prefixes lead with organization_id). The audit's gap: insights are reported
-- (x133–x135), snapshotted (x211, 0090), compared (x229), and given org-wide targets (x230, 0102) —
-- but a member cannot say "tell me when open items crosses N". This slice stores one member-owned
-- alert per metric (a comparator and a threshold) and, on the read, marks each currently-breached
-- against the latest workload snapshot. Config + read-side evaluation only: NO dispatch or email this
-- slice (Needs-Peter).
--
-- Distinct from `insight_targets` (0102, an org-wide goal line judged on-track/behind) and
-- `billing_usage_alerts` (x200, a billing-quota alert): this is a member's own metric threshold,
-- self-scoped by `member_user_id`, never org-wide.
--
-- ## Migration number
--
-- The pass-26 map reserves 0187 for x319. The migrator applies files in ascending numeric order and a
-- gap is not an error (it rejects only a NEW file numbered below an applied one), so 0187 is correct on
-- this base; nothing here depends on the literal number beyond the filename.
--
-- ## One row per member per metric, keyed by (organization_id, member_user_id, metric_key)
--
-- A row is one member's alert on one metric. It is tenant-owned like every other grant here — it
-- carries `organization_id`, the composite `(organization_id, id)` isolation key every tenant-scoped
-- table carries, and a foreign key to `organizations` — and self-scoped: `member_user_id` references
-- the global `users` table (identity is global; `notification_preferences.user_id` is the same
-- choice), and the `(organization_id, member_user_id, metric_key)` unique key is the upsert key. It is
-- registered in the query guard's `TENANT_TABLES` (tenant-guard.ts) so the layer-3 guard refuses any
-- unscoped read or write of it.
--
-- `metric_key` is a closed vocabulary (an ENUM mirrored by the application allowlist): the four
-- org-wide workload roll-up figures a snapshot freezes. An unknown key is a 400 in the controller,
-- never a stored row. `comparator` is `gte`/`lte`; `threshold` is a bounded non-negative count (the
-- metrics it judges are counts). A non-numeric threshold is a 400 before any write.
--
-- ## The write is one upsert; identity is immutable
--
-- The service writes `INSERT ... ON DUPLICATE KEY UPDATE` against
-- `uq_insight_metric_alerts_org_member_metric`, so setting a metric's alert a second time replaces its
-- comparator and threshold in place — an idempotent PUT — and a lost update is not expressible.
-- `organization_id`, `member_user_id` and `metric_key` are what a row *is*; the BEFORE UPDATE trigger
-- pins them at the engine (ADR-0001 layers 3 and 4 are application-side and a direct SQL session
-- bypasses both). `users.sql` grants the app INSERT + UPDATE (the upsert) and DELETE (a member removes
-- their own alert, 204); SELECT is the database-wide read the application already holds.

CREATE TABLE insight_metric_alerts (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The member who owns this alert. References the global `users` table; the alert is self-scoped, so
  -- every read and write filters on it and no member can name another's row.
  member_user_id  CHAR(36)     NOT NULL,
  -- The metric this alert watches, a closed vocabulary mirrored by `INSIGHT_ALERT_METRICS` in
  -- schema.ts: the four org-wide workload roll-up figures a `workload` snapshot (0090) freezes. An
  -- unknown key is a 400 in the controller, never a stored row.
  metric_key      ENUM('open_items','scheduled_items','active_projects','active_assignees') NOT NULL,
  -- How the live figure is compared to the threshold: `gte` breaches at or above, `lte` at or below.
  comparator      ENUM('gte','lte') NOT NULL,
  -- The threshold the metric is judged against — a bounded non-negative count. A non-numeric or
  -- out-of-range value is a 400 before any write.
  threshold       INT UNSIGNED NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries (the isolation corpus requires it).
  UNIQUE KEY uq_insight_metric_alerts_org_id (organization_id, id),
  -- One alert per member per metric. This is the upsert key: the service writes
  -- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a re-set updates comparator/threshold in place.
  UNIQUE KEY uq_insight_metric_alerts_org_member_metric (organization_id, member_user_id, metric_key),
  CONSTRAINT fk_insight_metric_alerts_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_insight_metric_alerts_user
    FOREIGN KEY (member_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A row's tenant, owner and metric are what it is and are immutable; only the comparator and threshold
-- change on a re-set. The trigger holds identity at the engine, the reason every other identity trigger
-- in this schema exists.
DELIMITER $$

CREATE TRIGGER trg_insight_metric_alerts_immutable
BEFORE UPDATE ON insight_metric_alerts FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'insight_metric_alerts.organization_id is immutable';
  END IF;
  IF NEW.member_user_id <> OLD.member_user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'insight_metric_alerts.member_user_id is immutable';
  END IF;
  IF NEW.metric_key <> OLD.metric_key THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'insight_metric_alerts.metric_key is immutable';
  END IF;
END$$

DELIMITER ;
