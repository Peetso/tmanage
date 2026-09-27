-- 0195_org_branding — ADM: org-wide branding for the internal app chrome (module 18, x327).
--
-- Governing sources: 38-MODULE-MAP §Administration (org identity), 22-SCREEN §Administration settings,
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys), 07-DATA-MODEL §9 (index prefixes
-- lead with `organization_id`).
--
-- ## What this is, and what it is not
--
-- An org admin sets org-wide branding — the display product name, an accent colour, and a short logo
-- text / initials — applied to the *internal* app chrome; any member reads it to render the shell.
-- Text and colour only: there is no file upload this slice. One row per organization, keyed
-- `(organization_id)`.
--
-- Distinct from `portal_settings` (x238), which is per-project and client-facing, and from
-- `org_settings` (behaviour flags): this is org-wide *internal* chrome. Every column is a presentation
-- field except `updated_by`, the internal stamp of which member last saved the branding.
--
-- ## One row per org, and absence is a default
--
-- The upsert key is `(organization_id)`: the read/upsert repository writes
-- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in place rather than
-- creating a second row. The read path returns code-level defaults when no row exists at all, so
-- "never configured" and "saved the defaults" are one behaviour (the `portal_settings` posture).
--
-- ## Org-owned, and tenant-scoped like every sibling
--
-- The composite foreign key `fk_org_branding_org_tenant` binds `(organization_id, id)` — well, binds
-- `organization_id` to `organizations` — so a branding row can only ever name an organization that
-- exists. `accent_color` is a hex token validated by an allowlist regex in the application (`#RGB` /
-- `#RRGGBB`); a value outside that shape is refused (400) before it reaches the engine, so the chrome
-- accent cannot be pointed at an arbitrary string. `product_name` and `logo_text` are nullable and
-- bounded at the application layer to the VARCHAR widths here.
--
-- ## What may move
--
-- The branding substance — `product_name`, `accent_color`, `logo_text` — and the `updated_by` stamp
-- are editable (a save is a replace). Identity — `id`, `organization_id`, `created_at` — is not. The
-- `BEFORE UPDATE` trigger pins the identity columns at the engine, so a direct SQL session cannot
-- re-point a branding row at another tenant.

CREATE TABLE org_branding (
  id                 CHAR(36)      NOT NULL,
  organization_id    CHAR(36)      NOT NULL,
  -- The display product name shown in the internal app chrome. Nullable — a studio may show the
  -- default. Bounded at the application layer to 120 characters; a VARCHAR of the same size backs it.
  product_name       VARCHAR(120)  NULL,
  -- The chrome accent colour, a hex token validated by an allowlist regex (`#RGB`/`#RRGGBB`) in the
  -- application. Not an ENUM so the palette can grow without a schema change, but the write is refused
  -- for a value outside the regex before it reaches the engine.
  accent_color       VARCHAR(7)    NOT NULL DEFAULT '#2563eb',
  -- A short logo label or set of initials shown in the chrome. Nullable; bounded to 48 characters.
  logo_text          VARCHAR(48)   NULL,
  -- The member who last saved the branding — the service passes `context.userId`. Editable (a later
  -- save by another admin moves it).
  updated_by         CHAR(36)      NOT NULL,
  created_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                   ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_org_branding_org_id (organization_id, id),
  -- One row per studio. This is the upsert key: the repository writes
  -- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in place.
  UNIQUE KEY uq_org_branding_org (organization_id),
  CONSTRAINT fk_org_branding_org_tenant
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_org_branding_updated_by
    FOREIGN KEY (updated_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A branding row's identity is pinned at the engine; its substance (product_name, accent_color,
-- logo_text) and its `updated_by` stamp may move. The trigger refuses an UPDATE that changes any
-- identity column — a direct SQL session bypasses the application layers, so the guarantee that
-- branding cannot be re-pointed at another tenant must hold at the engine too.
DELIMITER $$

CREATE TRIGGER trg_org_branding_pin_identity
BEFORE UPDATE ON org_branding FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id)
     OR NOT (NEW.organization_id <=> OLD.organization_id)
     OR NOT (NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'org_branding identity columns are immutable';
  END IF;
END$$

DELIMITER ;
