-- 0062_marketing_leads — the public site's contact / lead intake (Public site module 1, x161).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Public site ("contact"); audit
-- rank #1 (Public site Missing — no contact door); 25-AUTHORIZATION-AND-TENANT-ISOLATION §2
-- (untrusted input is bounded and never trusted). This is the module's only *unauthenticated
-- write* endpoint, so the boundary discipline is in the controller; the table only holds what a
-- submitted lead is at rest.
--
-- ## Migration number
--
-- Pass 21 reserves 0060–0080 in slice-id order; x161's reservation is 0062 (NEXT-SCOPES-13 header).
-- The highest migration present on this slice's base (master bcfe397) is 0052; 0053–0061 are
-- reserved by earlier passes / sibling pass-21 branches not yet integrated, so 0062 sits above
-- every reservation on this base. The migrator applies files in ascending numeric order and a gap
-- is not an error (it rejects only a NEW file numbered *below* an applied one), so 0062 on top of
-- 0052 is correct here. Nothing depends on the literal 0062 beyond the filename; if the
-- integration renumbers the reservations it renumbers this file with them.
--
-- ## GLOBAL, org-less
--
-- A marketing lead is submitted by a member of the public who has no session and belongs to no
-- organization, so there is no `organization_id` and no tenant composite key: this is a genuinely
-- global table, the same class as `users` / `authentication_events`. It is therefore registered in
-- the tenant guard's `NON_TENANT_TABLES` (not `TENANT_TABLES`), which is what lets the repository
-- reach it from the identity (no-tenant) path; `tenant-isolation.db.test.ts` holds every table to
-- exactly one of the two registries.
--
-- ## Write-only door
--
-- The application grant is INSERT only (no UPDATE, no DELETE, no read path at runtime): a lead is
-- created and never edited or removed by a runtime credential, and there is deliberately no listing
-- or read endpoint in this slice (email delivery of leads is Needs-Peter — an external mail
-- provider — and a later admin viewer is its own slice with its own grant). Every field is bounded
-- at the column as a second line after the controller's validation.

CREATE TABLE marketing_leads (
  id         CHAR(36)      NOT NULL,
  -- The submitter's name. Bounded at the column; the controller rejects empty / over-length first.
  name       VARCHAR(200)  NOT NULL,
  -- The submitter's email. `254` is the RFC 5321 maximum, as `users.email`.
  email      VARCHAR(254)  NOT NULL,
  -- The message body. Bounded so an over-length body is a 400 at the controller and a hard cap here.
  message    VARCHAR(4000) NOT NULL,
  -- Where the lead came from (the contact form today; a fixed handle so a future channel is a value,
  -- not a schema change). Never derived from untrusted input beyond a bounded allowlist.
  source     VARCHAR(100)  NOT NULL,
  created_at DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The order an admin tool would read leads in when one is built (newest first); leads with the
  -- same instant are tie-broken by id. No tenant prefix — this table has no tenant.
  KEY ix_marketing_leads_created_at (created_at, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
