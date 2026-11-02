-- 0293_typed_dependencies — 53-04 typed dependencies, lag and cascade (R16 slice d).
--
-- ## What this migration is for
--
-- WORK-003's `work_item_dependencies` (0011) is an untyped "successor waits for predecessor" edge.
-- 53-04 gives each edge a kind and a lag so a schedule can be cascaded over working days:
--
-- - `kind` — FS (finish-to-start, the old meaning and the default), SS, FF or SF. A closed list
--   checked in the application (the project's MariaDB rule: no ENUM, no CHECK).
-- - `lag_working_days` — signed working days added to the constraint (-30..365, app-checked).
-- - `created_source` — ui | api | mcp | import | automation (app-checked), who made the edge.
-- - `status` — active | suspended (app-checked). A suspended edge is kept but ignored by the
--   cycle guard and the cascade.
--
-- Every existing row becomes an active FS edge with no lag, which is exactly what it meant before.
--
-- ## The immutability trigger is narrowed, not removed
--
-- 0011's `trg_work_item_dependencies_immutable` refused every UPDATE ("correct an edge by delete
-- and add"). The new `PATCH …/dependencies/:id` changes `kind` and `lag_working_days` in place, so
-- the trigger is replaced by one that still refuses a change to the edge itself (its ends, tenant,
-- author and creation time) and lets only the four typed columns move. The message keeps the word
-- "immutable", which the WORK-003 DB suite asserts.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns with constant defaults, no generated columns, no CHECK, no ENUM, no JSON; the
-- trigger in a DELIMITER $$ block as 0283 / 0288.
--
-- ## Grants (scripts/db/users.sql, 0293 block)
--
-- `tmanage_app` gains UPDATE on `work_item_dependencies` (it held INSERT, DELETE). Worker: nothing.

ALTER TABLE work_item_dependencies
  ADD COLUMN kind             VARCHAR(2)  NOT NULL DEFAULT 'FS'     AFTER depends_on_work_item_id,
  ADD COLUMN lag_working_days SMALLINT    NOT NULL DEFAULT 0        AFTER kind,
  ADD COLUMN created_source   VARCHAR(12) NOT NULL DEFAULT 'ui'     AFTER lag_working_days,
  ADD COLUMN status           VARCHAR(10) NOT NULL DEFAULT 'active' AFTER created_source;

DROP TRIGGER IF EXISTS trg_work_item_dependencies_immutable;

DELIMITER $$

CREATE TRIGGER trg_work_item_dependencies_immutable
BEFORE UPDATE ON work_item_dependencies FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id)
     OR NOT (NEW.organization_id <=> OLD.organization_id)
     OR NOT (NEW.work_item_id <=> OLD.work_item_id)
     OR NOT (NEW.depends_on_work_item_id <=> OLD.depends_on_work_item_id)
     OR NOT (NEW.created_by_user_id <=> OLD.created_by_user_id)
     OR NOT (NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_dependencies edges are immutable: only kind, lag, source and status may change';
  END IF;
END$$

DELIMITER ;
