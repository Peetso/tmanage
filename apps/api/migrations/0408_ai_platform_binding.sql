-- 0408_ai_platform_binding — ADR-0015 part 2 (AI principals reach Platform admin only through a
-- step-up-bound path), review F1, F10 and point 9.
--
-- `oauth_grants` (tenant-owned) gains the external `tmanage:platform` scope's binding (F1):
-- - `platform_step_up_session_id`: the browser session the platform admin stepped up in on the
--   consent page. Every platform call through the grant re-checks that session's live step-up and
--   that the session is still signed in, so a sign-out or revocation ends the reach at once.
-- - `platform_until`: the end of the grant's own platform window (`PLATFORM_AI_SCOPE_MINUTES`,
--   default 60, at most 240), fixed at consent. A refresh token never extends it; a new window
--   needs a new consent after a fresh step-up. NULL on every grant without the platform scope.
--
-- `platform_admin_audit_events` (global) gains who an AI-run platform action was for (point 9,
-- F9, F10): `ai_client_name` ("TManage AI" or the OAuth client's name) and `ai_pending_action_id`
-- (the approved pending AI action it executed). NULL for a person's own click.
--
-- MariaDB-safe (DA-5): plain nullable ADD COLUMNs, no default expression, no generated column, no
-- CHECK, no IF NOT EXISTS (0400's form). Online on both engines (DA-7). Expand only (DA-6). No new
-- grant: the existing table grants cover both tables.

ALTER TABLE oauth_grants
  ADD COLUMN platform_step_up_session_id CHAR(36) NULL AFTER scopes,
  ADD COLUMN platform_until DATETIME(3) NULL AFTER platform_step_up_session_id,
  ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE platform_admin_audit_events
  ADD COLUMN ai_client_name VARCHAR(190) NULL,
  ADD COLUMN ai_pending_action_id CHAR(36) NULL,
  ALGORITHM=INPLACE, LOCK=NONE;
