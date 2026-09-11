-- 0001_tenancy — the tenancy foundation.
--
-- Governing sources: 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md section 5,
-- 07-DATA-MODEL.md, contracts/tmanage-core.dbml, ADR-0001 layer 1.
--
-- This file is layer 1 of ADR-0001: the part of tenant isolation that survives even if
-- every line of application code is bypassed. MySQL has no row-level security, so the
-- schema itself has to refuse cross-tenant edges.
--
-- Three rules are applied without exception:
--
--   1. Every tenant-owned table carries `organization_id CHAR(36) NOT NULL`.
--   2. Every tenant-owned parent carries `UNIQUE KEY (organization_id, id)`, which exists
--      solely so that (3) is expressible. A globally unique `id` is explicitly not enough
--      (spec section 5).
--   3. Every child-to-parent reference is a COMPOSITE foreign key including
--      `organization_id`. A work item in tenant A therefore cannot reference a project in
--      tenant B — not "should not", cannot. The insert fails at the storage layer.
--
-- Plus: `organization_id` is immutable after insert, enforced by trigger, because a
-- composite foreign key still permits moving a whole row between tenants if every
-- referenced parent moves with it.
--
-- Conventions: InnoDB, utf8mb4/utf8mb4_unicode_ci (spelled out on every table rather than
-- inherited, because MySQL 8's own server default is utf8mb4_0900_ai_ci and an unstated
-- collation would follow whatever the server was started with), ROW_FORMAT=DYNAMIC,
-- DATETIME(3) in UTC, application-generated UUIDv7 stored as canonical lowercase CHAR(36).
-- Strict SQL mode and the UTC session time zone are set by the connection, not here.

-- ─────────────────────────────────────────────────────────────────────────────
-- Identity — global, deliberately NOT tenant-owned
-- ─────────────────────────────────────────────────────────────────────────────
-- A person is one user account that may hold memberships in several organizations.
-- Making `users` tenant-owned would fork identity per tenant and break session revocation.
-- These tables are excluded from the tenant guard's registry for exactly that reason.

