-- 0318_work_item_assignees — C26: more than one person on a task.
--
-- Peter (2026-11-08): a task names the people who do it, the people who supervise it and the
-- people who watch it. Watchers already exist (`work_item_watchers`, 0104). This table holds the
-- other two roles, one row per (item, member, role):
--
--   * `doer`       — does the work. `work_items.owner_user_id` stays the LEAD doer: whenever an
--                    item has doer rows, the owner is one of them; setting the doers sets the
--                    owner to the first one; clearing them clears the owner.
--   * `supervisor` — oversees the work and is told when it is marked done.
--
-- ## No rows means "the owner is the only doer"
--
-- An item with no doer rows reads its owner (if any) as its single doer, which is exactly what
-- every item written before this migration means, so no back-fill is needed and nothing
-- existing changes.
--
-- ## Tenant keys
--
-- Composite foreign keys on `(organization_id, …)`: a row can name neither another tenant's
-- work item nor another tenant's member. Rows go with the work item when the purge sweeper
-- hard-deletes it, and with the membership if it is ever erased (ON DELETE CASCADE).
--
-- MariaDB-safe (Hostinger): plain columns, composite keys, no generated column, no CHECK, no
-- functional index, no IF NOT EXISTS. `role` is a short varchar the service restricts to
-- `doer` / `supervisor`.

CREATE TABLE work_item_assignees (
  organization_id CHAR(36)     NOT NULL,
  work_item_id    CHAR(36)     NOT NULL,
  membership_id   CHAR(36)     NOT NULL,
  role            VARCHAR(16)  NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (organization_id, work_item_id, membership_id, role),
  -- "What am I doing / supervising": every item a member holds in a role.
  KEY ix_wia_member (organization_id, membership_id, role, work_item_id),
  CONSTRAINT fk_wia_work_item
    FOREIGN KEY (organization_id, work_item_id) REFERENCES work_items (organization_id, id)
    ON DELETE CASCADE,
  CONSTRAINT fk_wia_membership
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
    ON DELETE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
