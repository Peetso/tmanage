-- 0317_work_item_client_audience — C25: which clients can see a client-facing task.
--
-- A work item's `audience` (`internal` / `client_visible` / `client_action_required`) decides
-- whether a client may see it at all. On a project shared with more than one client company,
-- the studio can now narrow a client-facing item to some of them ("Which clients can see
-- this?", Figma 529:30880).
--
-- ## No rows means every client of the project
--
-- An item with no rows here is seen by every client company the project is shared with, which
-- is exactly what every item written before this migration means — nothing existing changes.
-- One or more rows narrow it to those companies; a client of the project that is not listed
-- reads the item as absent (the same 404 an internal item gives). Moving an item back to
-- `internal` deletes its rows.
--
-- ## Tenant keys
--
-- Composite foreign keys on `(organization_id, …)`, like `project_clients`: a row can name
-- neither another tenant's work item nor another tenant's client company. The rows go with the
-- work item when the purge sweeper hard-deletes it (ON DELETE CASCADE), and with the client
-- company if that is ever erased.
--
-- MariaDB-safe (Hostinger): plain columns, composite keys, no generated column, no CHECK, no
-- functional index, no IF NOT EXISTS.

CREATE TABLE work_item_client_audience (
  organization_id        CHAR(36)     NOT NULL,
  work_item_id           CHAR(36)     NOT NULL,
  client_organization_id CHAR(36)     NOT NULL,
  created_at             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (organization_id, work_item_id, client_organization_id),
  -- The client read: "is this client company listed on this item".
  KEY ix_wica_client (organization_id, client_organization_id, work_item_id),
  CONSTRAINT fk_wica_work_item
    FOREIGN KEY (organization_id, work_item_id) REFERENCES work_items (organization_id, id)
    ON DELETE CASCADE,
  CONSTRAINT fk_wica_client_organization
    FOREIGN KEY (organization_id, client_organization_id)
    REFERENCES client_organizations (organization_id, id)
    ON DELETE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
