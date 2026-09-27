-- 0110_portal_settings — SEC: per-project client-portal settings / branding (module 13, x238).
--
-- Governing sources: 38-MODULE-MAP §Client Portal, 25-AUTHORIZATION-AND-TENANT-ISOLATION §6
-- (composite tenant keys), 07-DATA-MODEL §9 (index prefixes lead with `organization_id`).
--
-- ## What this is, and what it is not
--
-- The portal is built (CLIENT-002 and its siblings), but there was no per-project configuration of
-- how that portal presents itself to a client: the welcome message, the accent colour, and whether
-- the team and the timeline are shown. This table holds exactly that — one settings row per project,
-- keyed `(organization_id, project_id)`, so a studio configures each project's client portal
-- independently.
--
-- Every column here is a **presentation** field, and that is deliberate: the client-facing projection
-- reads the whole substance (welcome/accent/toggles) safely. The one field a client must never see is
-- `updated_by` — which member of the agency last edited the settings — and the client projection
-- (`client_projection.read`) never names it. There is no internal-notes column: portal settings are
-- branding, not a private record.
--
-- ## One row per project, and absence is a default
--
-- The upsert key is `(organization_id, project_id)`: the read/upsert repository writes
-- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in place rather than
-- creating a second row. The read path returns code-level defaults when no row exists at all, so
-- "never configured" and "saved the defaults" are one behaviour, not two — the `notification_preferences`
-- (0022) posture.
--
-- ## Project-owned, and tenant-scoped like every sibling
--
-- `project_id` is NOT NULL: settings belong to a project. The composite foreign key
-- `fk_portal_settings_project_tenant` binds `(organization_id, project_id)` to `projects`, so settings
-- can only ever name a project of their own tenant — a cross-tenant project id does not exist as a
-- pair even when both ids exist individually.
--
-- ## What may move
--
-- The settings substance — `welcome_message`, `accent_color`, `show_team`, `show_timeline` — and the
-- `updated_by` stamp are editable (a save is a replace). Identity — `id`, `organization_id`,
-- `project_id`, `created_at` — is not. The `BEFORE UPDATE` trigger pins the identity columns at the
-- engine, so a direct SQL session cannot re-point a settings row at another project or tenant.

CREATE TABLE portal_settings (
  id                 CHAR(36)      NOT NULL,
  organization_id    CHAR(36)      NOT NULL,
  -- NOT NULL. Settings belong to a project; see the header.
  project_id         CHAR(36)      NOT NULL,
  -- The client-facing welcome text. Nullable — a project may show the default (no message). Bounded
  -- at the application layer to 2000 characters; a VARCHAR of the same size backs it.
  welcome_message    VARCHAR(2000) NULL,
  -- The portal accent colour, one of a fixed palette validated in the application (a hex token). Not
  -- an ENUM so the palette can grow without a schema change, but the write is refused for a value
  -- outside the palette before it reaches the engine.
  accent_color       VARCHAR(7)    NOT NULL DEFAULT '#2563eb',
  -- Whether the client portal shows the project team and the timeline. On by default: a freshly
  -- configured portal shows the studio's work unless a studio chooses to hide it.
  show_team          BOOLEAN       NOT NULL DEFAULT TRUE,
  show_timeline      BOOLEAN       NOT NULL DEFAULT TRUE,
  -- The member who last saved the settings — the service passes `context.userId`. Internal-only: it
  -- is never carried on the client projection. Editable (a later save by another manager moves it).
  updated_by         CHAR(36)      NOT NULL,
  created_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                   ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_portal_settings_org_id (organization_id, id),
  -- One row per project per studio. This is the upsert key: the repository writes
  -- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in place.
  UNIQUE KEY uq_portal_settings_org_project (organization_id, project_id),
  CONSTRAINT fk_portal_settings_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_portal_settings_updated_by
    FOREIGN KEY (updated_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A settings row's identity is pinned at the engine; its substance (welcome_message, accent_color,
-- show_team, show_timeline) and its `updated_by` stamp may move. The trigger refuses an UPDATE that
-- changes any identity column — a direct SQL session bypasses the application layers, so the guarantee
-- that settings cannot be re-pointed at another project or tenant must hold at the engine too.
DELIMITER $$

CREATE TRIGGER trg_portal_settings_pin_identity
BEFORE UPDATE ON portal_settings FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id)
     OR NOT (NEW.organization_id <=> OLD.organization_id)
     OR NOT (NEW.project_id <=> OLD.project_id)
     OR NOT (NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'portal_settings identity columns are immutable';
  END IF;
END$$

DELIMITER ;
