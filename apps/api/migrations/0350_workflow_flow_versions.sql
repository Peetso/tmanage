-- 0350_workflow_flow_versions — the branching automation rule (58-C1).
--
-- `workflow_flow_versions` (TENANT): one immutable row per save of a rule's builder graph
-- ("When > If > Yes/No > Then"). `version` counts 1, 2, 3 … per rule; the highest version is the
-- one in force, so every earlier shape of the rule stays readable and a run names the version it
-- took. `flow_json` is the graph the API checked before the write (`parseAutomationFlow`: known
-- action kinds, known fields and operators, bounded size and depth, no cycle). A rule with no row
-- here is a linear rule and runs exactly as before.
--
-- The API credential gets INSERT only and the worker SELECT only (scripts/db/users.sql): a saved
-- version is never rewritten; the company erasure empties it with every other tenant table.
--
-- MariaDB-safe (live is MariaDB 11.8): plain columns, JSON (a LONGTEXT alias on MariaDB), DATETIME(3),
-- no generated columns, no CHECK, no functional or partial indexes, utf8mb4_unicode_ci. Additive only.

CREATE TABLE workflow_flow_versions (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  template_id     CHAR(36)     NOT NULL,
  version         INT UNSIGNED NOT NULL,
  flow_json       JSON         NOT NULL,
  created_by      CHAR(36)     NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_workflow_flow_versions_org_id (organization_id, id),
  UNIQUE KEY uq_workflow_flow_versions_template_version (organization_id, template_id, version),
  CONSTRAINT fk_workflow_flow_versions_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_workflow_flow_versions_template
    FOREIGN KEY (organization_id, template_id) REFERENCES workflow_templates (organization_id, id),
  CONSTRAINT fk_workflow_flow_versions_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
