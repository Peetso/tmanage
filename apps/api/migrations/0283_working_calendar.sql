-- 0283_working_calendar — 53-02 working calendar and MENA holiday packs (R13 slice 4).
--
-- ## What this migration is for
--
-- Every date calculation that means "working days" (due-soon sweeps, the automation weekend hold,
-- later auto-shift and workload) needs to know which days a company works. Until now nothing stored
-- it: the weekend hold and the due-soon sweep assumed Friday–Saturday. Two tenant tables:
--
-- - `org_working_calendars` (TENANT, new) — the company's calendar (`scope = 'org'`, `project_id`
--   NULL) and any project override (`scope = 'project'`, `project_id` set). `working_days_mask` has
--   bit 0 = Sunday … bit 6 = Saturday; the application refuses a mask with no working day. `day_start`
--   / `day_end` are wall-clock times in `time_zone` (an IANA zone the application validates).
--   `version` is the optimistic-concurrency counter: a PUT naming a stale version is a 409.
--   No row means the default: Sunday–Thursday, 09:00–17:00, the organization's time zone.
-- - `org_holidays` (TENANT, new) — the days off of one calendar: a custom day an owner typed, or a
--   day imported from a static holiday pack shipped with the app (`source = 'pack'`, `pack_key`,
--   `pack_version`). `estimated = 1` marks a Hijri-based day whose date is expected, not announced.
--   One holiday per calendar per date. The application caps a calendar at 400 holidays.
--
-- `scope` and `source` are closed lists checked in the application (the project's MariaDB rule: no
-- CHECK constraints). `UNIQUE (organization_id, scope, project_id)`: a NULL `project_id` never
-- collides, so the one-org-calendar invariant is held by the service, which reads the org row
-- `FOR UPDATE` (a next-key lock on this index) before it inserts one.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATE / TIME / DATETIME(3), composite tenant keys, no generated columns, no CHECK,
-- no JSON defaults, no functional indexes, utf8mb4_unicode_ci. `org_holidays.calendar_id` is bound
-- within the tenant to `org_working_calendars (organization_id, id)`; deleting a calendar row
-- removes its holidays (ON DELETE CASCADE). No foreign key to `projects` (the 0257 convention): the
-- service resolves the project tenant-scoped first.
--
-- ## Grants (scripts/db/users.sql, 0283 block)
--
-- `tmanage_app`: SELECT, INSERT, UPDATE, DELETE on both. `tmanage_worker`: SELECT on both (the
-- due-soon sweep and the weekend hold read the company calendar).

CREATE TABLE org_working_calendars (
  id                 CHAR(36)          NOT NULL,
  organization_id    CHAR(36)          NOT NULL,
  -- 'org' | 'project' (checked in the application).
  scope              VARCHAR(8)        NOT NULL,
  -- NULL for the org calendar; the project an override belongs to otherwise.
  project_id         CHAR(36)          NULL,
  -- bit 0 = Sunday … bit 6 = Saturday. Sun–Thu = 31.
  working_days_mask  TINYINT UNSIGNED  NOT NULL,
  day_start          TIME              NOT NULL,
  day_end            TIME              NOT NULL,
  time_zone          VARCHAR(64)       NOT NULL,
  version            INT               NOT NULL DEFAULT 1,
  created_at         DATETIME(3)       NOT NULL,
  updated_at         DATETIME(3)       NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_org_working_calendars_org_id (organization_id, id),
  UNIQUE KEY uq_org_working_calendars_scope (organization_id, scope, project_id),
  CONSTRAINT fk_org_working_calendars_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE org_holidays (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  calendar_id      CHAR(36)     NOT NULL,
  date             DATE         NOT NULL,
  label_en         VARCHAR(80)  NOT NULL,
  label_ar         VARCHAR(80)  NULL,
  -- 'pack' | 'custom' (checked in the application).
  source           VARCHAR(8)   NOT NULL,
  pack_key         VARCHAR(32)  NULL,
  pack_version     VARCHAR(16)  NULL,
  estimated        TINYINT(1)   NOT NULL DEFAULT 0,
  created_at       DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_org_holidays_org_id (organization_id, id),
  UNIQUE KEY uq_org_holidays_calendar_date (organization_id, calendar_id, date),
  CONSTRAINT fk_org_holidays_calendar_tenant
    FOREIGN KEY (organization_id, calendar_id)
    REFERENCES org_working_calendars (organization_id, id)
    ON DELETE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- organization_id is immutable on both (ADR-0001 layer 1), as on every tenant table.
DELIMITER $$

CREATE TRIGGER trg_org_working_calendars_org_immutable
BEFORE UPDATE ON org_working_calendars FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'org_working_calendars.organization_id is immutable';
  END IF;
END$$

CREATE TRIGGER trg_org_holidays_org_immutable
BEFORE UPDATE ON org_holidays FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'org_holidays.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
