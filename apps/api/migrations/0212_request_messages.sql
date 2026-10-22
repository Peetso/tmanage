-- 0212_request_messages — the client <-> studio conversation on a client request (audit gap 4).
--
-- Before this, a client who submitted a request could read its state and withdraw it, and nothing
-- else: there was no way to answer a clarification question or add detail, and the studio had no
-- way to reply other than a state change. `request_comments` (0167) is the studio's INTERNAL notes
-- and is never projected to a client; this table is the shared thread.
--
-- ## Who sees what
--
-- Every row carries `client_visible`. A client posts with it set (a client cannot write a note the
-- client cannot see); a team member chooses, defaulting to visible, and may post a team-only note.
-- The client read path selects `client_visible = 1` in its query predicate, so a team-only row is
-- never selected for a client rather than filtered after the fact.
--
-- ## Tenant- and request-scoped
--
-- `fk_request_messages_request` binds `(organization_id, request_id)` to `client_requests
-- (organization_id, id)`: a message can only ever name a request of its own tenant. The service
-- resolves and authorizes the request inside the acting tenant before it inserts.
--
-- ## Append-only (INSERT + SELECT)
--
-- A message is a record of what was said to a client, when. The runtime credential is granted
-- INSERT only (`scripts/db/users.sql`) and the `BEFORE UPDATE` trigger refuses any amendment for
-- every other credential. MariaDB-safe: plain columns, a CHECK, a trigger; no generated columns.

CREATE TABLE request_messages (
  id                    CHAR(36)    NOT NULL,
  organization_id       CHAR(36)    NOT NULL,
  request_id            CHAR(36)    NOT NULL,
  -- The membership that posted: a studio member or a client person (client people hold
  -- memberships too). No foreign key, matching `request_comments` and `work_item_comments`.
  author_membership_id  CHAR(36)    NOT NULL,
  -- Which side of the boundary wrote it, fixed at insert from the principal, so the client view
  -- can say "studio" or "you" without resolving a staff identity.
  author_kind           VARCHAR(16) NOT NULL,
  body                  TEXT        NOT NULL,
  client_visible        TINYINT(1)  NOT NULL DEFAULT 1,
  created_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_request_messages_org_id (organization_id, id),
  -- The one read: this tenant's messages for one request, oldest first.
  KEY ix_request_messages_request (organization_id, request_id, created_at, id),
  CONSTRAINT ck_request_messages_author_kind CHECK (author_kind IN ('internal', 'client')),
  CONSTRAINT ck_request_messages_client_visible CHECK (client_visible IN (0, 1)),
  -- A client always writes a client-visible message.
  CONSTRAINT ck_request_messages_client_sees_own CHECK (author_kind <> 'client' OR client_visible = 1),
  CONSTRAINT fk_request_messages_request
    FOREIGN KEY (organization_id, request_id) REFERENCES client_requests (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

CREATE TRIGGER trg_request_messages_immutable
BEFORE UPDATE ON request_messages FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'request_messages rows are append-only';
END$$

DELIMITER ;
