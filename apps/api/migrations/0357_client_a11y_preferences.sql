-- 0357_client_a11y_preferences — a client portal user's own accessibility preferences (module 20
-- Preferences & accessibility, PORTALA11Y).
--
-- `a11y_preferences` (0079) holds a member's text size / high contrast / reduced motion, keyed to
-- `memberships`. A client portal user has no row there: their identity in a studio is a
-- `client_memberships` row, so the 0079 composite FK refuses them and the portal had nowhere to keep
-- the same three settings. This table is the client twin of 0079: the same JSON shape, the same
-- one-row-per-person upsert key, bound to `client_memberships` within the same tenant.
--
-- MariaDB-safe: plain columns, no generated column, a composite FK to an existing unique key
-- (`uq_client_memberships_org_id`), and the immutability trigger 0079 already uses.

CREATE TABLE client_a11y_preferences (
  id                   CHAR(36)     NOT NULL,
  organization_id      CHAR(36)     NOT NULL,
  -- The client membership whose settings this row holds. The read and the upsert are both scoped
  -- by the acting principal's own client membership, so one client never sees or replaces another
  -- person's settings, even inside the same client organization.
  client_membership_id CHAR(36)     NOT NULL,
  -- `{ "fontScale": "sm|md|lg|xl", "reduceMotion": bool, "highContrast": bool }`, validated by the
  -- application (the same shape as `a11y_preferences.a11y_json`).
  a11y_json            JSON         NOT NULL,
  updated_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_client_a11y_preferences_org_id (organization_id, id),
  -- One row per client person per studio: the upsert key.
  UNIQUE KEY uq_client_a11y_preferences_org_client_membership (organization_id, client_membership_id),
  CONSTRAINT fk_client_a11y_preferences_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- Bound within its own tenant: a client membership from another studio is refused.
  CONSTRAINT fk_client_a11y_preferences_client_membership_tenant
    FOREIGN KEY (organization_id, client_membership_id)
    REFERENCES client_memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

CREATE TRIGGER trg_client_a11y_preferences_immutable
BEFORE UPDATE ON client_a11y_preferences FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_a11y_preferences.organization_id is immutable';
  END IF;
  IF NEW.client_membership_id <> OLD.client_membership_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_a11y_preferences.client_membership_id is immutable';
  END IF;
END$$

DELIMITER ;
