-- 0375_pricing_survey_answers — the willingness-to-pay card on Home (57-17, WTP).
--
-- ## What this migration is for
--
-- After 14 days of use, an owner or admin of a workspace sees one card on Home: "What would you
-- pay per person each month?" with five price bands, an optional note and Skip. Each person
-- answers (or skips) once per workspace; the TManage team reads the answers on the Platform
-- admin Growth page.
--
-- - `outcome`: 'answered' or 'skipped' (vocabulary checked in code).
-- - `band`: 'nothing', 'under_5', '5_9', '10_15' or 'over_15' when answered; NULL when skipped.
-- - `note`: the optional free text, at most 500 characters (capped in code too); NULL if empty.
--
-- `uq_pricing_survey_answers_org_membership (organization_id, membership_id)` is the
-- one-answer-per-person rule: a second answer or skip is refused by the key, whatever the code
-- does. The membership FK is bound within its own tenant (a membership of another workspace is
-- refused). TENANT table: the API inserts on the tenant path; the Platform admin list reads it
-- through the audited bootstrap path. Grants: api SELECT, INSERT (no UPDATE, no DELETE).
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- New table only. Plain columns, DATETIME(3), no CHECK, no generated column, no functional or
-- partial index, no trigger. No earlier migration is edited.

CREATE TABLE pricing_survey_answers (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  membership_id   CHAR(36)     NOT NULL,
  outcome         VARCHAR(8)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  band            VARCHAR(8)   CHARACTER SET ascii COLLATE ascii_bin NULL,
  note            VARCHAR(500) NULL,
  answered_at     DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pricing_survey_answers_org_id (organization_id, id),
  UNIQUE KEY uq_pricing_survey_answers_org_membership (organization_id, membership_id),
  KEY ix_pricing_survey_answers_answered (answered_at),
  CONSTRAINT fk_pricing_survey_answers_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_pricing_survey_answers_membership_tenant
    FOREIGN KEY (organization_id, membership_id)
    REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