CREATE TABLE users (
  id                CHAR(36)     NOT NULL,
  email             VARCHAR(254) NOT NULL,
  display_name      VARCHAR(190) NOT NULL,
  locale            VARCHAR(35)  NOT NULL DEFAULT 'en',
  timezone          VARCHAR(64)  NOT NULL DEFAULT 'UTC',
  email_verified_at DATETIME(3)  NULL,
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                 ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sessions (
  id                 CHAR(36)     NOT NULL,
  user_id            CHAR(36)     NOT NULL,
  refresh_token_hash CHAR(64)     NOT NULL,
  user_agent         VARCHAR(255) NULL,
  expires_at         DATETIME(3)  NOT NULL,
  revoked_at         DATETIME(3)  NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_refresh_token_hash (refresh_token_hash),
  KEY ix_sessions_user_expiry (user_id, expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Tenant root
-- ─────────────────────────────────────────────────────────────────────────────
-- `organizations` is tenant-owned, but its tenant key is `id` rather than
-- `organization_id`. The tenant guard registry records that exception explicitly; every
-- read of this table must still be scoped to the active organization.

CREATE TABLE organizations (
  id             CHAR(36)     NOT NULL,
  slug           VARCHAR(63)  NOT NULL,
  name           VARCHAR(190) NOT NULL,
  default_locale VARCHAR(35)  NOT NULL DEFAULT 'en',
  timezone       VARCHAR(64)  NOT NULL DEFAULT 'UTC',
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                              ON UPDATE CURRENT_TIMESTAMP(3),
  archived_at    DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_organizations_slug (slug)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Internal membership
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE memberships (
  id                 CHAR(36)    NOT NULL,
  organization_id    CHAR(36)    NOT NULL,
  user_id            CHAR(36)    NOT NULL,
  role               VARCHAR(64) NOT NULL,
  status             ENUM('invited','active','suspended','offboarded')
                                 NOT NULL DEFAULT 'active',
  -- Owner/admin roles see every workspace; a member sees only projects they belong to.
  -- Stored rather than derived so a policy change cannot silently widen historical scope.
  has_org_wide_scope TINYINT(1)  NOT NULL DEFAULT 0,
  version            BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                 ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_memberships_org_id (organization_id, id),
  -- 07-DATA-MODEL section 9: unique active membership per user/organization.
  UNIQUE KEY uq_memberships_org_user (organization_id, user_id),
  KEY ix_memberships_user (user_id),
  CONSTRAINT fk_memberships_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_memberships_user
    FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Work graph
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE workspaces (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  name            VARCHAR(190) NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                               ON UPDATE CURRENT_TIMESTAMP(3),
  archived_at     DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_workspaces_org_id (organization_id, id),
  CONSTRAINT fk_workspaces_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE projects (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  workspace_id    CHAR(36)     NOT NULL,
  name            VARCHAR(190) NOT NULL,
  status          VARCHAR(32)  NOT NULL DEFAULT 'active',
  owner_user_id   CHAR(36)     NULL,
  committed_at    DATETIME(3)  NULL,
  forecast_at     DATETIME(3)  NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                               ON UPDATE CURRENT_TIMESTAMP(3),
  archived_at     DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_projects_org_id (organization_id, id),
  KEY ix_projects_org_workspace (organization_id, workspace_id),
  -- The canonical example from spec section 5: the workspace must belong to the same
  -- tenant as the project, enforced by the key rather than by a service check.
  CONSTRAINT fk_projects_workspace_tenant
    FOREIGN KEY (organization_id, workspace_id) REFERENCES workspaces (organization_id, id),
  CONSTRAINT fk_projects_owner
    FOREIGN KEY (owner_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE project_memberships (
  id              CHAR(36)    NOT NULL,
  organization_id CHAR(36)    NOT NULL,
  project_id      CHAR(36)    NOT NULL,
  user_id         CHAR(36)    NOT NULL,
  role            VARCHAR(64) NOT NULL DEFAULT 'member',
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_project_memberships_org_id (organization_id, id),
  UNIQUE KEY uq_project_memberships_identity (organization_id, project_id, user_id),
  KEY ix_project_memberships_user (organization_id, user_id),
  CONSTRAINT fk_project_memberships_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_project_memberships_user
    FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Client access
-- ─────────────────────────────────────────────────────────────────────────────
-- A client organization belongs to exactly one service organization. Two service
-- organizations that both work with the same real-world company hold two separate,
-- unrelated `client_organizations` rows — there is no shared record between tenants.

CREATE TABLE client_organizations (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  name            VARCHAR(190) NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                               ON UPDATE CURRENT_TIMESTAMP(3),
  archived_at     DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_client_organizations_org_id (organization_id, id),
  CONSTRAINT fk_client_organizations_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE client_memberships (
  id                     CHAR(36)    NOT NULL,
  organization_id        CHAR(36)    NOT NULL,
  client_organization_id CHAR(36)    NOT NULL,
  user_id                CHAR(36)    NOT NULL,
  role                   VARCHAR(64) NOT NULL,
  status                 ENUM('invited','active','suspended','offboarded')
                                     NOT NULL DEFAULT 'active',
  -- Client access is time-bounded by default (CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS).
  -- Expiry is a first-class column so the isolation corpus can test an expired client.
  expires_at             DATETIME(3) NULL,
  created_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                     ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_client_memberships_org_id (organization_id, id),
  UNIQUE KEY uq_client_memberships_identity
    (organization_id, client_organization_id, user_id),
  KEY ix_client_memberships_user (user_id),
  CONSTRAINT fk_client_memberships_client_org_tenant
    FOREIGN KEY (organization_id, client_organization_id)
    REFERENCES client_organizations (organization_id, id),
  CONSTRAINT fk_client_memberships_user
    FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which client organizations may see which projects. Both composite foreign keys point
-- into the same tenant, so a share row cannot join a project in tenant A to a client of
-- tenant B even if an application bug supplies both ids.
CREATE TABLE project_clients (
  id                     CHAR(36)    NOT NULL,
  organization_id        CHAR(36)    NOT NULL,
  project_id             CHAR(36)    NOT NULL,
  client_organization_id CHAR(36)    NOT NULL,
  created_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_project_clients_org_id (organization_id, id),
  UNIQUE KEY uq_project_clients_identity
    (organization_id, project_id, client_organization_id),
  KEY ix_project_clients_client_org (organization_id, client_organization_id),
  CONSTRAINT fk_project_clients_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_project_clients_client_org_tenant
    FOREIGN KEY (organization_id, client_organization_id)
    REFERENCES client_organizations (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Work items
-- ─────────────────────────────────────────────────────────────────────────────
-- Included in the tenancy migration rather than a later module migration because
-- ADR-0001 and spec section 5 both use work_items -> projects as *the* composite foreign
-- key example, and the isolation corpus needs a real child-of-a-tenant-parent to prove it.

CREATE TABLE work_items (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  project_id      CHAR(36)     NOT NULL,
  type            VARCHAR(32)  NOT NULL DEFAULT 'task',
  title           VARCHAR(300) NOT NULL,
  state           VARCHAR(32)  NOT NULL DEFAULT 'triage',
  owner_user_id   CHAR(36)     NULL,
  audience        ENUM('internal','client_visible','client_action_required')
                               NOT NULL DEFAULT 'internal',
  start_at        DATETIME(3)  NULL,
  due_at          DATETIME(3)  NULL,
  -- Optimistic concurrency (spec section 3 step 7). Incremented by the repository.
  version         BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                               ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_work_items_org_id (organization_id, id),
  -- 07-DATA-MODEL section 9: every composite index begins with organization_id, because
  -- every legitimate query does too.
  KEY ix_work_items_org_project_state_due (organization_id, project_id, state, due_at),
  KEY ix_work_items_org_owner_state_due (organization_id, owner_user_id, state, due_at),
  CONSTRAINT fk_work_items_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_work_items_owner
    FOREIGN KEY (owner_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Tenant immutability triggers
-- ─────────────────────────────────────────────────────────────────────────────
-- Spec section 5: "Updates cannot change organization_id; moving data between
-- organizations is an explicit audited migration workflow."
--
-- Composite foreign keys alone do not deliver this. `UPDATE work_items SET
-- organization_id = :other` succeeds the moment a project with the same id exists in the
-- target tenant, and a bulk `UPDATE ... SET organization_id` that walks the graph in
-- dependency order would move an entire subtree. These triggers close that door at the
-- engine, so the guarantee holds for a direct SQL session too — which matters, because
-- ADR-0001 layers 3 and 4 do not.
--
-- The trigger bodies contain semicolons, which is why the migrator implements the
-- `DELIMITER` directive rather than splitting on `;`.

DELIMITER $$

CREATE TRIGGER trg_organizations_id_immutable
BEFORE UPDATE ON organizations FOR EACH ROW
BEGIN
  IF NEW.id <> OLD.id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'organizations.id is immutable: see spec section 5';
  END IF;
END$$

CREATE TRIGGER trg_memberships_org_immutable
BEFORE UPDATE ON memberships FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'memberships.organization_id is immutable: see spec section 5';
  END IF;
END$$

CREATE TRIGGER trg_workspaces_org_immutable
BEFORE UPDATE ON workspaces FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'workspaces.organization_id is immutable: see spec section 5';
  END IF;
END$$

CREATE TRIGGER trg_projects_org_immutable
BEFORE UPDATE ON projects FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'projects.organization_id is immutable: see spec section 5';
  END IF;
END$$

CREATE TRIGGER trg_project_memberships_org_immutable
BEFORE UPDATE ON project_memberships FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_memberships.organization_id is immutable: spec section 5';
  END IF;
END$$

CREATE TRIGGER trg_client_organizations_org_immutable
BEFORE UPDATE ON client_organizations FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_organizations.organization_id is immutable: spec section 5';
  END IF;
END$$

CREATE TRIGGER trg_client_memberships_org_immutable
BEFORE UPDATE ON client_memberships FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_memberships.organization_id is immutable: spec section 5';
  END IF;
END$$

CREATE TRIGGER trg_project_clients_org_immutable
BEFORE UPDATE ON project_clients FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_clients.organization_id is immutable: spec section 5';
  END IF;
END$$

CREATE TRIGGER trg_work_items_org_immutable
BEFORE UPDATE ON work_items FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_items.organization_id is immutable: see spec section 5';
  END IF;
END$$

DELIMITER ;
