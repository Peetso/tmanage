-- 0230_workflow_due_soon_fires — the "work item due in N days" automation trigger (C1, AUT-03).
--
-- A rule with trigger `work_item_due_soon` is fired by the worker's due-soon sweep
-- (`--sweep-due-soon`), not by an outbox event: nothing *happens* when a due date comes closer.
-- The sweep may run many times a day, so each firing claims one row here first. The unique key
-- `(organization_id, template_id, work_item_id, fire_date)` makes the claim the idempotency: a
-- second sweep on the same day inserts nothing (`INSERT IGNORE`, 0 rows) and the rule does not
-- run again for that item until the next day. `fire_date` is the database's `CURRENT_DATE`.
--
-- Org-scoped like every tenant table: `(organization_id, id)` unique key, and both references go
-- through the composite tenant keys so a claim can never point at another studio's rule or item.
-- Written only by the worker (INSERT; SELECT to read where it writes). No UPDATE, no DELETE.
--
-- MariaDB-safe: plain columns, no CHECK, no generated column, no JSON default.

CREATE TABLE workflow_due_soon_fires (
  id              CHAR(36)    NOT NULL,
  organization_id CHAR(36)    NOT NULL,
  template_id     CHAR(36)    NOT NULL,
  work_item_id    CHAR(36)    NOT NULL,
  fire_date       DATE        NOT NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_workflow_due_soon_fires_org_id (organization_id, id),
  UNIQUE KEY uq_workflow_due_soon_fires_claim (organization_id, template_id, work_item_id, fire_date),
  KEY ix_workflow_due_soon_fires_item (organization_id, work_item_id),
  CONSTRAINT fk_workflow_due_soon_fires_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_workflow_due_soon_fires_template
    FOREIGN KEY (organization_id, template_id) REFERENCES workflow_templates (organization_id, id),
  CONSTRAINT fk_workflow_due_soon_fires_work_item
    FOREIGN KEY (organization_id, work_item_id) REFERENCES work_items (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
