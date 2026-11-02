-- 0312_inbound_email — 54-12 inbound e-mail core and 54-12a attachment metadata (R21-f).
--
-- Governing sources: 54-FEATURE-GAPS-PLATFORM-ECOSYSTEM.md "4.10 54-12" (data model 0256) and
-- "14.1 54-12a" (data model 0278), folded into one migration here; 56-06 (the file-safety rule the
-- attachment states follow); 25-AUTHORIZATION-AND-TENANT-ISOLATION §5-7 (composite tenant keys).
--
-- ## What changes
--
-- * `inbound_email_addresses` (NEW, tenant): an organization's request address. `local_part` is
--   `requests+<slug>-<6>` and globally unique, because the mail arrives before any tenant is known:
--   the ingest resolves it on `bootstrapRead(['inbound_email_addresses'])` (reason
--   `inbound_email_address_lookup`) and runs everything after under the address's organization.
--   `status` is active | rotated (application-checked); a rotated row stays, so old mail to it is
--   recognised and dropped rather than unknown. `policy_json` holds the per-address policy.
-- * `inbound_emails` (NEW, tenant): one row per accepted message. `message_id_hash` is the SHA-256
--   of the Message-ID (or of from+date+subject), unique per organization, so a re-delivery is a
--   duplicate and never a second row. `auth_result` is pass | fail | none | unknown (DMARC from
--   Authentication-Results). `outcome` is client_request | held. `trusted_by/at` are set once when
--   a person trusts a held mail.
-- * `inbound_email_attachments` (NEW, tenant): attachment METADATA only — no bytes are stored by
--   this slice. `state` is waiting_trust | too_large | blocked_type | scanning (later: clean,
--   infected, imported), application-checked.
--
-- No DELETE grant on any of the three: the inbound log is evidence.
--
-- MariaDB-safe: VARCHAR not ENUM, no CHECK, no generated columns, no functional or descending
-- index parts, no IF NOT EXISTS; the triggers use `<=>` so a NULL compares as a value.

CREATE TABLE inbound_email_addresses (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  local_part         VARCHAR(64)  NOT NULL,
  -- active | rotated (application-checked).
  status             VARCHAR(16)  NOT NULL DEFAULT 'active',
  default_project_id CHAR(36)     NULL,
  policy_json        TEXT         NOT NULL,
  created_at         DATETIME(3)  NOT NULL,
  rotated_at         DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_iea_org_id (organization_id, id),
  UNIQUE KEY uq_iea_local (local_part),
  CONSTRAINT fk_iea_default_project_tenant
    FOREIGN KEY (organization_id, default_project_id) REFERENCES projects (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE inbound_emails (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  address_id         CHAR(36)     NOT NULL,
  message_id_hash    CHAR(64)     NOT NULL,
  from_email         VARCHAR(320) NOT NULL,
  subject            VARCHAR(500) NULL,
  body_text          TEXT         NULL,
  -- pass | fail | none | unknown (application-checked).
  auth_result        VARCHAR(16)  NOT NULL DEFAULT 'unknown',
  -- client_request | held (application-checked); the held reason is kept in `outcome_reason`.
  outcome            VARCHAR(32)  NOT NULL,
  outcome_reason     VARCHAR(32)  NULL,
  linked_object_type VARCHAR(32)  NULL,
  linked_object_id   CHAR(36)     NULL,
  -- Attachments past the cap of five, counted, never stored.
  dropped_attachments INT UNSIGNED NOT NULL DEFAULT 0,
  trusted_by         CHAR(36)     NULL,
  trusted_at         DATETIME(3)  NULL,
  received_at        DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ie2_org_id (organization_id, id),
  UNIQUE KEY uq_ie2_msgid (organization_id, message_id_hash),
  KEY ix_ie2_org_received (organization_id, received_at),
  CONSTRAINT fk_ie2_address_tenant
    FOREIGN KEY (organization_id, address_id) REFERENCES inbound_email_addresses (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE inbound_email_attachments (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  inbound_email_id CHAR(36)     NOT NULL,
  name             VARCHAR(255) NOT NULL,
  size_bytes       INT UNSIGNED NOT NULL,
  declared_type    VARCHAR(127) NULL,
  detected_type    VARCHAR(127) NULL,
  sha256           CHAR(64)     NULL,
  -- waiting_trust | too_large | blocked_type | scanning | clean | infected | imported.
  state            VARCHAR(24)  NOT NULL,
  scan_status      VARCHAR(16)  NULL,
  scan_signature   VARCHAR(120) NULL,
  file_asset_id    CHAR(36)     NULL,
  created_at       DATETIME(3)  NOT NULL,
  updated_at       DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_iea2_org_id (organization_id, id),
  KEY ix_iea2_mail (organization_id, inbound_email_id),
  CONSTRAINT fk_iea2_mail_tenant
    FOREIGN KEY (organization_id, inbound_email_id) REFERENCES inbound_emails (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

CREATE TRIGGER trg_iea_org_immutable
BEFORE UPDATE ON inbound_email_addresses FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id)
     OR NOT (NEW.local_part <=> OLD.local_part) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'inbound_email_addresses.organization_id and local_part are immutable';
  END IF;
END$$

CREATE TRIGGER trg_ie2_org_immutable
BEFORE UPDATE ON inbound_emails FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id)
     OR NOT (NEW.message_id_hash <=> OLD.message_id_hash)
     OR NOT (NEW.from_email <=> OLD.from_email) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'inbound_emails.organization_id, message_id_hash and from_email are immutable';
  END IF;
END$$

CREATE TRIGGER trg_iea2_org_immutable
BEFORE UPDATE ON inbound_email_attachments FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id)
     OR NOT (NEW.inbound_email_id <=> OLD.inbound_email_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'inbound_email_attachments.organization_id and inbound_email_id are immutable';
  END IF;
END$$

DELIMITER ;
