-- 0264_finance_capability_backfill — the finance routes move to their own capabilities.
--
-- ## What this migration is for
--
-- 52-23 shipped Settings → Finance on stand-ins: reads asked `project.manage`, writes asked
-- `workspace.manage`. 52-23 §10 appends the real keys, `finance.view` and `finance.manage`, to
-- `CAPABILITIES` and moves the eight `…/finance/*` route guards to them. A built-in role's ceiling
-- is code (packages/domain capabilities.ts: Workspace Admin both, Manager view, Owner / Org Admin
-- everything), but two things are stored, and would silently lose the screens:
--
-- 1. a custom role's own list (`custom_roles.capabilities_json`, 0071) — back-filled exactly in the
--    0248 pattern: `workspace.manage` -> `finance.manage` and `finance.view`; `project.manage` ->
--    `finance.view`;
-- 2. a member's live allow/deny override (`membership_permission_overrides`, 0242) — mirrored one
--    to one, so an allow keeps opening and a deny keeps closing the same routes:
--    `workspace.manage` -> `finance.manage`, `project.manage` -> `finance.view`, same effect, same
--    expiry, same author. Revoked rows and client-audience rows are not copied.
--
-- No table is created and no grant changes. Clients never hold either key: both are internal-only
-- in code, and nothing here touches a client membership.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain UPDATEs with JSON_VALID / JSON_CONTAINS / JSON_ARRAY_APPEND / JSON_QUOTE (no `->`, no
-- MEMBER OF, no CAST AS JSON), and INSERT … SELECT with UUID() for the CHAR(36) ids (as 0207 does).
-- Every statement is guarded so a row that already holds the new key is untouched. Idempotent:
-- running it twice changes nothing the second time.


-- custom roles: finance writes rode workspace.manage: workspace.manage -> finance.manage.
UPDATE custom_roles
   SET capabilities_json = JSON_ARRAY_APPEND(capabilities_json, '$', 'finance.manage')
 WHERE JSON_VALID(capabilities_json)
   AND JSON_CONTAINS(capabilities_json, JSON_QUOTE('workspace.manage'))
   AND NOT JSON_CONTAINS(capabilities_json, JSON_QUOTE('finance.manage'));

-- custom roles: a workspace.manage holder also reads what it writes: workspace.manage -> finance.view.
UPDATE custom_roles
   SET capabilities_json = JSON_ARRAY_APPEND(capabilities_json, '$', 'finance.view')
 WHERE JSON_VALID(capabilities_json)
   AND JSON_CONTAINS(capabilities_json, JSON_QUOTE('workspace.manage'))
   AND NOT JSON_CONTAINS(capabilities_json, JSON_QUOTE('finance.view'));

-- custom roles: finance reads rode project.manage: project.manage -> finance.view.
UPDATE custom_roles
   SET capabilities_json = JSON_ARRAY_APPEND(capabilities_json, '$', 'finance.view')
 WHERE JSON_VALID(capabilities_json)
   AND JSON_CONTAINS(capabilities_json, JSON_QUOTE('project.manage'))
   AND NOT JSON_CONTAINS(capabilities_json, JSON_QUOTE('finance.view'));

-- member overrides: workspace.manage -> finance.manage, same effect.
INSERT INTO membership_permission_overrides
       (id, organization_id, membership_id, audience, capability, effect, reason, expires_at,
        created_by)
SELECT UUID(), o.organization_id, o.membership_id, o.audience, 'finance.manage', o.effect,
       'Carried from workspace.manage by migration 0264 (finance keys).', o.expires_at,
       o.created_by
  FROM membership_permission_overrides o
 WHERE o.capability = 'workspace.manage'
   AND o.audience = 'internal'
   AND o.revoked_at IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM membership_permission_overrides x
          WHERE x.organization_id = o.organization_id
            AND x.membership_id = o.membership_id
            AND x.capability = 'finance.manage'
            AND x.revoked_at IS NULL
       );

-- member overrides: project.manage -> finance.view, same effect.
INSERT INTO membership_permission_overrides
       (id, organization_id, membership_id, audience, capability, effect, reason, expires_at,
        created_by)
SELECT UUID(), o.organization_id, o.membership_id, o.audience, 'finance.view', o.effect,
       'Carried from project.manage by migration 0264 (finance keys).', o.expires_at,
       o.created_by
  FROM membership_permission_overrides o
 WHERE o.capability = 'project.manage'
   AND o.audience = 'internal'
   AND o.revoked_at IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM membership_permission_overrides x
          WHERE x.organization_id = o.organization_id
            AND x.membership_id = o.membership_id
            AND x.capability = 'finance.view'
            AND x.revoked_at IS NULL
       );
