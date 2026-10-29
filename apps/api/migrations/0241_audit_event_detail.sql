-- 0241_audit_event_detail — who did it from where, and what changed, on every org audit event.
--
-- ## What this migration is for
--
-- The action log (SPEC §4 C1/C2) shows the IP and device of each action, marks actions taken in
-- Support mode, and opens a before → after table. `audit_events` gains `ip`, `user_agent` and
-- `platform_support_session_id`, plus a time index without the organization prefix for the
-- cross-organization list. The changed values go to a new tenant table, `audit_event_changes`,
-- one row per field, never into `metadata_json` (whose "ids and classifications only" rule is
-- unchanged). The writer redacts secret-ish fields (`password*`, `*token*`, `*secret*`,
-- `*hash*`, `refresh_*` → `redacted = 1`, values dropped) and caps each value at 2000 characters.
--
-- `authentication_events` gains two read indexes for the access log (time, and IP + time).
--
-- ## Tenant table (TENANT_TABLES)
--
-- `audit_event_changes` carries `organization_id` first in every key, a `(organization_id, id)`
-- unique key, and a composite foreign key to `audit_events (organization_id, id)`, so a change
-- row can never point at another organization's event. INSERT-only for the app, like
-- `audit_events`.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, literal defaults or CURRENT_TIMESTAMP(3), no generated columns, no CHECK.

ALTER TABLE audit_events
  ADD COLUMN ip VARCHAR(45) NULL,
  ADD COLUMN user_agent VARCHAR(255) NULL,
  ADD COLUMN platform_support_session_id CHAR(36) NULL,
  ADD KEY ix_audit_events_support (platform_support_session_id),
  ADD KEY ix_audit_events_time_global (created_at, id);

CREATE TABLE audit_event_changes (
  id              CHAR(36)      NOT NULL,
  organization_id CHAR(36)      NOT NULL,
  audit_event_id  CHAR(36)      NOT NULL,
  field           VARCHAR(64)   NOT NULL,
  before_value    VARCHAR(2000) NULL,
  after_value     VARCHAR(2000) NULL,
  redacted        TINYINT(1)    NOT NULL DEFAULT 0,
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_aec_org_id (organization_id, id),
  KEY ix_aec_event (organization_id, audit_event_id),
  CONSTRAINT fk_aec_event FOREIGN KEY (organization_id, audit_event_id)
    REFERENCES audit_events (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE authentication_events
  ADD KEY ix_auth_events_time (occurred_at, id),
  ADD KEY ix_auth_events_ip (ip, occurred_at);
