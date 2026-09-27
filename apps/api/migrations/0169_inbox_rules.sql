-- 0169_inbox_rules — a member's own inbox routing rules: when a notification's source/type matches a
-- value, apply a category label. Read-side only — the resolve helper returns the first-matching
-- category for a candidate; nothing is written back to notifications (module Inbox, x301).
--
-- Governing sources: 22-SCREEN-BY-SCREEN §Inbox; 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Inbox (the
-- inbox has snooze, flags and saved filters; per-user routing rules did not exist); 11-USER-STORIES
-- §Inbox; 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys); 07-DATA-MODEL §9 (index
-- prefixes lead with organization_id).
--
-- ## Migration number
--
-- The pass-25 queue map reserves 0169 for x301. The migrator applies files in ascending numeric order
-- and a gap is not an error (it rejects only a NEW file numbered below an applied one), so 0169 on top
-- of the reserved sequence is correct on this base. If the integration renumbers the reservations, the
-- integrator renumbers this file with them.
--
-- ## One row per rule, keyed by membership
--
-- A row is one membership's routing rule in one studio, keyed within the tenant by
-- `(organization_id, id)` — tenant-owned like `home_widget_prefs` (0115) and `notification_kind_prefs`
-- (0057), registered in the query guard's TENANT_TABLES. It is keyed to `membership_id`, not the
-- global `user_id`: a rule is scoped to who the caller is in this studio and never leaves the tenant,
-- and the composite foreign key binds the row to a membership of this same organization. The routes
-- have no path or body that could name another membership — the acting membership comes from the
-- authenticated principal — so a caller reads, adds and removes their own rules and no other's.
--
-- ## What a rule is
--
-- `match_type` is the notification field the rule matches on: `type` is the event type
-- (`notifications.type`), `object_type` is what the notification is about (`notifications.object_type`).
-- `match_value` is the value that field must equal for the rule to fire. `category` is the label the
-- rule applies. Both `match_type` and `category` are closed ENUMs, and the application validates a
-- request against the same allowlist before storing (`rules.controller.ts`) — a value outside the set
-- is a 400 and nothing is written, the belt to this braces. `position` orders a member's rules
-- (lowest first); the resolve helper returns the first rule that fires.
--
-- ## No edit, self-service removal
--
-- The runtime credential holds INSERT and DELETE (users.sql), no UPDATE: a rule is added and removed,
-- never edited in place (a reorder is a delete-and-add). There is no immutability trigger because a
-- rule carries nothing an update would need to protect — the row is its identity, and no column is
-- mutated by any granted statement.

CREATE TABLE inbox_rules (
  id               CHAR(36)                                             NOT NULL,
  organization_id  CHAR(36)                                             NOT NULL,
  -- The membership whose rule this row holds. Private to it: every read is scoped by
  -- membership_id = the acting context's membership, so one member never sees or applies another's
  -- rules even inside the same tenant. The composite FK below binds it to a membership of this org.
  membership_id    CHAR(36)                                             NOT NULL,
  -- The notification field the rule matches on. `type` = notifications.type (event type),
  -- `object_type` = notifications.object_type (what the notification is about). Validated against the
  -- same allowlist by the application; the ENUM is the engine half of that closed set.
  match_type       ENUM('type','object_type')                           NOT NULL,
  -- The value `match_type`'s field must equal for the rule to fire.
  match_value      VARCHAR(190)                                         NOT NULL,
  -- The category label the rule applies, read-side only. Closed ENUM, validated by the application.
  category         ENUM('urgent','follow_up','waiting','fyi','archive') NOT NULL,
  -- Orders a member's rules; the resolve helper returns the first rule (lowest position) that fires.
  position         INT UNSIGNED                                         NOT NULL DEFAULT 0,
  created_at       DATETIME(3)                                          NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can reference
  -- this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_inbox_rules_org_id (organization_id, id),
  -- A member's rules are read as one ordered list; this is the index that read is served by. Leads
  -- with organization_id per 07-DATA-MODEL §9.
  KEY ix_inbox_rules_org_membership_position (organization_id, membership_id, position),
  CONSTRAINT fk_inbox_rules_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The membership, bound within its own tenant: the composite key refuses a membership id from
  -- outside this row's organization, so a rule can never cite a membership in another studio.
  CONSTRAINT fk_inbox_rules_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
