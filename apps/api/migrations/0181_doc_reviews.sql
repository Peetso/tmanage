-- 0181_doc_reviews — a review request and decision on a document (Docs review workflow, x313 slice).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Docs and knowledge" (review/approval),
-- 11-USER-STORIES §"Doc review", 07-DATA-MODEL §9 (index prefixes lead with `organization_id`),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- A document (0030) can be read, versioned (0036) and discussed (0045_document_comments), but there
-- is no way to *ask a named person to sign off* on it. This is the smallest useful unit of the
-- deferred "review/approval": an author requests a review from a reviewer, and the reviewer either
-- approves or requests changes with a note. It is an in-app record only — no email, no notification
-- fan-out this slice. It is distinct from `document_comments` (x132, free prose) and
-- `document_versions` (x112, the content trail): this table is the *decision* on a document.
--
-- ## Document-owned, and tenant-scoped like every sibling
--
-- `doc_reviews.document_id` is `NOT NULL`: a review belongs to a document, the way a comment (0045)
-- does. The review is read and written by the document's relation (its project), resolved in the
-- service, so the two can never disagree — there is no `project_id` column to drift. The composite
-- foreign key `fk_doc_reviews_document_tenant` binds `(organization_id, document_id)` to `documents`,
-- so a review can only ever name a document of its own tenant — a cross-tenant document id does not
-- exist as a pair even when both ids exist individually.
--
-- ## The requester is a membership; the reviewer is a member's user id
--
-- `requested_by` names the membership the request was made under, bound by the composite key
-- `fk_doc_reviews_requested_by_tenant` to `(organization_id, id)` of `memberships`. `reviewer_user_id`
-- names the person asked to review, bound by `fk_doc_reviews_reviewer_tenant` to
-- `(organization_id, user_id)` of `memberships` (the `uq_memberships_org_user` key): a reviewer is
-- always a member of the review's own tenant, never a bare user id with no standing in this studio.
-- Self-review (the requester's own user is the reviewer) is permitted — no constraint forbids it.
--
-- ## State and its one transition
--
-- `state` is `pending` at creation. A decision sets it to `approved` or `changes_requested` and
-- stamps `decided_at` once; the decision is immutable afterwards (the application refuses a re-decide
-- with 409, and `decided_at IS NOT NULL` is the record of "already decided"). `note` is optional on a
-- request and on an `approved` decision, and required on a `changes_requested` decision — the
-- application enforces the last rule, which SQL cannot express as a column constraint. No immutability
-- trigger: unlike `document_comments`, this row is *meant* to be updated exactly once, on decision.

CREATE TABLE doc_reviews (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  document_id      CHAR(36)     NOT NULL,
  -- The membership the review was requested under; see the note above.
  requested_by     CHAR(36)     NOT NULL,
  -- The user asked to review; a member of this tenant (composite FK below).
  reviewer_user_id CHAR(36)     NOT NULL,
  -- pending at creation; a decision moves it to approved / changes_requested, once.
  state            ENUM('pending','approved','changes_requested') NOT NULL DEFAULT 'pending',
  -- Optional on request/approve; required by the application on a changes_requested decision.
  note             TEXT         NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- NULL while pending; stamped once on decision.
  decided_at       DATETIME(3)  NULL,
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_doc_reviews_org_id (organization_id, id),
  -- The index a document's reviews are listed by: this tenant's reviews for this document, in
  -- id (≈ creation) order. Leads with `organization_id` per `07-DATA-MODEL` §9.
  KEY ix_doc_reviews_org_document (organization_id, document_id, id),
  -- Backing index for the reviewer FK, leading with organization_id.
  KEY ix_doc_reviews_org_reviewer (organization_id, reviewer_user_id),
  CONSTRAINT fk_doc_reviews_document_tenant
    FOREIGN KEY (organization_id, document_id) REFERENCES documents (organization_id, id),
  CONSTRAINT fk_doc_reviews_requested_by_tenant
    FOREIGN KEY (organization_id, requested_by) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_doc_reviews_reviewer_tenant
    FOREIGN KEY (organization_id, reviewer_user_id) REFERENCES memberships (organization_id, user_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
