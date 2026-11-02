-- 0289_integration_channel_links — 54-05 Slack + 54-06 Teams, Phase 0 (R15 slice c).
--
-- ## What this migration is for
--
-- A studio pastes a Slack Incoming Webhook URL or a Teams Incoming Webhook / Workflows URL, picks
-- which events (from the 54-03 webhook catalogue) post there and in which language, and TManage
-- posts short channel notices. No Slack or Microsoft app, no OAuth, no inbound surface (Phase 1 is
-- separate and Peter-gated). Two tenant tables:
--
-- - `integration_channel_links` (TENANT, new) — one pasted channel. It hangs off the org's
--   `integration_connections` row for the app ('slack' | 'teams'; composite tenant FK). The URL is
--   a bearer credential (anyone holding it can post to the channel), so it is stored only as a
--   FieldCipher envelope in `webhook_url_enc` (AAD bound to the link id) and never projected;
--   `url_host` is what the settings screen shows. `external_channel_id` is the SHA-256 hex of the
--   URL path, which keeps the plan's UNIQUE meaningful without storing the URL in clear.
--   `project_id` NULL = the whole organization. `status` 'active' | 'paused', `failure_streak`
--   and `paused_reason` are the breaker (pause at 20 consecutive failures or a 410 Gone).
-- - `integration_channel_posts` (TENANT, new) — the post ledger, `webhook_deliveries`-shaped: one
--   row per (link, outbox event), retried in place (`attempt`, `next_attempt_at`). A test post has
--   no outbox event (`outbox_event_id` NULL), so it never collides with the UNIQUE.
--   `status` staged | sending | delivered | failed | cancelled. `last_error` is a short class
--   (`timeout`, `blocked_private_ip`, an HTTP status excerpt), never the request body.
--
-- `kind`, `status`, `locale` are closed lists checked in the application (no CHECK constraints).
-- `UNIQUE (organization_id, connection_id, project_id, external_channel_id)`: a NULL `project_id`
-- never collides, so the service looks for an existing link before it inserts one.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATETIME(3), composite tenant keys, no generated columns, no CHECK, no JSON
-- defaults, no functional indexes, utf8mb4_unicode_ci. No foreign key to `projects` (the 0257
-- convention): the service resolves the project tenant-scoped first. Removing a link removes its
-- ledger (ON DELETE CASCADE).
--
-- ## Grants (scripts/db/users.sql, 0289 block)
--
-- `tmanage_app`: SELECT, INSERT, UPDATE, DELETE on links; SELECT, INSERT on posts (a test post).
-- `tmanage_worker`: SELECT, UPDATE on links (breaker); SELECT, INSERT, UPDATE on posts.

CREATE TABLE integration_channel_links (
  id                      CHAR(36)      NOT NULL,
  organization_id         CHAR(36)      NOT NULL,
  connection_id           CHAR(36)      NOT NULL,
  -- 'slack' | 'teams' (checked in the application).
  kind                    VARCHAR(8)    NOT NULL,
  -- NULL = every project of the organization.
  project_id              CHAR(36)      NULL,
  -- SHA-256 hex of the webhook URL's path.
  external_channel_id     VARCHAR(190)  NOT NULL,
  external_channel_label  VARCHAR(300)  NULL,
  -- FieldCipher envelope of the pasted URL. Never projected, never logged.
  webhook_url_enc         TEXT          NOT NULL,
  url_host                VARCHAR(255)  NOT NULL,
  events_json             TEXT          NOT NULL,
  locale                  VARCHAR(35)   NOT NULL DEFAULT 'en',
  -- 'active' | 'paused' (checked in the application).
  status                  VARCHAR(16)   NOT NULL DEFAULT 'active',
  failure_streak          INT           NOT NULL DEFAULT 0,
  paused_reason           VARCHAR(200)  NULL,
  last_posted_at          DATETIME(3)   NULL,
  created_by              CHAR(36)      NOT NULL,
  created_at              DATETIME(3)   NOT NULL,
  updated_at              DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_icl_org_id (organization_id, id),
  UNIQUE KEY uq_icl_conn_proj (organization_id, connection_id, project_id, external_channel_id),
  KEY ix_icl_org_status (organization_id, status),
  CONSTRAINT fk_icl_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_icl_connection_tenant
    FOREIGN KEY (organization_id, connection_id)
    REFERENCES integration_connections (organization_id, id),
  CONSTRAINT fk_icl_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE integration_channel_posts (
  id                CHAR(36)           NOT NULL,
  organization_id   CHAR(36)           NOT NULL,
  link_id           CHAR(36)           NOT NULL,
  -- NULL for a test post.
  outbox_event_id   CHAR(36)           NULL,
  event_kind        VARCHAR(64)        NOT NULL,
  locale            VARCHAR(35)        NOT NULL,
  -- staged | sending | delivered | failed | cancelled (checked in the application).
  status            VARCHAR(16)        NOT NULL,
  attempt           INT                NOT NULL DEFAULT 1,
  next_attempt_at   DATETIME(3)        NULL,
  last_status_code  SMALLINT UNSIGNED  NULL,
  last_error        VARCHAR(500)       NULL,
  created_at        DATETIME(3)        NOT NULL,
  updated_at        DATETIME(3)        NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_icp_org_id (organization_id, id),
  UNIQUE KEY uq_icp_link_event (organization_id, link_id, outbox_event_id),
  KEY ix_icp_org_due (organization_id, status, next_attempt_at),
  KEY ix_icp_link_created (organization_id, link_id, created_at),
  CONSTRAINT fk_icp_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_icp_link_tenant
    FOREIGN KEY (organization_id, link_id)
    REFERENCES integration_channel_links (organization_id, id)
    ON DELETE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

CREATE TRIGGER trg_integration_channel_links_org_immutable
BEFORE UPDATE ON integration_channel_links FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'integration_channel_links.organization_id is immutable';
  END IF;
END$$

CREATE TRIGGER trg_integration_channel_posts_org_immutable
BEFORE UPDATE ON integration_channel_posts FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'integration_channel_posts.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
