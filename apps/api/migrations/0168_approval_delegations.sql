-- 0168_approval_delegations — an approver delegates their OWN approval authority to another member
-- for a time window (APR approvals, x300).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Approvals, 22-SCREEN APR approvals,
-- 12-PERMISSION-MATRIX (approval.decide / approval.read), 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC
-- §5-6 (scoped writes, composite (organization_id, id) foreign keys), 07-DATA-MODEL §9 (every
-- composite index begins with organization_id), ADR-0001 (MySQL has no row-level security; layers
-- 3-5 replace it).
--
-- ## What this migration is for
--
-- 0027_approvals shipped the approval record and its decide lifecycle. This slice records a
-- *delegation*: one `approval_delegations` row is the fact "this approver (the delegator) has named
-- another member (the delegate) to act on approvals on their behalf between starts_at and ends_at".
-- The delegator is always the acting member — the create route reads `context.membershipId`, never a
-- body field — so a member delegates only their own authority and can never record a delegation from
-- someone else. This slice records only; it does not modify the decide guard (the decide path reads
-- these rows read-side, a follow-up).
--
-- ## Migration number
--
-- The pass-25 queue map reserves 0168 for x300. The highest migration present on this slice's base
-- (origin/master) is lower; the intervening numbers are reserved by sibling pass-16..25 branches not
-- yet integrated. The migrator applies files in ascending numeric order and a gap is not an error (it
-- rejects only a NEW file numbered below an applied one), so 0168 on top of the current base is
-- correct. If the integration renumbers the reservations, the integrator renumbers this file with them.
--
-- ## Delegations are created and revoked, never edited
--
-- A delegation belongs to exactly one delegator in one tenant. The only writes are INSERT (delegate)
-- and DELETE (revoke): there is no UPDATE path in the repository and no UPDATE grant in
-- scripts/db/users.sql, so the withheld privilege is the control and no immutability trigger is
-- needed — the doc_bookmarks (0114) / home_pinned_items (0050) posture. A member changes a window by
-- revoking and re-creating.
--
-- ## Tenant-scoped, and a delegation can never reference another tenant's membership
--
-- Two composite foreign keys bind the row within one tenant: `(organization_id, delegator_membership_id)`
-- and `(organization_id, delegate_membership_id)` each to `memberships (organization_id, id)`. A
-- cross-tenant delegator or delegate id does not exist as a pair even when both ids exist individually,
-- which is the engine-level backstop behind the application's resolve-before-write 404.

CREATE TABLE approval_delegations (
  id                        CHAR(36)     NOT NULL,
  organization_id           CHAR(36)     NOT NULL,
  -- The approver delegating their own authority. Private to them: the list and the revoke are both
  -- scoped by delegator_membership_id = the acting context's membership, so a member never sees or
  -- revokes another member's delegations even inside the same tenant. The composite FK binds it to a
  -- membership of this same organization.
  delegator_membership_id   CHAR(36)     NOT NULL,
  -- The member who may act on the delegator's behalf during the window. Resolved active-and-in-tenant
  -- by the application before the insert; the composite FK is the engine-level backstop.
  delegate_membership_id    CHAR(36)     NOT NULL,
  -- The delegation window. The application refuses ends_at <= starts_at (400) before any insert.
  starts_at                 DATETIME(3)  NOT NULL,
  ends_at                   DATETIME(3)  NOT NULL,
  created_at                DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, the target of the composite FKs
  -- that bind child rows within one tenant (and the isolation corpus requires it).
  UNIQUE KEY uq_approval_delegations_org_id (organization_id, id),
  -- 07-DATA-MODEL §9: the one read that exists — a delegator's delegations, newest first, id breaking
  -- ties for a total order.
  KEY ix_approval_delegations_org_delegator (organization_id, delegator_membership_id, created_at, id),
  CONSTRAINT fk_approval_delegations_delegator_tenant
    FOREIGN KEY (organization_id, delegator_membership_id) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_approval_delegations_delegate_tenant
    FOREIGN KEY (organization_id, delegate_membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
