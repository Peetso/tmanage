-- 0248_custom_role_capability_backfill — existing custom roles keep what they could do.
--
-- ## What this migration is for
--
-- Platform admin v2 (SPEC §3.3, PA-01) moved several routes from an older capability to a new,
-- finer one: the People directory, Insights, decisions, the AI connector, work-item and folder
-- deletes, and billing. A built-in role's ceiling was widened in code, but a custom role stores its
-- own capability list (`custom_roles.capabilities_json`, 0071), so a role saved before this wave
-- would silently lose those screens. This back-fills, once, the new capability next to the one
-- that used to open the same route, so every stored role keeps exactly the access it had. Roles
-- saved afterwards are edited freely in the matrix (D7); nothing here runs again.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain UPDATEs with JSON_CONTAINS / JSON_ARRAY_APPEND / JSON_QUOTE (no `->`, no MEMBER OF, no
-- CAST AS JSON), each guarded so a role that already holds the new capability is untouched.
-- Idempotent: running it twice changes nothing the second time.


-- the People directory rode work.read (implicit for every member): work.read -> people.view.
UPDATE custom_roles
   SET capabilities_json = JSON_ARRAY_APPEND(capabilities_json, '$', 'people.view')
 WHERE JSON_VALID(capabilities_json)
   AND JSON_CONTAINS(capabilities_json, JSON_QUOTE('work.read'))
   AND NOT JSON_CONTAINS(capabilities_json, JSON_QUOTE('people.view'));

-- Insights rode work.read: work.read -> report.view.
UPDATE custom_roles
   SET capabilities_json = JSON_ARRAY_APPEND(capabilities_json, '$', 'report.view')
 WHERE JSON_VALID(capabilities_json)
   AND JSON_CONTAINS(capabilities_json, JSON_QUOTE('work.read'))
   AND NOT JSON_CONTAINS(capabilities_json, JSON_QUOTE('report.view'));

-- minting an AI connector token and its pending actions rode work.read: work.read -> ai.use.
UPDATE custom_roles
   SET capabilities_json = JSON_ARRAY_APPEND(capabilities_json, '$', 'ai.use')
 WHERE JSON_VALID(capabilities_json)
   AND JSON_CONTAINS(capabilities_json, JSON_QUOTE('work.read'))
   AND NOT JSON_CONTAINS(capabilities_json, JSON_QUOTE('ai.use'));

-- decision reads rode work.read: work.read -> decision.read.
UPDATE custom_roles
   SET capabilities_json = JSON_ARRAY_APPEND(capabilities_json, '$', 'decision.read')
 WHERE JSON_VALID(capabilities_json)
   AND JSON_CONTAINS(capabilities_json, JSON_QUOTE('work.read'))
   AND NOT JSON_CONTAINS(capabilities_json, JSON_QUOTE('decision.read'));

-- decision reads rode meeting.read: meeting.read -> decision.read.
UPDATE custom_roles
   SET capabilities_json = JSON_ARRAY_APPEND(capabilities_json, '$', 'decision.read')
 WHERE JSON_VALID(capabilities_json)
   AND JSON_CONTAINS(capabilities_json, JSON_QUOTE('meeting.read'))
   AND NOT JSON_CONTAINS(capabilities_json, JSON_QUOTE('decision.read'));

-- decision writes rode meeting.write: meeting.write -> decision.write.
UPDATE custom_roles
   SET capabilities_json = JSON_ARRAY_APPEND(capabilities_json, '$', 'decision.write')
 WHERE JSON_VALID(capabilities_json)
   AND JSON_CONTAINS(capabilities_json, JSON_QUOTE('meeting.write'))
   AND NOT JSON_CONTAINS(capabilities_json, JSON_QUOTE('decision.write'));

-- deleting a work item rode work.update: work.update -> work.delete.
UPDATE custom_roles
   SET capabilities_json = JSON_ARRAY_APPEND(capabilities_json, '$', 'work.delete')
 WHERE JSON_VALID(capabilities_json)
   AND JSON_CONTAINS(capabilities_json, JSON_QUOTE('work.update'))
   AND NOT JSON_CONTAINS(capabilities_json, JSON_QUOTE('work.delete'));

-- deleting a folder rode file.upload: file.upload -> file.delete.
UPDATE custom_roles
   SET capabilities_json = JSON_ARRAY_APPEND(capabilities_json, '$', 'file.delete')
 WHERE JSON_VALID(capabilities_json)
   AND JSON_CONTAINS(capabilities_json, JSON_QUOTE('file.upload'))
   AND NOT JSON_CONTAINS(capabilities_json, JSON_QUOTE('file.delete'));

-- billing rode org.manage: org.manage -> billing.view.
UPDATE custom_roles
   SET capabilities_json = JSON_ARRAY_APPEND(capabilities_json, '$', 'billing.view')
 WHERE JSON_VALID(capabilities_json)
   AND JSON_CONTAINS(capabilities_json, JSON_QUOTE('org.manage'))
   AND NOT JSON_CONTAINS(capabilities_json, JSON_QUOTE('billing.view'));

-- billing rode org.manage: org.manage -> billing.manage.
UPDATE custom_roles
   SET capabilities_json = JSON_ARRAY_APPEND(capabilities_json, '$', 'billing.manage')
 WHERE JSON_VALID(capabilities_json)
   AND JSON_CONTAINS(capabilities_json, JSON_QUOTE('org.manage'))
   AND NOT JSON_CONTAINS(capabilities_json, JSON_QUOTE('billing.manage'));
