-- 0184_request_tags — free-text triage labels on a client request (x316, Requests module 11).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Requests, decisions & approvals
-- (triage metadata), 22-SCREEN §Request detail, 23-ERD-AND-STATE-MACHINES §2 (tenant-scoped,
-- parent-owned records), 07-DATA-MODEL §9 (composite indexes lead with organization_id),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC §6 (composite (organization_id, id) foreign keys),
-- ADR-0001 (MySQL has no row-level security; layers 3-5 replace it).
--
-- ## What this migration is for
--
-- 0006_client_requests shipped the request record; there was no way for staff to hang an ad-hoc
-- label on one and later list or filter by it. This is that taxonomy at its smallest useful size —
-- a free-text label added to and removed from a single request, many labels per request. It is the
-- Requests-module twin of the project / doc / file tag pattern, and is deliberately distinct from
-- `request_triage` (x265, one category + assignee per request): a tag is free text, many per
-- request, and never mutated in place.
--
-- ## One tenant table, free-text label carried on the row
--
-- Unlike the definition/assignment split `work_item_labels` (0105) uses, there is no reusable tag
-- object here: the label is the free text itself, stored on the assignment row. A request may carry
-- the same label only once — `uq_request_tags_label` is `(organization_id, client_request_id,
-- label)`, and the table's `utf8mb4_unicode_ci` collation makes that comparison case-insensitive, so
-- `Urgent` and `urgent` collide (a duplicate is the service's 409, or an idempotent no-op). Empty or
-- over-length labels never reach here — the service rejects them with a 400 before any insert.
--
-- ## Parent- and tenant-scoped
--
-- Every row belongs to one studio. `organization_id` scopes every row, and the composite foreign key
-- `fk_request_tags_request` binds `(organization_id, client_request_id)` to `client_requests
-- (organization_id, id)`: a cross-tenant request id is a non-existent pair rather than a leak — the
-- engine half of the trap the service also enforces in code (resolve the request tenant-scoped, a
-- foreign id is a 404 with no write). `created_by` records the member who added the tag.
--
-- ## Identity is immutable
--
-- `organization_id` is what a row *is*; moving it to another studio is not an edit. The
-- `BEFORE UPDATE` trigger holds that at the engine, the way `work_item_labels` (0105) does; ADR-0001
-- layers 3 and 4 are application-side and a direct SQL session bypasses both.

CREATE TABLE request_tags (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  client_request_id  CHAR(36)     NOT NULL,
  -- The free-text label. Compared case-insensitively by the table collation, so the uniqueness
  -- below dedups `Urgent`/`urgent`.
  label              VARCHAR(120) NOT NULL,
  -- The member (user) who added the tag.
  created_by         CHAR(36)     NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_request_tags_org_id (organization_id, id),
  -- One label per request, case-insensitively (the collation folds case).
  UNIQUE KEY uq_request_tags_label (organization_id, client_request_id, label),
  -- The index a request's chips are read by: this tenant's tags for one request.
  KEY ix_request_tags_request (organization_id, client_request_id, id),
  -- A tag can only ever name a request of its own tenant.
  CONSTRAINT fk_request_tags_request
    FOREIGN KEY (organization_id, client_request_id) REFERENCES client_requests (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A tag row's tenant is immutable, for the reason `work_item_labels`' trigger gives: moving it to
-- another studio would change what it is, silently.
DELIMITER $$

CREATE TRIGGER trg_request_tags_immutable
BEFORE UPDATE ON request_tags FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'request_tags.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
