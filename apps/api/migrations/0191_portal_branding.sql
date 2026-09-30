-- 0191_portal_branding — SEC: per-client-organization client-portal branding (module 13, x323).
--
-- Governing sources: 38-MODULE-MAP §Client Portal (per-client branding), 22-SCREEN §Portal home,
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys), 07-DATA-MODEL §9 (index prefixes
-- lead with `organization_id`).
--
-- ## What this is, and what it is not
--
-- `portal_settings` (0110) is per-**project** presentation config — welcome message, accent, the two
-- toggles. This table is a different axis: per-**client-organization** branding for the client-facing
-- surface. A studio sets one client's accent colour and welcome copy once, and every project shared
-- with that client reads the same theme. One row per `(organization_id, client_org_scope_id)`.
--
-- Every column is a **presentation** field a client may safely read — the accent colour and the two
-- welcome strings. The one field a client must never see is `updated_by` (which member of the agency
-- last edited the branding), and the client projection (`client_projection.read`) never names it.
-- Text and colour only this slice: no logo upload, no file column.
--
-- ## One row per client organization, and absence is a default
--
-- The upsert key is `(organization_id, client_org_scope_id)`: the read/upsert repository writes
-- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in place rather than
-- creating a second row. The read path returns code-level defaults when no row exists, so "never
-- branded" and "saved the defaults" are one behaviour — the `portal_settings`/`notification_preferences`
-- posture.
--
-- ## Client-owned, and tenant-scoped like every sibling
--
-- `client_org_scope_id` is NOT NULL: branding belongs to a client organization. The composite foreign
-- key `fk_portal_branding_client_org_tenant` binds `(organization_id, client_org_scope_id)` to
-- `client_organizations`, so branding can only ever name a client of its own tenant — a cross-tenant
-- client id does not exist as a pair even when both ids exist individually.
--
-- ## What may move
--
-- The branding substance — `accent_color`, `welcome_heading`, `welcome_text` — and the `updated_by`
-- stamp are editable (a save is a replace). Identity — `id`, `organization_id`, `client_org_scope_id`,
-- `created_at` — is not. The `BEFORE UPDATE` trigger pins the identity columns at the engine, so a
-- direct SQL session cannot re-point a branding row at another client or tenant.

CREATE TABLE portal_branding (
  id                   CHAR(36)      NOT NULL,
  organization_id      CHAR(36)      NOT NULL,
  -- NOT NULL. Branding belongs to a client organization; see the header. The `_scope_id` name is the
  -- brief's: the per-client scope this branding themes.
  client_org_scope_id  CHAR(36)      NOT NULL,
  -- The portal accent colour, a hex token validated in the application against a `#RGB`/`#RRGGBB`
  -- allowlist regex. Not an ENUM so any valid hex is accepted, but a malformed value is a 400 before
  -- it reaches the engine. VARCHAR(7) backs the `#RRGGBB` longest form.
  accent_color         VARCHAR(7)    NOT NULL DEFAULT '#2563eb',
  -- The client-facing welcome heading. Nullable — a client may show the default (no heading). Bounded
  -- at the application layer to 200 characters; a VARCHAR of the same size backs it.
  welcome_heading      VARCHAR(200)  NULL,
  -- The client-facing welcome body text. Nullable — bounded at the application layer to 2000
  -- characters; a VARCHAR of the same size backs it.
  welcome_text         VARCHAR(2000) NULL,
  -- The member who last saved the branding — the service passes `context.userId`. Internal-only: it
  -- is never carried on the client projection. Editable (a later save by another manager moves it).
  updated_by           CHAR(36)      NOT NULL,
  created_at           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                     ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_portal_branding_org_id (organization_id, id),
  -- One row per client organization per studio. This is the upsert key: the repository writes
  -- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in place.
  UNIQUE KEY uq_portal_branding_org_client (organization_id, client_org_scope_id),
  CONSTRAINT fk_portal_branding_client_org_tenant
    FOREIGN KEY (organization_id, client_org_scope_id)
    REFERENCES client_organizations (organization_id, id),
  CONSTRAINT fk_portal_branding_updated_by
    FOREIGN KEY (updated_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A branding row's identity is pinned at the engine; its substance (accent_color, welcome_heading,
-- welcome_text) and its `updated_by` stamp may move. The trigger refuses an UPDATE that changes any
-- identity column — a direct SQL session bypasses the application layers, so the guarantee that
-- branding cannot be re-pointed at another client or tenant must hold at the engine too.
DELIMITER $$

CREATE TRIGGER trg_portal_branding_pin_identity
BEFORE UPDATE ON portal_branding FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id)
     OR NOT (NEW.organization_id <=> OLD.organization_id)
     OR NOT (NEW.client_org_scope_id <=> OLD.client_org_scope_id)
     OR NOT (NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'portal_branding identity columns are immutable';
  END IF;
END$$

DELIMITER ;
