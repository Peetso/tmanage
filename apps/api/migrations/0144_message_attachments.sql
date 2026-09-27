-- 0144_message_attachments — link an already-uploaded file to a chat message (CH-06 "Composer":
-- attachments), and list a message's attachments.
--
-- Governing sources: 22-SCREEN-BY-SCREEN-SPEC CH-06 (the composer's attachments); 12-PERMISSION-
-- MATRIX §2 (chat is internal-only — no client role holds a conversation capability); 25-AUTH-AND-
-- TENANT-ISOLATION §6 (composite tenant keys `(organization_id, id)` on every tenant table);
-- 07-DATA-MODEL §9 (index prefixes lead with `organization_id`); ADR-0001 (MySQL has no row-level
-- security; the withheld privilege and the tenant/owner predicates are the control).
--
-- ## Migration number
--
-- Pass 24 reserves 0118-0144 in slice-id order; x275's reservation is 0144 (pass24-queue header).
-- The migrator applies files in ascending numeric order; nothing in the code depends on the literal
-- number beyond the filename, and the integrator renumbers if it moves.
--
-- ## What this is
--
-- One row means "this file is attached to this message". There is no upload here: the file already
-- exists in `file_assets` (reused read-only), and this table only links it. Distinct from
-- `work_item_files` (which links a file to a work item) and from `file_assets.object_id` (which
-- names the row a file was uploaded *for*): a message attachment is a reference a message author
-- adds after the fact.
--
-- The row is bound to this same tenant twice over — the composite FK to `messages` binds the
-- message, the composite FK to `file_assets` binds the file — so a cross-tenant `message_id` or
-- `file_asset_id` has no referenced row and the insert fails closed rather than linking a foreign
-- row. `attached_by_membership_id` records who attached it: only the message author may attach or
-- detach (the service's 403), and this is the audit trail of that.
--
-- ## Grants and immutability
--
-- The runtime credential is granted INSERT and DELETE and **no UPDATE**: an attachment is created
-- (attach) and deleted (detach), never edited — the withheld UPDATE privilege is the control that
-- keeps a row's identity fixed (the `message_bookmarks`/`home_pinned_items` posture), so no
-- immutability trigger is needed because no credential may UPDATE the table at all.

CREATE TABLE message_attachments (
  id                        CHAR(36)    NOT NULL,
  organization_id           CHAR(36)    NOT NULL,
  -- The message the file is attached to. The composite FK below binds it to a message of this same
  -- tenant, so a cross-tenant id resolves to no row and the insert fails rather than linking.
  message_id                CHAR(36)    NOT NULL,
  -- The already-uploaded file. The composite FK binds it to a file of this same tenant; the service
  -- additionally refuses a file that is not `ready` before it ever reaches this insert.
  file_asset_id             CHAR(36)    NOT NULL,
  -- The membership that attached the file — the message author (the service refuses anyone else with
  -- 403). Kept as the audit trail of who linked what.
  attached_by_membership_id CHAR(36)    NOT NULL,
  created_at                DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The composite key every tenant-owned table carries (25-AUTH §6), so a future child can
  -- reference this row without a cross-tenant path and the isolation corpus is satisfied.
  UNIQUE KEY uq_message_attachments_org_id (organization_id, id),
  -- One link per (message, file): attaching the same file to the same message twice collides here
  -- rather than creating a second row, which is what makes the attach idempotent.
  UNIQUE KEY uq_message_attachments_message_file (organization_id, message_id, file_asset_id),
  -- 07-DATA-MODEL §9: the one read that exists — a message's attachments, oldest first, id breaking
  -- ties for a total order.
  KEY ix_message_attachments_org_message (organization_id, message_id, created_at, id),
  CONSTRAINT fk_message_attachments_message_tenant
    FOREIGN KEY (organization_id, message_id) REFERENCES messages (organization_id, id),
  CONSTRAINT fk_message_attachments_file_tenant
    FOREIGN KEY (organization_id, file_asset_id) REFERENCES file_assets (organization_id, id),
  CONSTRAINT fk_message_attachments_membership_tenant
    FOREIGN KEY (organization_id, attached_by_membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
