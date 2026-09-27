-- 0167_request_comments — internal comment thread on a client request (module 11 Requests, x299).
--
-- Governing sources: 22-SCREEN-INVENTORY §REQ request detail, 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP
-- §Requests, 11-USER-STORIES §requests, 23-ERD-AND-STATE-MACHINES §2 (tenant-scoped, parent-owned
-- records), 07-DATA-MODEL §9 (index prefixes lead with `organization_id`),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §5-6 (composite tenant keys, scoped writes), ADR-0001
-- (MySQL has no row-level security; layers 3-5 replace it).
--
-- ## What this migration is for
--
-- REQ-001 built the studio's triage queue and, in x154, its overdue-to-triage aging view. This is
-- the working-notes half: an **internally-posted comment on a client request**, so the studio can
-- keep a threaded discussion alongside a request while triaging it. It is never projected to any
-- client or portal read path — the request's client submitted it, but the comments are the agency's
-- own notes about how to answer. Distinct from `project_update_comments` (0084), which hangs off a
-- published project update; this hangs off a `client_requests` row.
--
-- ## Parent- and tenant-scoped
--
-- A comment belongs to one client request of one studio. `organization_id` scopes it to the tenant,
-- the way every sibling table is scoped; the composite foreign key `fk_request_comments_request`
-- binds `(organization_id, request_id)` to `client_requests (organization_id, id)`, so a comment can
-- only ever name a request of its own tenant — a cross-tenant `request_id` does not exist as a pair
-- even when both ids exist individually. That is the engine half of the trap the service also
-- enforces in code: the request is resolved inside the acting tenant first, so a cross-tenant id is
-- a 404 with no write, and no client read path selects this table at all.
--
-- ## One level of reply
--
-- `parent_id` is a nullable self-reference: a top-level comment has `parent_id IS NULL`; a reply
-- names its parent. `fk_request_comments_parent` binds `(organization_id, parent_id)` to this table's
-- own `(organization_id, id)`, so a reply can only point at a comment of the same tenant. The service
-- resolves the parent within the same request and refuses a reply-to-a-reply (one level only), so a
-- malformed or cross-request `parentId` is a 400 with no insert. A NULL `parent_id` skips the FK,
-- which is the intended top-level case.
--
-- ## Append-only (INSERT + DELETE + SELECT, never UPDATE)
--
-- A comment is a record of what was said, when. It is inserted, read and — because a studio may
-- retract an internal note — deleted, but never edited: the runtime credential is granted INSERT and
-- DELETE and nothing else (see `scripts/db/users.sql`), and the `BEFORE UPDATE` trigger refuses any
-- amendment for every other credential besides, the immutable-content posture `work_item_comments`
-- (0053) and `project_update_comments` (0084) carry. Deleting a top-level comment deletes its replies
-- first, in the same transaction, so the RESTRICT self-reference is never violated.

CREATE TABLE request_comments (
  id                    CHAR(36)    NOT NULL,
  organization_id       CHAR(36)    NOT NULL,
  -- NOT NULL. A comment belongs to a client request; the composite key below makes a cross-tenant
  -- request_id a non-existent pair rather than a leak.
  request_id            CHAR(36)    NOT NULL,
  -- NULL for a top-level comment; a reply names its parent within the same request. The composite
  -- self-reference makes a cross-tenant parent_id a non-existent pair.
  parent_id             CHAR(36)    NULL,
  -- Free text. TEXT rather than VARCHAR because a comment is prose a person types, not a short
  -- handle (the choice `work_item_comments.body` made).
  body                  TEXT        NOT NULL,
  -- The internal member who posted the comment. Every row here is internal-authored and never
  -- surfaced to a client; the membership id ties the note to a studio member, as `work_item_comments`
  -- does. No foreign key, matching that sibling (0053).
  author_membership_id  CHAR(36)    NOT NULL,
  created_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, and the target of the
  -- self-reference below.
  UNIQUE KEY uq_request_comments_org_id (organization_id, id),
  -- 07-DATA-MODEL §9: the one read that exists — this tenant's comments for one request, in
  -- created-at (then id) order. Leads with `organization_id`.
  KEY ix_request_comments_request (organization_id, request_id, created_at, id),
  -- A comment can only ever name a request of its own tenant; the composite key is what makes a
  -- cross-tenant `request_id` a non-existent pair rather than a leak.
  CONSTRAINT fk_request_comments_request
    FOREIGN KEY (organization_id, request_id) REFERENCES client_requests (organization_id, id),
  -- A reply can only ever name a comment of its own tenant. RESTRICT (the default): the service
  -- deletes a comment's replies before the comment itself, so a parent is never orphaned nor blocked.
  CONSTRAINT fk_request_comments_parent
    FOREIGN KEY (organization_id, parent_id) REFERENCES request_comments (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A comment is append-only: once written it is neither re-parented, re-attributed nor edited. The
-- trigger holds that at the engine — ADR-0001 layers 3 and 4 are application-side and a direct SQL
-- session bypasses both — for the credentials that do hold UPDATE. The runtime credential holds none
-- (users.sql grants INSERT and DELETE only), so this is defence in depth, the `project_update_comments`
-- posture.
DELIMITER $$

CREATE TRIGGER trg_request_comments_immutable
BEFORE UPDATE ON request_comments FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'request_comments rows are append-only';
END$$

DELIMITER ;
