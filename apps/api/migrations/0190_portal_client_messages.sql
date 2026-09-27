-- 0190_portal_client_messages — SEC: Client portal inbound messages (module "Client portal", x322).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Client portal" (client inquiries),
-- 22-SCREEN-BY-SCREEN §Portal, 23-ERD-AND-STATE-MACHINES §2 (tenant-scoped, parent-owned records),
-- 07-DATA-MODEL §9 (index prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION
-- §5-6 (composite tenant keys, scoped writes), ADR-0001 (MySQL has no row-level security; layers 3-5
-- replace it).
--
-- ## What this migration is for
--
-- A client contact posts a message/inquiry to the studio from the portal — a subject and a body —
-- reads their own thread, and staff read the client's messages. It is an in-app relay record only:
-- there is no email dispatch. This is distinct from chat/conversations (internal membership threads)
-- and from `project_update_comments` (0084, x203, a comment on one published update): a client
-- message hangs off the client organization scope, not a project update, and is client-authored.
--
-- ## Client-org-scoped and tenant-scoped
--
-- A message belongs to one client organization of one studio. `organization_id` scopes it to the
-- tenant the way every sibling table is scoped; `client_org_scope_id` names the client organization
-- the thread belongs to. The composite foreign key `fk_portal_client_messages_scope` binds
-- `(organization_id, client_org_scope_id)` to `client_organizations (organization_id, id)`, so a
-- cross-tenant `client_org_scope_id` is a non-existent pair even when both ids exist individually —
-- the engine half of the rule the service also enforces in code: the client-org scope is resolved
-- inside the acting tenant first, so a cross-tenant scope id is a 404 with no write, and a client's
-- own-thread read can never surface another client organization's messages. The `author_user_id`
-- foreign key ties the author to a real user.
--
-- ## Append-only
--
-- A message is a record of what was said, when. It is inserted and read, never edited or removed:
-- the runtime credential is granted INSERT and nothing else (see `scripts/db/users.sql`), and the
-- `BEFORE UPDATE` trigger refuses any amendment for every other credential besides — the
-- append-only posture `project_update_comments` (0084) and `work_item_comments` (0053) carry. Edit
-- and delete are a later slice that adds the privilege with the code that writes it.

CREATE TABLE portal_client_messages (
  id                  CHAR(36)     NOT NULL,
  organization_id     CHAR(36)     NOT NULL,
  -- NOT NULL. The client organization the thread belongs to; the composite key below makes a
  -- cross-tenant scope id a non-existent pair rather than a leak.
  client_org_scope_id CHAR(36)     NOT NULL,
  -- The user who wrote the message. For a portal message this is the client contact; the client
  -- projection drops it, the way `project_update_comments`' client view drops its author.
  author_user_id      CHAR(36)     NOT NULL,
  -- A short handle a person types. VARCHAR(190) matches `client_organizations.name`'s bound.
  subject             VARCHAR(190) NOT NULL,
  -- Free text. TEXT rather than VARCHAR because a body is prose a person types (the choice
  -- `project_update_comments.body` made).
  body                TEXT         NOT NULL,
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_portal_client_messages_org_id (organization_id, id),
  -- 07-DATA-MODEL §9: the one read that exists — this tenant's messages for one client-org scope,
  -- in created-at (then id) order. Leads with `organization_id`.
  KEY ix_portal_client_messages_scope (organization_id, client_org_scope_id, created_at, id),
  -- A message can only ever name a client organization of its own tenant; the composite key is what
  -- makes a cross-tenant `client_org_scope_id` a non-existent pair rather than a leak.
  CONSTRAINT fk_portal_client_messages_scope
    FOREIGN KEY (organization_id, client_org_scope_id)
      REFERENCES client_organizations (organization_id, id),
  CONSTRAINT fk_portal_client_messages_author
    FOREIGN KEY (author_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A message is append-only: once written it is neither re-scoped, re-attributed nor edited. The
-- trigger holds that at the engine — ADR-0001 layers 3 and 4 are application-side and a direct SQL
-- session bypasses both — for the credentials that do hold UPDATE. The runtime credential holds none
-- (users.sql), so this is defence in depth, the `project_update_comments` posture.
DELIMITER $$

CREATE TRIGGER trg_portal_client_messages_immutable
BEFORE UPDATE ON portal_client_messages FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'portal_client_messages rows are append-only';
END$$

DELIMITER ;
