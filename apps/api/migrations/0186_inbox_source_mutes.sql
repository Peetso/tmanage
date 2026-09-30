-- 0186_inbox_source_mutes — a member's own muted inbox sources (module INBOX, x318).
--
-- Governing sources: 38-MODULE-MAP §Universal Inbox (mute source); 22-SCREEN-BY-SCREEN §Inbox;
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys, scoped writes); 07-DATA-MODEL §9
-- (every composite index prefix begins with organization_id); ADR-0001 (MySQL has no row-level
-- security; the application layers replace it, and the withheld privilege is a control).
--
-- ## What this migration is for
--
-- INBOX-001 (0-migration; the inbox is a read projection over `notifications`) gives a member a
-- bundled inbox. This slice lets a member mute a specific source object — a `work_item`, a
-- `client_request` or the `organization_usage` notice — so its bundle is filtered out of *their*
-- inbox read, un-mute it, and list their mutes. It is a self-scoped read-side filter and changes
-- no dispatch: a muted source's notifications are still written and still counted; the member's
-- inbox composition simply excludes the muted (object_type, object_id) pairs. One
-- `inbox_source_mutes` row is the fact "this member muted this source in this studio".
--
-- ## The source is `(object_type, object_id)`, not a foreign key
--
-- A source is named the way the inbox names an object bundle — an object_type prefix
-- (`work_item` / `client_request` / `organization_usage`) and the object's id — so it is a
-- (type, id) pair, not a column with a single foreign key: the object it names lives in a
-- different table per prefix, and `organization_usage` names the organization itself. The tenant
-- safety is therefore not an FK on the source (the `home_pinned_items` target_id posture, 0050):
-- it is that every read, the insert and the delete run under an `organization_id = context`
-- predicate, so a mute never crosses a tenant boundary, and the mute is a self-scoped filter so a
-- source that does not exist or the caller cannot see is harmless — it simply matches nothing.
-- The application enforces the object_type allowlist before any write (an off-allowlist type is a
-- 400 with no row); the column is a plain VARCHAR so the allowlist can widen without a migration.
--
-- ## Mutes are per member, keyed for idempotency, and created and removed, never edited
--
-- A row is one member's mute of one source in one studio, keyed `(organization_id, member_user_id,
-- object_type, object_id)`. It is keyed by `member_user_id` — the global user id, the same choice
-- `notifications.recipient_user_id` and `notification_preferences.user_id` make, because the inbox
-- read this filter feeds is itself recipient-user-scoped — never leaves the tenant, and the FK
-- binds it to the global `users` table. The only writes are INSERT (mute) and DELETE (un-mute);
-- nothing about a row ever changes, so re-muting the same source is idempotent against the unique
-- key (the service checks-then-inserts, so a second mute is a no-op, not a conflict) and there is
-- no UPDATE grant and no immutability trigger to add — the `home_pinned_items`/`saved_context`
-- posture. This slice grants the app INSERT, DELETE and SELECT.

CREATE TABLE inbox_source_mutes (
  id              CHAR(36)      NOT NULL,
  organization_id CHAR(36)      NOT NULL,
  -- The member whose muted set this row belongs to. Private to it: the list, the insert and the
  -- delete are all scoped by member_user_id = the acting context's user, so one member never sees,
  -- adds or removes another's mutes even inside the same tenant. The FK binds it to the global
  -- users table (identity is global, notifications.recipient_user_id is the same choice).
  member_user_id  CHAR(36)      NOT NULL,
  -- The inbox object-type prefix of the muted source: work_item, client_request or
  -- organization_usage. A plain VARCHAR, not an ENUM, so the allowlist (enforced in the service)
  -- can widen without a migration; an off-allowlist type never reaches an INSERT.
  object_type     VARCHAR(64)   NOT NULL,
  -- The muted source object's id. No foreign key: the object lives in a different table per prefix
  -- (organization_usage names the organization itself), so the tenant boundary is the scoped
  -- predicate above, not an FK here (the home_pinned_items target_id posture).
  object_id       VARCHAR(64)   NOT NULL,
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, the target of the composite
  -- FKs that bind child rows within one tenant (and the isolation corpus requires it).
  UNIQUE KEY uq_inbox_source_mutes_org_id (organization_id, id),
  -- One row per member per source per studio. This is the idempotency key: re-muting the same
  -- source collides here and the service treats the existing row as success. Leads with
  -- organization_id per 07-DATA-MODEL §9.
  UNIQUE KEY uq_inbox_source_mutes_pin
    (organization_id, member_user_id, object_type, object_id),
  -- 07-DATA-MODEL §9: the one read that exists — a member's mutes, newest first, id breaking ties.
  KEY ix_inbox_source_mutes_org_member (organization_id, member_user_id, id),
  CONSTRAINT fk_inbox_source_mutes_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The member, bound to global identity: a mute cites a real user. The scoped predicate, not this
  -- FK, is the tenant boundary — user identity is global, membership is what is tenant-bound.
  CONSTRAINT fk_inbox_source_mutes_user
    FOREIGN KEY (member_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
