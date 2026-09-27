-- 0097_webhook_deliveries — org-scoped record of webhook delivery attempts (Automations, module 17,
-- x221). The read/history surface for the endpoints registered by x166 (0066).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Automations & integrations
-- ("webhooks"); audit rank #2 (Automations Missing — webhooks); 07-DATA-MODEL §9 (index prefixes
-- lead with `organization_id`); 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## Migration number
--
-- Pass 23 reserves 0094–0117 in slice-id order; x221's reservation is 0097 (pass23-queue header
-- map). The highest migration present on this slice's base (master 174cf4f, after pass 22) is 0093;
-- 0094–0096 are sibling pass-23 branches (x216/x217/x218) not yet integrated, so 0097 sits above
-- every reservation. The migrator applies files in ascending numeric order and a gap is not an error
-- (it rejects only a NEW file numbered *below* an applied one), so 0097 on top of 0093 is correct on
-- this base. If the integration renumbers the reservations, the integrator renumbers this file with
-- them; nothing here depends on the literal 0097 beyond the filename.
--
-- ## What this migration is for
--
-- The Automations webhooks slice (x166) registers, lists and toggles endpoints but keeps no record
-- of what was delivered to them. This adds the smallest useful unit: an **org-scoped delivery
-- attempt** — which endpoint it targeted, the outcome status, the HTTP response code (when a response
-- was received), and when it was attempted. It is the read/history surface an operator uses to see
-- whether an endpoint is healthy.
--
-- ## No secret, no body — status and code only
--
-- A delivery row records **only** the outcome: a `status` token (the application allowlist), an
-- optional numeric `response_code`, and the attempt instant. It deliberately stores neither the
-- endpoint's signing secret nor the request/response body, so a delivery record cannot leak the
-- secret or payload content the way a full transcript would. The signing secret lives (hashed) on
-- `webhook_endpoints` and is never copied here.
--
-- ## Append-only — INSERT, then read; never UPDATE, never DELETE
--
-- A delivery attempt is a fact about the past: once recorded it is immutable, exactly like
-- `audit_events`. Immutability is enforced by *withholding the grant* — the runtime credential is
-- granted INSERT and the database-wide SELECT and nothing else (`scripts/db/users.sql`), so no
-- UPDATE or DELETE statement can run against this table under the app user. No column-pinning trigger
-- is needed (that pattern exists for tables that *do* grant UPDATE, e.g. `webhook_endpoints`); with
-- no UPDATE/DELETE grant there is nothing to pin.

CREATE TABLE webhook_deliveries (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The endpoint this attempt targeted. The composite FK below keys it to a same-tenant endpoint, so
  -- a delivery row can never reference another studio's endpoint.
  endpoint_id     CHAR(36)     NOT NULL,
  -- The outcome. The allowlist is the application's (`WEBHOOK_DELIVERY_STATUSES`); an off-list value
  -- is a 400 before any write. Kept in code (not a MySQL `ENUM`) so the set can grow without an
  -- `ALTER TABLE`, the same division `webhook_endpoints.event_kind` uses.
  status          VARCHAR(32)  NOT NULL,
  -- The HTTP status code the target answered with, when a response was received. NULL when the
  -- attempt never reached a response (a connection error / timeout). A code, never a body.
  response_code   SMALLINT UNSIGNED NULL,
  -- When the attempt was made. Server clock, immutable.
  attempted_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries.
  UNIQUE KEY uq_webhook_deliveries_org_id (organization_id, id),
  -- The index a tenant's attempts are listed by: this organization's attempts for one endpoint, most
  -- recent first. `id` is UUIDv7 (≈ creation order), so leading with (organization_id, endpoint_id)
  -- and ordering by `id DESC` is a newest-first keyset scan. Leads with `organization_id` per
  -- 07-DATA-MODEL §9.
  KEY ix_webhook_deliveries_org_endpoint (organization_id, endpoint_id, id),
  CONSTRAINT fk_webhook_deliveries_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The endpoint, keyed by the tenant-composite unique so the reference can never cross a tenant
  -- boundary (25-AUTHORIZATION-AND-TENANT-ISOLATION §6).
  CONSTRAINT fk_webhook_deliveries_endpoint
    FOREIGN KEY (organization_id, endpoint_id) REFERENCES webhook_endpoints (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
