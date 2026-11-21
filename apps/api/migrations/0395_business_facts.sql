-- 0395_business_facts — Business Memory: lasting facts about a workspace's clients, projects, people, processes and company, approved by a person (plan 62, 62-26).
--
-- ## What this migration is for
--
-- Plan 62 §4.6 and §9 62-26: "Table `business_facts`: entity (client / project / person / process /
-- company), the fact (≤ 500 characters), category, source link, owner, audience (same audience
-- model as content, plus finance-only and HR-only), status (`proposed` → `approved` → `retired`),
-- last confirmed date. The AI proposes; a person approves. Facts unconfirmed for 180 days are
-- flagged."
--
-- - `business_facts` (TENANT): one row per fact. `entity_type` with `entity_id` names what the
--   fact is about (`entity_id` is NULL for `process` and `company`). `fact` is at most 500
--   characters (VARCHAR counts characters in utf8mb4). `audience`: `internal` and
--   `client_visible` (the content audience model), `finance` (finance.view holders only) and `hr`
--   (people.edit holders only). `status`: `proposed` until a person with ai.manage approves it,
--   then `approved` (the only status the AI recall reads), then `retired`. `last_confirmed_at` is
--   set on approval and on every confirmation or edit; an approved fact older than 180 days is
--   reported as stale (computed, not stored). `proposed_via` says whether the AI or a member
--   proposed it; the text is never chat history and is never stored without a person's yes.
--
-- No data is written here.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- One DDL statement, one new table. ENUM with literal values, literal defaults, no CHECK, no
-- generated column, no functional or partial index, no trigger, no foreign key (the 0257
-- convention). Additive only: old code ignores the table (DA-6).

CREATE TABLE business_facts (
  id                  CHAR(36)     NOT NULL,
  organization_id     CHAR(36)     NOT NULL,
  entity_type         ENUM('client', 'project', 'person', 'process', 'company') NOT NULL,
  entity_id           CHAR(36)     NULL,
  fact                VARCHAR(500) NOT NULL,
  category            VARCHAR(32)  NOT NULL,
  source_href         VARCHAR(500) NULL,
  audience            ENUM('internal', 'client_visible', 'finance', 'hr') NOT NULL DEFAULT 'internal',
  status              ENUM('proposed', 'approved', 'retired') NOT NULL DEFAULT 'proposed',
  proposed_via        ENUM('ai', 'member') NOT NULL,
  owner_user_id       CHAR(36)     NOT NULL,
  proposed_by_user_id CHAR(36)     NOT NULL,
  approved_by_user_id CHAR(36)     NULL,
  approved_at         DATETIME(3)  NULL,
  last_confirmed_at   DATETIME(3)  NULL,
  retired_by_user_id  CHAR(36)     NULL,
  retired_at          DATETIME(3)  NULL,
  created_at          DATETIME(3)  NOT NULL,
  updated_at          DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_business_facts_org_id (organization_id, id),
  KEY ix_business_facts_entity (organization_id, status, entity_type, entity_id),
  KEY ix_business_facts_confirmed (organization_id, status, last_confirmed_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
