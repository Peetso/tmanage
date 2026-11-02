-- 0295_contact_suggestions — 54-11 Google / Microsoft contacts, Phase 0 (R16 slice f).
--
-- ## What this migration is for
--
-- A person who invites people (`people.invite` or `client_member.manage`) imports a Google or
-- Outlook CSV export, or a vCard file, and the addresses become **their own** invite suggestions:
-- typing three letters in the invite picker offers a name, an email and a company. Phase 1 (live
-- Google / Microsoft contacts) needs new OAuth scopes and is not here.
--
-- One tenant table:
--
-- - `contact_suggestions` (TENANT, new) — one address in one person's suggestion list. Keyed by
--   `(organization_id, user_id)`: a person's address book is theirs, never shared with another
--   user or another organization, and there is no org-wide listing of it. `source` is 'csv' or
--   'vcard' (Phase 1 adds 'google' / 'microsoft'; checked in the application). Cells are stored as
--   text and never evaluated; a later CSV export of these rows must go through the domain `toCsv`.
--   `expires_at` is set to the import time + 90 days and refreshed when the same address is
--   imported again. Expiry is **lazy**: suggest reads only `expires_at > now`, and every import
--   first deletes the caller's own expired rows. The purge sweeper is not changed.
--
-- `UNIQUE (organization_id, user_id, email)` makes a re-import an upsert. The suggest read is
-- `(organization_id, user_id, expires_at)` by the third key.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATETIME(3), composite tenant keys, no generated columns, no CHECK, no JSON
-- defaults, no functional indexes, utf8mb4_unicode_ci (Arabic names are stored verbatim).
-- `organization_id` and `user_id` never move (trigger below).
--
-- ## Grants (scripts/db/users.sql, 0295 block)
--
-- `tmanage_app`: SELECT, INSERT, UPDATE, DELETE. `tmanage_worker`: nothing.

CREATE TABLE contact_suggestions (
  id               CHAR(36)      NOT NULL,
  organization_id  CHAR(36)      NOT NULL,
  -- The person whose suggestion list this is. Never another user's row.
  user_id          CHAR(36)      NOT NULL,
  -- 'csv' | 'vcard' (checked in the application).
  source           VARCHAR(16)   NOT NULL,
  display_name     VARCHAR(300)  NULL,
  -- Lower-cased and validated by the domain parser.
  email            VARCHAR(320)  NOT NULL,
  company          VARCHAR(300)  NULL,
  created_at       DATETIME(3)   NOT NULL,
  expires_at       DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cs_org_id (organization_id, id),
  UNIQUE KEY uq_cs_user_email (organization_id, user_id, email),
  KEY ix_cs_user_expiry (organization_id, user_id, expires_at),
  CONSTRAINT fk_cs_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_cs_user
    FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

CREATE TRIGGER trg_contact_suggestions_org_immutable
BEFORE UPDATE ON contact_suggestions FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'contact_suggestions.organization_id is immutable';
  END IF;
  IF NOT (NEW.user_id <=> OLD.user_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'contact_suggestions.user_id is immutable';
  END IF;
END$$

DELIMITER ;
