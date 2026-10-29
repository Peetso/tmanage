/**
 * Every action name `platform_admin_audit_events.action` may carry (VARCHAR(96), 0239).
 *
 * Append-only (platform-admin v2 build plan §2): each slice adds its own names in its own block at
 * the end, under its marker comment. The C4 "Platform admin actions" screen and its filter read
 * this list, so a name used without being listed here is a name the screen cannot offer.
 */
export const PLATFORM_AUDIT_ACTIONS = [
  // ── Before v2 (0206, wave 9) ────────────────────────────────────────────
  'platform.step_up',
  'platform.company_suspended',
  'platform.company_reactivated',
  'platform.user_signed_out',
  'platform.password_reset_sent',
  'platform.public_signup_opened',
  'platform.public_signup_closed',
  'platform.ai_access_on',
  'platform.ai_access_off',
  'platform.maintenance_scheduled',
  'platform.maintenance_unpublished',
  // ---- platform-admin v2 · PA-02 ----
  'platform.team_admin_added',
  'platform.team_admin_updated',
  'platform.team_admin_disabled',
  'platform.team_admin_enabled',
  'platform.team_admin_removed',
  'platform.team_preset_updated',
  // ---- platform-admin v2 · PA-04 ----
  'platform.org_role_created',
  'platform.org_role_updated',
  'platform.org_role_cloned',
  'platform.org_role_deleted',
  'platform.member_overrides_changed',
  // ---- platform-admin v2 · PA-05 ----
  'platform.support_session_started',
  'platform.support_session_extended',
  'platform.support_session_ended',
  // ---- platform-admin v2 · PA-06 ----
  'platform.user_profile_updated',
  'platform.user_disabled',
  'platform.user_enabled',
  'platform.user_two_step_reset',
  'platform.user_two_step_required',
  'platform.user_two_step_not_required',
  'platform.user_session_ended',
] as const;

export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];

export function isPlatformAuditAction(value: unknown): value is PlatformAuditAction {
  return typeof value === 'string' && (PLATFORM_AUDIT_ACTIONS as readonly string[]).includes(value);
}
