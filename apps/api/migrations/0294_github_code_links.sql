-- 0294_github_code_links — 54-10 GitHub, Phase 0 (R16 slice e).
--
-- ## What this migration is for
--
-- A developer writes `TM-482` in a branch name, a commit message or a pull request title; the work
-- item shows the branch, the commits and the pull request. Phase 0 needs no GitHub App: an owner
-- adds one repository webhook per repository (TManage shows the URL and a secret once; the owner
-- pastes both in the repository's settings). Phase 1 (the GitHub App, status moves on merge) is
-- Peter-gated and separate.
--
-- - `github_repo_hooks` (TENANT, new) — one pasted repository webhook. It hangs off the org's
--   `integration_connections` row for app 'github' (composite tenant FK). The HMAC secret is a
--   FieldCipher envelope in `secret_enc` (purpose `integration_token`, AAD = hook id), never
--   projected and never in an audit row. `project_ids_json` is the frozen list (<= 20) of projects
--   the creator could read when the hook was made: a key resolves only inside them (archived ones
--   are skipped at every event). `events_hour_*` is the per-hook 600-events-an-hour budget.
-- - `github_deliveries` (TENANT, new) — the replay guard: one row per `X-GitHub-Delivery` id per
--   hook. A second delivery with the same id is answered 202 and changes nothing. Rows older than
--   seven days are deleted by the inbound path itself.
-- - `work_item_code_links` (TENANT, new) — the plan's DDL: one branch / pull request / commit linked
--   to one work item. Title (first 500 characters) and URL only; commit bodies are never stored.
--   `connection_id` has no FK (a link outlives a removed connection).
-- - `projects.work_key_prefix` / `projects.work_key_next` — the project's key prefix (`TM`, Latin
--   [A-Z0-9], 2..10, unique per organization) and the next number to hand out (atomic counter).
-- - `work_items.work_key` — `TM-482`, unique per organization. NULL until the project has a prefix.
--
-- `link_kind`, `status`, `provider` are closed lists checked in the application (no CHECK).
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATETIME(3), composite tenant keys, no generated columns, no CHECK, no JSON
-- defaults, no functional indexes, utf8mb4_unicode_ci. A NULL `work_key` / `work_key_prefix` never
-- collides in a UNIQUE index (both engines). No foreign key to `projects` from the hook (the 0257
-- convention): the service resolves every project tenant-scoped first.
--
-- ## Grants (scripts/db/users.sql, 0294 block)
--
-- `tmanage_app`: SELECT, INSERT, UPDATE, DELETE on the three tables (UPDATE on `projects` and
-- `work_items` is already granted). `tmanage_worker`: nothing.

ALTER TABLE projects
  ADD COLUMN work_key_prefix VARCHAR(10) NULL,
  ADD COLUMN work_key_next INT UNSIGNED NOT NULL DEFAULT 1,
  ADD UNIQUE KEY uq_projects_org_work_key_prefix (organization_id, work_key_prefix);

ALTER TABLE work_items
  ADD COLUMN work_key VARCHAR(20) NULL,
  ADD UNIQUE KEY uq_work_items_org_key (organization_id, work_key);

CREATE TABLE github_repo_hooks (
  id                    CHAR(36)      NOT NULL,
  organization_id       CHAR(36)      NOT NULL,
  connection_id         CHAR(36)      NOT NULL,
  -- 'owner/name', lower-cased.
  repo_full_name        VARCHAR(300)  NOT NULL,
  -- FieldCipher envelope of the HMAC secret. Never projected, never logged, never audited.
  secret_enc            TEXT          NOT NULL,
  -- JSON array of <= 20 project ids, frozen at creation.
  project_ids_json      TEXT          NOT NULL,
  -- 'active' | 'paused' (checked in the application).
  status                VARCHAR(10)   NOT NULL DEFAULT 'active',
  events_hour_started_at DATETIME(3)  NULL,
  events_hour_count     INT           NOT NULL DEFAULT 0,
  last_event_at         DATETIME(3)   NULL,
  created_by            CHAR(36)      NOT NULL,
  created_at            DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_github_repo_hooks_org_id (organization_id, id),
  UNIQUE KEY uq_github_repo_hooks_repo (organization_id, repo_full_name),
  CONSTRAINT fk_github_repo_hooks_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_github_repo_hooks_connection_tenant
    FOREIGN KEY (organization_id, connection_id)
    REFERENCES integration_connections (organization_id, id),
  CONSTRAINT fk_github_repo_hooks_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE github_deliveries (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  hook_id          CHAR(36)     NOT NULL,
  delivery_id      VARCHAR(64)  NOT NULL,
  received_at      DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_github_deliveries_org_id (organization_id, id),
  UNIQUE KEY uq_github_deliveries_delivery (organization_id, hook_id, delivery_id),
  KEY ix_github_deliveries_received (organization_id, hook_id, received_at),
  CONSTRAINT fk_github_deliveries_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_github_deliveries_hook_tenant
    FOREIGN KEY (organization_id, hook_id)
    REFERENCES github_repo_hooks (organization_id, id)
    ON DELETE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE work_item_code_links (
  id               CHAR(36)       NOT NULL,
  organization_id  CHAR(36)       NOT NULL,
  work_item_id     CHAR(36)       NOT NULL,
  connection_id    CHAR(36)       NULL,
  -- 'github' (checked in the application).
  provider         VARCHAR(16)    NOT NULL,
  repo_full_name   VARCHAR(300)   NOT NULL,
  -- 'branch' | 'pr' | 'commit' (checked in the application).
  link_kind        VARCHAR(16)    NOT NULL,
  external_id      VARCHAR(190)   NOT NULL,
  title            VARCHAR(500)   NULL,
  state            VARCHAR(32)    NULL,
  url              VARCHAR(2048)  NOT NULL,
  actor_login      VARCHAR(190)   NULL,
  updated_at       DATETIME(3)    NOT NULL,
  created_at       DATETIME(3)    NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_wicl_org_id (organization_id, id),
  UNIQUE KEY uq_wicl_item_ext (organization_id, work_item_id, provider, link_kind, external_id),
  CONSTRAINT fk_wicl_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_wicl_work_item_tenant
    FOREIGN KEY (organization_id, work_item_id)
    REFERENCES work_items (organization_id, id)
    ON DELETE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

CREATE TRIGGER trg_github_repo_hooks_org_immutable
BEFORE UPDATE ON github_repo_hooks FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'github_repo_hooks.organization_id is immutable';
  END IF;
END$$

CREATE TRIGGER trg_github_deliveries_org_immutable
BEFORE UPDATE ON github_deliveries FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'github_deliveries.organization_id is immutable';
  END IF;
END$$

CREATE TRIGGER trg_work_item_code_links_org_immutable
BEFORE UPDATE ON work_item_code_links FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_code_links.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
