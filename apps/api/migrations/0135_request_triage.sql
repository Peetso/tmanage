-- 0135_request_triage — internal triage metadata for a client request (REQ-02 request triage, x265).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Requests" (intake / triage),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC §5-6 (scoped writes, composite (organization_id, id)
-- foreign keys), 07-DATA-MODEL §9 (every composite index begins with organization_id), ADR-0001
-- (MySQL has no row-level security; layers 3-5 replace it).
--
-- ## What this migration is for
--
-- 0006_client_requests shipped the request record and its lifecycle. This slice adds the studio's
-- internal triage step *before* commitment: one `request_triage` row is the fact "this studio filed
-- this request under category C and assigned it to member M". It is internal-only — never part of the
-- client-facing projection (0035) — and adds nothing to what the client sees.
--
-- ## One triage row per request, upserted; re-triaging overwrites
--
-- The only writes are INSERT and UPDATE, both through a single `INSERT ... ON DUPLICATE KEY UPDATE`
-- against `uq_request_triage_org_request`: re-triaging a request updates its category and assignee in
-- place rather than adding a second row. There is no DELETE grant in scripts/db/users.sql — the
-- withheld privilege is the control (the home_widget_prefs / doc_bookmarks posture); a request is
-- never "un-triaged", it is re-triaged. `category` is validated against a fixed allowlist in the
-- application (request-triage.controller.ts) before the write; a value outside it is a 400 and nothing
-- is stored.
--
-- ## Tenant-scoped, and a triage row can never point at another tenant's request or member
--
-- Two composite foreign keys bind the row within one tenant: `(organization_id, request_id)` to
-- `client_requests (organization_id, id)` and, when an assignee is named, `(organization_id,
-- assignee_membership_id)` to `memberships (organization_id, id)`. `assignee_membership_id` is
-- nullable — MATCH SIMPLE skips the constraint while it is NULL, so "unassigned" is representable —
-- and a cross-tenant request id or membership id does not exist as a pair even when both ids exist
-- individually.

CREATE TABLE request_triage (
  id                     CHAR(36)      NOT NULL,
  organization_id        CHAR(36)      NOT NULL,
  -- The client request this triage belongs to. NOT NULL; the composite FK below binds it to the tenant.
  request_id             CHAR(36)      NOT NULL,
  -- The bucket the studio filed the request under. Validated against a fixed allowlist in the
  -- application before the write; the column width holds the vocabulary with room to widen it.
  category               VARCHAR(64)   NOT NULL,
  -- The internal member the request is assigned to, or NULL while it is unassigned. The composite FK
  -- below binds a non-NULL value to a membership in this same tenant.
  assignee_membership_id CHAR(36)      NULL,
  created_at             DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_request_triage_org_id (organization_id, id),
  -- The upsert key: one triage row per request per studio. A second triage of the same request
  -- collides here and updates in place rather than creating a duplicate. Leads with organization_id
  -- per 07-DATA-MODEL §9.
  UNIQUE KEY uq_request_triage_org_request (organization_id, request_id),
  -- 07-DATA-MODEL §9: "what is assigned to this member", org-first for a total order.
  KEY ix_request_triage_org_assignee (organization_id, assignee_membership_id, request_id),
  CONSTRAINT fk_request_triage_request_tenant
    FOREIGN KEY (organization_id, request_id) REFERENCES client_requests (organization_id, id),
  CONSTRAINT fk_request_triage_assignee_tenant
    FOREIGN KEY (organization_id, assignee_membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
