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
  // ---- platform-admin v2 · PA-10 ----
  'platform.billing_mode_changed',
  'platform.beta_banner_updated',
  'platform.integration_enabled',
  'platform.integration_disabled',
  'platform.retention_updated',
  'platform.support_defaults_updated',
  'platform.flag_updated',
  'platform.flag_org_override_set',
  'platform.flag_org_override_removed',
  'platform.announcement_created',
  'platform.announcement_updated',
  'platform.announcement_published',
  'platform.announcement_unpublished',
  'platform.announcement_archived',
  'platform.maintenance_updated',
  'platform.maintenance_published',
  'platform.maintenance_ended',
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
  // R12: a person's sign-in trail exported as CSV (the window only, in after_json).
  'platform.user_sign_in_trail_exported',
  // ---- platform-admin v2 · PA-07 ----
  'platform.organization_created',
  'platform.organization_updated',
  'platform.organization_settings_changed',
  'platform.organization_policy_changed',
  'platform.organization_flag_changed',
  'platform.organization_plan_changed',
  'platform.organization_limits_changed',
  'platform.organization_storage_recounted',
  'platform.organization_storage_disconnected',
  'platform.member_role_changed',
  'platform.member_added',
  'platform.member_offboarded',
  'platform.invitation_revoked',
  'platform.organization_ownership_transferred',
  'platform.organization_deleted',
  'platform.organization_restored',
  'platform.organization_purge_requested',
  'platform.organization_archived',
  'platform.organization_unarchived',
  'platform.organization_policy_refreshed',
  // ---- platform-admin v2 · PA-08 ----
  'platform.content_edited',
  'platform.content_deleted',
  'platform.content_restored',
  'platform.content_downloaded',
  'platform.content_edit_refused',
  // ---- platform-admin v2 · PA-09 ----
  'platform.action_detail_viewed',
  'platform.export_requested',
  'platform.export_deleted',
  'platform.session_ended',
  // ---- 56-02 Keys ----
  'platform.key_rotation_started',
  // ---- 56-31 mail lanes ----
  'platform.mail_lane_paused',
  'platform.mail_lane_resumed',
  // ---- 56-17 vulnerability disclosure ----
  'platform.security_report_viewed',
  'platform.security_report_updated',
  // ---- 56-17 follow-up ---- the worker's 24-month purge (count only, system actor).
  'platform.security_reports_purged',
  // ---- 56-23 security signals ----
  'platform.alert_rule_updated',
  // ---- 56-21b platform access review ----
  'platform.access_review_recorded',
] as const;

export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];

export function isPlatformAuditAction(value: unknown): value is PlatformAuditAction {
  return typeof value === 'string' && (PLATFORM_AUDIT_ACTIONS as readonly string[]).includes(value);
}
