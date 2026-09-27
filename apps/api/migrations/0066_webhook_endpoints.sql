-- 0066_webhook_endpoints — org-scoped outbound webhook endpoints (Automations, module 17, x166).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Automations ("webhooks"); audit
-- rank #2 (Automations Missing — webhooks); 07-DATA-MODEL §9 (index prefixes lead with
-- `organization_id`); 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## Migration number
--
-- Pass 21 reserves 0060–0080 in slice-id order; x166's reservation is 0066 (pass21-queue header).
-- The highest migration present on this slice's base (master bcfe397) is 0052; 0053–0065 are
-- reserved by sibling pass-21 branches not yet integrated, so 0066 sits above every reservation.
-- The migrator applies files in ascending numeric order and a gap is not an error (it rejects only a
-- NEW file numbered *below* an applied one), so 0066 on top of 0052 is correct on this base. If the
-- integration renumbers the reservations, the integrator renumbers this file with them; nothing here
-- depends on the literal 0066 beyond the filename.
--
-- ## What this migration is for
--
-- The Automations module has no outbound webhook configuration. This adds the smallest useful unit:
-- an **org-scoped webhook endpoint** — a target URL, the single event kind it subscribes to, and a
-- hash of the signing secret. This slice **registers and validates** endpoints only; actual delivery
-- and retry to third parties is a later slice (external egress + retry infra, Needs-Peter).
--
-- ## SSRF / egress boundary
--
-- The URL is validated at write time by the application (`url-guard.ts`): https only, a public host,
-- and never localhost / a private / link-local / loopback / metadata address. A rejected URL is a
-- 400 with no row written, so a stored endpoint is always one the register already judged safe to
-- reach. The column stores whatever the guard passed; it does not itself re-derive the rule.
--
-- ## The signing secret is stored as a hash, never plaintext
--
-- `secret_hash` is the SHA-256 (hex, 64 chars) of the signing secret the caller supplied. The
-- plaintext is never stored and never echoed back on any read — the register keeps only what a
-- future delivery slice needs to *sign*, which is the digest, exactly as the invitation and recovery
-- tokens store a hash and never the token.
--
-- ## Only `enabled` is mutable
--
-- A PATCH toggles `enabled` (disable a noisy endpoint, re-enable it). Everything else — the tenant,
-- the URL, the event kind, the secret hash, the creation instant — is what an endpoint *is*, held
-- immutable at the engine by the `BEFORE UPDATE` trigger, the reason every other identity trigger in
-- this schema exists (ADR-0001 layers 3 and 4 are application-side and a direct SQL session bypasses
-- both). This slice grants the app INSERT and UPDATE (no DELETE): an endpoint is created, toggled and
-- read, never removed by a runtime credential — a delete surface is a later slice with its own grant.

CREATE TABLE webhook_endpoints (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The https target the register would POST to. Validated by the application at write time
  -- (`url-guard.ts`); stored whole.
  url             VARCHAR(2048) NOT NULL,
  -- The single allowlisted event kind this endpoint subscribes to. The allowlist is the
  -- application's (`WEBHOOK_EVENT_KINDS`); an off-list value is a 400 before any write.
  event_kind      VARCHAR(64)  NOT NULL,
  -- SHA-256 (hex) of the signing secret. The plaintext is never stored and never returned.
  secret_hash     CHAR(64)     NOT NULL,
  -- Whether the endpoint is active. The only column a PATCH may change.
  enabled         BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by      CHAR(36)     NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_webhook_endpoints_org_id (organization_id, id),
  -- The index a tenant's endpoints are listed by: this organization's endpoints, newest first.
  -- Leads with `organization_id` per 07-DATA-MODEL §9.
  KEY ix_webhook_endpoints_org_created (organization_id, created_at, id),
  CONSTRAINT fk_webhook_endpoints_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The actor. References users (id) without organization_id because a user is not tenant-owned —
  -- the same shape `work_forms.created_by` (0052) uses.
  CONSTRAINT fk_webhook_endpoints_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Everything but `enabled` is immutable: an endpoint's tenant, URL, event kind, secret hash, author
-- and creation instant are what it is. The `BEFORE UPDATE` trigger pins them at the engine so a
-- runtime credential (or any direct session) can toggle `enabled` and nothing else — the reason
-- `work_forms`/`decisions` carry their own triggers.
DELIMITER $$

CREATE TRIGGER trg_webhook_endpoints_pin_columns
BEFORE UPDATE ON webhook_endpoints FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'webhook_endpoints.organization_id is immutable';
  END IF;
  IF NEW.url <> OLD.url THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'webhook_endpoints.url is immutable';
  END IF;
  IF NEW.event_kind <> OLD.event_kind THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'webhook_endpoints.event_kind is immutable';
  END IF;
  IF NEW.secret_hash <> OLD.secret_hash THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'webhook_endpoints.secret_hash is immutable';
  END IF;
  IF NEW.created_by <> OLD.created_by THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'webhook_endpoints.created_by is immutable';
  END IF;
  IF NEW.created_at <> OLD.created_at THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'webhook_endpoints.created_at is immutable';
  END IF;
END$$

DELIMITER ;
