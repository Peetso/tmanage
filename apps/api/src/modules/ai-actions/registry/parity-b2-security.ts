/**
 * AI action registry — parity pass, batch 2, lane `security` (owner 2026-11-23: the in-app AI and
 * the external MCP "should do whatever the account has the right to do").
 *
 * Routes withheld in `NEVER` without a reason ADR-0015 part 1 accepts (K1 sign-in, sessions,
 * password step-up and third-party credentials; K2 the AI's own surface; K3 raw secrets; K4 not an
 * account action; K5 already covered) become ops here: administration (audit retention, IP
 * allowlist, custom roles, security alerts and posture, access policies, block rules, file safety,
 * incidents), billing changes (plan-change requests, seats, subscription), permission overrides,
 * public links, external approvals, audit integrity, security signals, mail bounces, support
 * conversations, connectors and company sign-in reads. Existing onboarding / getting-started ops
 * get their missing details.
 *
 * Scope and risk rule: a GET is `read`/`read`. Every change is `confirm` — frozen in
 * `pending_ai_actions` and run once, as the member, after the member confirms on the card. Scope:
 * `billing.*` capabilities -> `billing`; org-wide settings, security, roles, integrations and
 * anything client-facing -> `manage`; the member's own everyday act (their own survey answer, their
 * own support conversation) -> `write`. The route's `@RequireCapability` and each service's own
 * `authorize()` (owner-only checks included) still decide every call. Inputs mirror each
 * controller's parser; `orgSlug` is never an argument.
 */
import { z } from 'zod';
import {
  AUDIENCES,
  CAPABILITIES,
  PUBLIC_LINK_BULK_MAX,
  PUBLIC_LINK_SEARCH_MAX,
  PUBLIC_LINK_STATE_FILTERS,
  type Capability,
} from '@tmanage/domain';
import type { AiActionOp, AiScope, HttpMethod, RiskClass, Sensitivity } from './types.js';
import { bodyArgs, det, f, noArgs, pathOnly, type AiActionDetail } from './detail.js';

const ORG = '/v1/organizations/:orgSlug';

function op(
  id: string,
  method: HttpMethod,
  path: string,
  capability: Capability | null,
  risk: RiskClass,
  scope: AiScope,
): AiActionOp {
  return { id, method, path: `${ORG}${path}`, capability, risk, scope };
}

const READ = ['read', 'read'] as const;
const MANAGE = ['confirm', 'manage'] as const;
const BILLING = ['confirm', 'billing'] as const;
const OWN = ['confirm', 'write'] as const;

// Mirrored parser constants (the API modules own them; kept here so the registry does not import
// controllers). Each names its source.
/** `admin/audit-retention.service.ts` MIN/MAX_RETENTION_DAYS. */
const RETENTION_DAYS_MAX = 3650;
/** `admin/ip-allowlist.service.ts` MAX_LABEL_LENGTH. */
const IP_LABEL_MAX = 120;
/** `admin/cidr.ts` MAX_IP_ALLOWLIST_ENTRIES. */
const IP_ALLOWLIST_MAX = 50;
/** `admin/roles.controller.ts` / `role-edit.controller.ts` validateName. */
const ROLE_NAME_MAX = 128;
/** `admin/security-alerts.service.ts` SECURITY_ALERT_EVENT_KEYS. */
const SECURITY_ALERT_EVENT_KEYS = [
  'membership.revoked',
  'membership.offboarded',
  'project_membership.revoked',
  'project_membership.role_changed',
  'client_membership.role_changed',
  'client_membership.status_changed',
  'invitation.revoked',
  'session_revoked',
  'mfa_factor_enrolled',
  'file_asset.scan_failed',
  'file_asset.rejected',
] as const;
/** `admin/policies.allowlist.ts` IDLE_SIGNOUT_CHOICES, MAX_SESSION_HOURS, MAX_DOMAINS, ceilings. */
const IDLE_SIGNOUT_CHOICES = [0, 30, 60, 240, 480] as const;
const SESSION_HOURS_MAX = 720;
const INVITE_DOMAINS_MAX = 50;
const PAT_EXPIRY_CEILING_DAYS = 730;
/** `oauth/scopes.ts` KNOWN_SCOPES. */
const TOKEN_SCOPES = [
  'tmanage:read',
  'tmanage:write',
  'tmanage:manage',
  'tmanage:billing',
] as const;
/** `billing/plan-catalog.ts` PLAN_IDS plus the legacy alias `pro` (isPlanId). */
const PLAN_CODES = ['free', 'starter', 'studio', 'business', 'enterprise', 'pro'] as const;
/** `billing/plan-change-requests.controller.ts` NOTE_MAX_LENGTH. */
const PLAN_NOTE_MAX = 2000;
/** `tenancy/override-ceiling.ts` OVERRIDES_PER_MEMBER_MAX, OVERRIDE_REASON_MAX. */
const OVERRIDES_MAX = 112;
const OVERRIDE_REASON_MAX = 500;
/** `public-abuse/block-rules.repository.ts` BLOCK_RULE_KINDS; controller MAX_REASON. */
const BLOCK_RULE_KINDS = ['email', 'domain', 'ip'] as const;
const BLOCK_REASON_MAX = 200;
/** `pricing-survey/pricing-survey.rules.ts` PRICING_BANDS, PRICING_SURVEY_NOTE_MAX. */
const PRICING_BANDS = ['nothing', 'under_5', '5_9', '10_15', 'over_15'] as const;
const PRICING_NOTE_MAX = 500;
/** `public-links/public-link-targets.ts` PUBLIC_LINK_KINDS; `public-links.service.ts` bounds. */
const PUBLIC_LINK_KINDS = ['approval', 'intake', 'quote', 'share', 'magic_signin'] as const;
const LINK_EMAIL_MAX = 320;
const LINK_EXPIRY_DAYS_MAX = 30;
/** `approvals/external-approvals.service.ts` MAX_NAME, MAX_MESSAGE, MAX_EXPIRY_DAYS. */
const APPROVER_NAME_MAX = 120;
const APPROVER_MESSAGE_MAX = 1000;
const APPROVAL_EXPIRY_DAYS_MAX = 30;
/** `security-signals/security-signals.service.ts` MAX_PAGE. */
const SIGNAL_PAGE_MAX = 100;
/** `mail-bounces/mail-bounces.service.ts` MAX_ADDRESS. */
const MAIL_ADDRESS_MAX = 320;
/** `files/file-safety.ts` FILE_TYPE_PRESETS. */
const FILE_TYPE_PRESETS = ['documents', 'images', 'design', 'video', 'archives'] as const;
/** `tenancy/client-file-policy.controller.ts` isClientFilesPolicy. */
const CLIENT_FILES_POLICIES = ['checked', 'virus_scanned'] as const;
/** `support/support-sla.ts` SUPPORT_CATEGORIES, SUPPORT_PRIORITIES; `support.policy.ts` bounds. */
const SUPPORT_CATEGORIES = [
  'question',
  'problem',
  'billing',
  'account',
  'feature_request',
  'other',
] as const;
const SUPPORT_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const SUPPORT_SUBJECT_MAX = 160;
const SUPPORT_BODY_MAX = 5000;
const SUPPORT_PATH_MAX = 300;
/** `app-connect/app-connect.flow.ts` APP_CONNECT_PROVIDERS. */
const APP_CONNECT_PROVIDERS = ['github'] as const;
/** `home/onboarding-tour.steps.ts` ONBOARDING_TOUR steps. */
const TOUR_STEPS = [
  'welcome',
  'create_project',
  'invite_team',
  'explore_work',
  'share_portal',
] as const;
/** `onboarding/onboarding-wizard.state.ts` WIZARD_STEPS, WIZARD_OUTCOMES. */
const WIZARD_STEPS = [
  'company',
  'work_type',
  'invite',
  'storage',
  'sample_project',
  'finish',
] as const;
const WIZARD_OUTCOMES = ['done', 'skipped'] as const;
/** `getting-started/getting-started.steps.ts` CHECKLIST_STEPS. */
const CHECKLIST_STEPS = [
  'invite_teammate',
  'create_project',
  'add_client',
  'connect_storage',
  'set_working_hours',
  'try_ai_assistant',
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const uuid = () => z.string().regex(UUID);
const day = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const capEnum = () => z.enum(CAPABILITIES);
const email = (max: number) => z.string().min(3).max(max);

const U1 = '3f2b6c1e-8a4d-4e2f-9b1a-2c3d4e5f6a7b';
const U2 = '7a1d2e3f-4b5c-4d6e-8f9a-0b1c2d3e4f5a';

/** One op per route moved out of NEVER in this lane (71 routes). */
export const securityOps: readonly AiActionOp[] = [
  // Administration: audit retention, IP allowlist, roles, alerts, security posture.
  op('admin.audit_retention.get', 'GET', '/admin/audit-retention/', 'org.manage', ...READ),
  op('admin.audit_retention.set', 'PUT', '/admin/audit-retention/', 'org.manage', ...MANAGE),
  op('admin.ip_allowlist.list', 'GET', '/admin/ip-allowlist/', 'org.security.manage', ...READ),
  op('admin.ip_allowlist.create', 'POST', '/admin/ip-allowlist/', 'org.security.manage', ...MANAGE),
  op(
    'admin.ip_allowlist.delete',
    'DELETE',
    '/admin/ip-allowlist/:entryId',
    'org.security.manage',
    ...MANAGE,
  ),
  op('admin.roles.list', 'GET', '/admin/roles/', 'org.manage', ...READ),
  op('admin.roles.create', 'POST', '/admin/roles/', 'org.manage', ...MANAGE),
  op('admin.roles.update', 'PATCH', '/admin/roles/:id', 'org.manage', ...MANAGE),
  op('admin.roles.clone', 'POST', '/admin/roles/:id/clone', 'org.manage', ...MANAGE),
  op('admin.roles.matrix.get', 'GET', '/admin/roles/matrix/', 'org.manage', ...READ),
  op(
    'admin.security_alerts.delete',
    'DELETE',
    '/admin/security-alerts/',
    'org.security.manage',
    ...MANAGE,
  ),
  op(
    'admin.security_alerts.list',
    'GET',
    '/admin/security-alerts/',
    'org.security.manage',
    ...READ,
  ),
  op(
    'admin.security_alerts.set',
    'PUT',
    '/admin/security-alerts/',
    'org.security.manage',
    ...MANAGE,
  ),
  op('admin.security.get', 'GET', '/admin/security/', 'org.manage', ...READ),
  op('admin.security.set', 'PUT', '/admin/security/', 'org.manage', ...MANAGE),
  // Billing changes.
  op(
    'billing.plan_change_requests.create',
    'POST',
    '/billing/plan-change-requests/',
    'billing.manage',
    ...BILLING,
  ),
  op(
    'billing.plan_change_requests.cancel',
    'PUT',
    '/billing/plan-change-requests/:id/cancel',
    'billing.manage',
    ...BILLING,
  ),
  op('billing.seats.create', 'POST', '/billing/seats/', 'billing.manage', ...BILLING),
  op('billing.seats.delete', 'DELETE', '/billing/seats/:seatId', 'billing.manage', ...BILLING),
  op(
    'billing.subscription.change',
    'POST',
    '/billing/subscription/change',
    'billing.manage',
    ...BILLING,
  ),
  // Access policies.
  op('org.policies.get', 'GET', '/policies/', 'org.manage', ...READ),
  op('org.policies.set', 'PUT', '/policies/', 'org.manage', ...MANAGE),
  op('org.policies.simulate', 'POST', '/policies/simulate/', 'org.manage', ...MANAGE),
  // Sessions (the admin trail export; the list and revoke ops already exist).
  op(
    'admin.sessions.trail.get',
    'GET',
    '/admin/sessions/:sessionId/trail.csv',
    'org.manage',
    ...READ,
  ),
  // Permission overrides and effective permissions.
  op(
    'people.permission_overrides.list',
    'GET',
    '/people/:membershipId/permissions/overrides',
    'roles.assign',
    ...READ,
  ),
  op(
    'people.permission_overrides.set',
    'PUT',
    '/people/:membershipId/permissions/overrides',
    'roles.assign',
    ...MANAGE,
  ),
  op(
    'people.effective_permissions.get',
    'GET',
    '/people/:membershipId/effective-permissions',
    'people.view',
    ...READ,
  ),
  op('org.me.get', 'GET', '/me', 'approval.read', ...READ),
  // Public-abuse block list.
  op('admin.block_rules.list', 'GET', '/admin/block-rules/', 'org.security.manage', ...READ),
  op('admin.block_rules.create', 'POST', '/admin/block-rules/', 'org.security.manage', ...MANAGE),
  op(
    'admin.block_rules.delete',
    'DELETE',
    '/admin/block-rules/:ruleId',
    'org.security.manage',
    ...MANAGE,
  ),
  // The member's own pricing-survey answer.
  op('pricing_survey.get', 'GET', '/pricing-survey/', 'work.read', ...READ),
  op('pricing_survey.answer', 'POST', '/pricing-survey/answer', 'work.read', ...OWN),
  op('pricing_survey.skip', 'POST', '/pricing-survey/skip', 'work.read', ...OWN),
  // The owner's invite link.
  op('referral.get', 'GET', '/referral/', 'org.manage', ...READ),
  op('referral.code.create', 'POST', '/referral/code', 'org.manage', ...MANAGE),
  // Public links and the organization-wide link manager.
  op('public_links.list', 'GET', '/public-links/', 'work.read', ...READ),
  op('public_links.create', 'POST', '/public-links/', 'work.read', ...MANAGE),
  op('public_links.delete', 'DELETE', '/public-links/:linkId', 'work.read', ...MANAGE),
  op('public_links.manage.list', 'GET', '/public-links/manage/', 'org.security.manage', ...READ),
  op(
    'public_links.manage.revoke',
    'POST',
    '/public-links/manage/revoke',
    'org.security.manage',
    ...MANAGE,
  ),
  op(
    'public_links.manage.expiry',
    'POST',
    '/public-links/manage/expiry',
    'org.security.manage',
    ...MANAGE,
  ),
  // External approvers on a deliverable version.
  op(
    'approvals.external_approvals.list',
    'GET',
    '/deliverables/:deliverableId/versions/:versionId/external-approvals',
    'deliverable.publish',
    ...READ,
  ),
  op(
    'approvals.external_approvals.create',
    'POST',
    '/deliverables/:deliverableId/versions/:versionId/external-approvals',
    'deliverable.publish',
    ...MANAGE,
  ),
  // Audit chain and security signals.
  op('audit.integrity.get', 'GET', '/admin/audit/integrity', 'audit.read', ...READ),
  op('audit.catalog.list', 'GET', '/admin/audit/catalog', 'audit.read', ...READ),
  op('audit.export_signature.get', 'GET', '/admin/audit/export.sig', 'audit.export', ...READ),
  op('admin.security_events.list', 'GET', '/admin/security/events', 'audit.read', ...READ),
  op(
    'admin.security_events.reviewed.create',
    'POST',
    '/admin/security/events/:signalId/reviewed',
    'org.security.manage',
    ...MANAGE,
  ),
  // File safety, mail bounces, incidents, client file policy.
  op(
    'admin.file_safety.blocked.list',
    'GET',
    '/admin/file-safety/blocked/',
    'org.security.manage',
    ...READ,
  ),
  op(
    'admin.file_safety.blocked.delete',
    'POST',
    '/admin/file-safety/blocked/:fileId/delete',
    'org.security.manage',
    ...MANAGE,
  ),
  op('mail.bounces.status', 'POST', '/mail/bounces/status', 'org.security.manage', ...MANAGE),
  op('mail.bounces.clear', 'POST', '/mail/bounces/clear', 'org.security.manage', ...MANAGE),
  op('admin.incidents.list', 'GET', '/admin/incidents/', 'org.manage', ...READ),
  op(
    'security.sign_in_policy.get',
    'GET',
    '/security/sign-in-policy',
    'org.security.manage',
    ...READ,
  ),
  op(
    'org.settings.file_safety.set',
    'PUT',
    '/security/file-safety/',
    'org.security.manage',
    ...MANAGE,
  ),
  op('org.settings.client_file_policy.get', 'GET', '/client-file-policy/', 'org.manage', ...READ),
  op(
    'org.settings.client_file_policy.set',
    'PATCH',
    '/client-file-policy/',
    'org.manage',
    ...MANAGE,
  ),
  // The member's own conversations with the TManage support team.
  op('support.threads.list', 'GET', '/support/threads/', 'work.read', ...READ),
  op('support.threads.create', 'POST', '/support/threads/', 'work.read', ...OWN),
  op('support.threads.get', 'GET', '/support/threads/:threadId', 'work.read', ...READ),
  op(
    'support.threads.messages.create',
    'POST',
    '/support/threads/:threadId/messages',
    'work.read',
    ...OWN,
  ),
  op('support.threads.close', 'POST', '/support/threads/:threadId/close', 'work.read', ...OWN),
  // Connectors and app connections (reads and removal; install and connect stay K1).
  op('connectors.list', 'GET', '/connectors/', 'org.manage', ...READ),
  op('connectors.get', 'GET', '/connectors/:connectorKey', 'org.manage', ...READ),
  op('connectors.delete', 'DELETE', '/connectors/:connectorKey', 'org.manage', ...MANAGE),
  op('app_connect.get', 'GET', '/app-connect/:provider', 'org.manage', ...READ),
  op('app_connect.delete', 'DELETE', '/app-connect/:provider', 'org.manage', ...MANAGE),
  // Company sign-in (reads and removal; saving the client secret stays K1).
  op('security.sso.get', 'GET', '/security/sso/', 'org.security.manage', ...READ),
  op('security.sso.delete', 'DELETE', '/security/sso/', 'org.security.manage', ...MANAGE),
  op('security.scim.get', 'GET', '/security/scim/', 'org.security.manage', ...READ),
];

/** Sensitivity of every new op that is not a read (money > hr > destructive > external > none). */
export const securitySensitivity: Readonly<Record<string, Sensitivity>> = {
  // Sets the window a later purge deletes audit history by.
  'admin.audit_retention.set': 'destructive',
  'admin.ip_allowlist.create': 'none',
  'admin.ip_allowlist.delete': 'destructive',
  'admin.roles.create': 'hr',
  'admin.roles.update': 'hr',
  'admin.roles.clone': 'hr',
  'admin.security_alerts.delete': 'destructive',
  'admin.security_alerts.set': 'none',
  'admin.security.set': 'none',
  'billing.plan_change_requests.create': 'money',
  'billing.plan_change_requests.cancel': 'money',
  'billing.seats.create': 'money',
  'billing.seats.delete': 'money',
  'billing.subscription.change': 'money',
  'org.policies.set': 'none',
  'org.policies.simulate': 'none',
  'people.permission_overrides.set': 'hr',
  'admin.block_rules.create': 'none',
  'admin.block_rules.delete': 'destructive',
  // The answer goes to the TManage team.
  'pricing_survey.answer': 'external',
  'pricing_survey.skip': 'none',
  'referral.code.create': 'none',
  'public_links.create': 'external',
  'public_links.delete': 'destructive',
  'public_links.manage.revoke': 'destructive',
  'public_links.manage.expiry': 'external',
  'approvals.external_approvals.create': 'external',
  'admin.security_events.reviewed.create': 'none',
  'admin.file_safety.blocked.delete': 'destructive',
  'mail.bounces.status': 'none',
  'mail.bounces.clear': 'external',
  'org.settings.file_safety.set': 'none',
  'org.settings.client_file_policy.set': 'external',
  'support.threads.create': 'external',
  'support.threads.messages.create': 'external',
  'support.threads.close': 'none',
  'connectors.delete': 'destructive',
  'app_connect.delete': 'destructive',
  'security.sso.delete': 'destructive',
};

const roleBody = {
  name: f.shortText(ROLE_NAME_MAX),
  audience: z.enum(['internal', 'client']).nullish(),
};

const overrideEntry = z
  .object({
    capability: capEnum(),
    effect: z.enum(['allow', 'deny']),
    reason: z.string().max(OVERRIDE_REASON_MAX).nullish(),
    expiresAt: f.iso().nullish(),
  })
  .strict();

const linkIds = () => z.array(uuid()).min(1).max(PUBLIC_LINK_BULK_MAX);

/** One detail per new op, then the onboarding / getting-started / file-safety D ops. */
export const securityDetails: readonly AiActionDetail[] = [
  det({
    id: 'admin.audit_retention.get',
    title: 'Read the audit retention policy',
    description:
      'The retention window in days (null when audit history is kept forever) and a read-only ' +
      'preview of how many audit events fall outside it. Nothing is purged.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Current policy', args: {} }],
  }),
  det({
    id: 'admin.audit_retention.set',
    title: 'Set the audit retention window',
    description:
      'Set how many days of audit history to keep (whole days, 1-3650) and return the policy with ' +
      'the fresh purge preview. This call deletes nothing; a later purge removes older events.',
    input: bodyArgs([], { retentionDays: f.int(1, RETENTION_DAYS_MAX) }),
    redact: 'config',
    examples: [{ summary: 'Keep two years', args: { retentionDays: 730 } }],
  }),
  det({
    id: 'admin.ip_allowlist.list',
    title: 'List the IP allowlist',
    description:
      "The company's advisory list of allowed IP addresses and CIDR ranges, each with its id and " +
      'optional label. The list is recorded only; requests are not refused by source address yet.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'All entries', args: {} }],
  }),
  det({
    id: 'admin.ip_allowlist.create',
    title: 'Add an IP allowlist entry',
    description:
      'Add one IPv4/IPv6 address or CIDR range (stored in canonical form) with an optional label ' +
      '(up to 120 characters). A range already on the list is refused (409).',
    input: bodyArgs([], {
      cidr: f.shortText(64),
      label: z.string().max(IP_LABEL_MAX).nullish(),
    }),
    redact: 'config',
    examples: [{ summary: 'Office range', args: { cidr: '203.0.113.0/24', label: 'Office' } }],
  }),
  det({
    id: 'admin.ip_allowlist.delete',
    title: 'Remove an IP allowlist entry',
    description:
      'Remove one entry by entryId (from admin.ip_allowlist.list). An unknown id is a 404.',
    input: pathOnly('entryId'),
    redact: 'config',
    examples: [{ summary: 'Remove one', args: { entryId: U1 } }],
  }),
  det({
    id: 'admin.roles.list',
    title: 'List custom roles',
    description: "The company's custom roles: id, name, capabilities and when each was created.",
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'All custom roles', args: {} }],
  }),
  det({
    id: 'admin.roles.create',
    title: 'Create a custom role',
    description:
      'Create a role from a name (up to 128 characters, unique) and a non-empty list of ' +
      'capabilities; returns every custom role. You can only grant capabilities you hold yourself ' +
      "(403 otherwise); audience 'client' holds the list to the client ceiling.",
    input: bodyArgs([], { ...roleBody, capabilities: z.array(capEnum()).min(1) }),
    redact: 'standard',
    examples: [
      {
        summary: 'A read-only reviewer role',
        args: { name: 'Reviewer', capabilities: ['work.read', 'approval.read'] },
      },
    ],
  }),
  det({
    id: 'admin.roles.update',
    title: 'Edit a custom role',
    description:
      'Rename a custom role and replace its capability list (id from admin.roles.list). Owner or ' +
      'org admin only; every holder of the role gains or loses with it. Same rules as create.',
    input: bodyArgs(['id'], { ...roleBody, capabilities: z.array(capEnum()).min(1) }),
    redact: 'standard',
    examples: [
      {
        summary: 'Add approvals',
        args: { id: U1, name: 'Reviewer', capabilities: ['work.read', 'approval.read'] },
      },
    ],
  }),
  det({
    id: 'admin.roles.clone',
    title: 'Copy a custom role',
    description:
      'Create a new role with a new unique name and the same capabilities as role id (from ' +
      'admin.roles.list). The copied list is checked against what you may grant.',
    input: bodyArgs(['id'], roleBody),
    redact: 'standard',
    examples: [{ summary: 'Copy Reviewer', args: { id: U1, name: 'Reviewer (copy)' } }],
  }),
  det({
    id: 'admin.roles.matrix.get',
    title: 'Read the roles and permissions matrix',
    description:
      'Every built-in and custom role against every capability, as the Roles screen shows it.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'The matrix', args: {} }],
  }),
  det({
    id: 'admin.security_alerts.list',
    title: 'Read security alert settings',
    description:
      'The event types an alert can watch, which ones are on, and recent matching audit events ' +
      '(read-only preview).',
    input: noArgs(),
    redact: 'audit',
    examples: [{ summary: 'Alert settings', args: {} }],
  }),
  det({
    id: 'admin.security_alerts.set',
    title: 'Turn a security alert on or off',
    description:
      'Switch the alert for one event type on or off. eventTypeKey must be one of the listed ' +
      'security event types (admin.security_alerts.list).',
    input: bodyArgs([], { eventTypeKey: z.enum(SECURITY_ALERT_EVENT_KEYS), enabled: f.bool() }),
    redact: 'audit',
    examples: [
      {
        summary: 'Alert on revoked members',
        args: { eventTypeKey: 'membership.revoked', enabled: true },
      },
    ],
  }),
  det({
    id: 'admin.security_alerts.delete',
    title: 'Remove a security alert setting',
    description: "Remove one event type's alert setting (idempotent).",
    input: bodyArgs([], { eventTypeKey: z.enum(SECURITY_ALERT_EVENT_KEYS) }),
    redact: 'audit',
    examples: [{ summary: 'Remove one', args: { eventTypeKey: 'session_revoked' } }],
  }),
  det({
    id: 'admin.security.get',
    title: 'Read the company security settings',
    description: 'Whether two-step sign-in is enforced and the trusted IP list.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Security settings', args: {} }],
  }),
  det({
    id: 'admin.security.set',
    title: 'Change the company security settings',
    description:
      'Turn enforced two-step sign-in on or off and optionally replace the trusted IP list (up to ' +
      '50 addresses or CIDR ranges; omit it to keep the stored list). Company owner only; turning ' +
      'enforcement on is refused unless the owner already uses two-step sign-in.',
    input: bodyArgs([], {
      enforce2fa: f.bool(),
      ipAllowlist: z.array(z.string().max(64)).max(IP_ALLOWLIST_MAX).optional(),
    }),
    redact: 'config',
    examples: [{ summary: 'Enforce two-step', args: { enforce2fa: true } }],
  }),
  det({
    id: 'billing.plan_change_requests.create',
    title: 'Request a plan change',
    description:
      'Ask to move the company to another plan from effectiveOn (YYYY-MM-DD, today or later) with ' +
      'an optional note. Only one request may be pending (409); billing.plan_change_requests.list ' +
      'shows them.',
    input: bodyArgs([], {
      targetPlanCode: z.enum(PLAN_CODES),
      effectiveOn: day(),
      note: z.string().max(PLAN_NOTE_MAX).nullish(),
    }),
    redact: 'billing',
    examples: [
      {
        summary: 'Move to Business',
        args: { targetPlanCode: 'business', effectiveOn: '2026-12-01' },
      },
    ],
  }),
  det({
    id: 'billing.plan_change_requests.cancel',
    title: 'Cancel a plan-change request',
    description:
      'Cancel one plan-change request by id (billing.plan_change_requests.list). Idempotent.',
    input: pathOnly('id'),
    redact: 'billing',
    examples: [{ summary: 'Cancel', args: { id: U1 } }],
  }),
  det({
    id: 'billing.seats.create',
    title: 'Assign a paid seat',
    description:
      'Give a member a billing seat (membershipId from members.list). A member who already holds ' +
      'an active seat is refused (409).',
    input: bodyArgs([], { membershipId: f.id() }),
    redact: 'billing',
    examples: [{ summary: 'Seat for one member', args: { membershipId: U1 } }],
  }),
  det({
    id: 'billing.seats.delete',
    title: 'Release a paid seat',
    description:
      'Release one seat by seatId (billing.seats.list). An already-released seat is a 404.',
    input: pathOnly('seatId'),
    redact: 'billing',
    examples: [{ summary: 'Release', args: { seatId: U1 } }],
  }),
  det({
    id: 'billing.subscription.change',
    title: 'Change the subscription plan',
    description:
      "Request a change of the company's subscription to planId (a catalog plan; " +
      'billing.plan.get and billing.plan_change.preview show the plans and the effect). Returns ' +
      'the subscription.',
    input: bodyArgs([], { planId: z.enum(PLAN_CODES) }),
    redact: 'billing',
    examples: [{ summary: 'Studio plan', args: { planId: 'studio' } }],
  }),
  det({
    id: 'org.policies.get',
    title: 'Read the access policies',
    description:
      'Session lifetime, invite-domain allowlist, guest access, idle sign-out and the personal ' +
      'access token policy (defaults when never set).',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Access policies', args: {} }],
  }),
  det({
    id: 'org.policies.set',
    title: 'Change the access policies',
    description:
      'Change any of the access policies; omitted keys keep their value. session_max_hours 1-720; ' +
      'invite_domain_allowlist up to 50 domains (empty means no restriction); ' +
      'idle_signout_minutes one of 0 (off), 30, 60, 240, 480; pat.max_expiry_days 1-730; ' +
      'pat.allowed_scopes a non-empty list of token scopes.',
    input: bodyArgs([], {
      session_max_hours: f.int(1, SESSION_HOURS_MAX).optional(),
      invite_domain_allowlist: z
        .array(z.string().min(1).max(253))
        .max(INVITE_DOMAINS_MAX)
        .optional(),
      guest_access_enabled: f.bool().optional(),
      idle_signout_minutes: z
        .number()
        .int()
        .refine((v) => (IDLE_SIGNOUT_CHOICES as readonly number[]).includes(v))
        .optional(),
      'pat.max_expiry_days': f.int(1, PAT_EXPIRY_CEILING_DAYS).optional(),
      'pat.allow_no_expiry': f.bool().optional(),
      'pat.allowed_scopes': z.array(z.enum(TOKEN_SCOPES)).min(1).optional(),
    }),
    redact: 'config',
    examples: [
      {
        summary: '12-hour sessions, guests off',
        args: { session_max_hours: 12, guest_access_enabled: false },
      },
    ],
  }),
  det({
    id: 'org.policies.simulate',
    title: 'Simulate an access decision',
    description:
      'Ask whether one member (memberId = a membership id from members.list) would be allowed a ' +
      'capability, optionally in a project and audience. Changes nothing; returns the verdict and ' +
      'its reason.',
    input: bodyArgs([], {
      memberId: f.id(),
      capability: capEnum(),
      context: z
        .object({ projectId: f.id().nullish(), audience: z.enum(AUDIENCES).optional() })
        .strict()
        .optional(),
    }),
    redact: 'standard',
    examples: [
      { summary: 'Can they approve?', args: { memberId: U1, capability: 'approval.read' } },
    ],
  }),
  det({
    id: 'admin.sessions.trail.get',
    title: "Download a session's sign-in trail",
    description:
      'The result is a CSV file (session-trail.csv) of where and when one session was used ' +
      '(sessionId from admin.sessions.list); admin.sessions.list gives the same session facts as JSON.',
    input: pathOnly('sessionId'),
    redact: 'audit',
    examples: [{ summary: 'Trail of one session', args: { sessionId: U1 } }],
  }),
  det({
    id: 'people.permission_overrides.list',
    title: "List a member's permission overrides",
    description:
      'The allow/deny overrides placed on one member (membershipId from members.list), with ' +
      'reason and expiry.',
    input: pathOnly('membershipId'),
    redact: 'people',
    examples: [{ summary: 'Overrides', args: { membershipId: U1 } }],
  }),
  det({
    id: 'people.permission_overrides.set',
    title: "Replace a member's permission overrides",
    description:
      'Replace the whole override list of one member: each entry a capability (once), allow or ' +
      'deny, an optional reason (500) and an optional future expiresAt (ISO). An empty list clears ' +
      'them. Refused for owners, for your own membership and for an allow beyond your own rights.',
    input: bodyArgs(['membershipId'], {
      overrides: z.array(overrideEntry).max(OVERRIDES_MAX),
    }),
    redact: 'people',
    examples: [
      {
        summary: 'Deny exports',
        args: {
          membershipId: U1,
          overrides: [{ capability: 'audit.export', effect: 'deny', reason: 'Contractor' }],
        },
      },
    ],
  }),
  det({
    id: 'people.effective_permissions.get',
    title: 'Show what a member can do',
    description:
      "One member's effective capabilities (role plus overrides), optionally inside one project " +
      '(projectId, a project UUID from projects.list).',
    input: bodyArgs(['membershipId'], { projectId: uuid().optional() }),
    redact: 'people',
    examples: [{ summary: 'In a project', args: { membershipId: U1, projectId: U2 } }],
  }),
  det({
    id: 'org.me.get',
    title: 'Show my role and permissions',
    description:
      'Your own membership: membershipId, role, effective capabilities, overrides and any open ' +
      'support session.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Who am I here', args: {} }],
  }),
  det({
    id: 'admin.block_rules.list',
    title: 'List the public block rules',
    description:
      'E-mail addresses, domains and IPs refused on public forms and links, each with its reason.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'All rules', args: {} }],
  }),
  det({
    id: 'admin.block_rules.create',
    title: 'Block an e-mail, domain or IP',
    description:
      "Add a block rule: kind 'email', 'domain' or 'ip', the value, and an optional reason (200). " +
      'A rule already listed is refused (409).',
    input: bodyArgs([], {
      kind: z.enum(BLOCK_RULE_KINDS),
      value: f.shortText(320),
      reason: z.string().max(BLOCK_REASON_MAX).nullish(),
    }),
    redact: 'config',
    examples: [{ summary: 'Block a domain', args: { kind: 'domain', value: 'spam.example' } }],
  }),
  det({
    id: 'admin.block_rules.delete',
    title: 'Remove a block rule',
    description: 'Remove one block rule by ruleId (admin.block_rules.list).',
    input: pathOnly('ruleId'),
    redact: 'config',
    examples: [{ summary: 'Unblock', args: { ruleId: U1 } }],
  }),
  det({
    id: 'pricing_survey.get',
    title: 'Check whether the pricing question is open',
    description: 'Whether the one-time pricing question should be shown to you now.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Open?', args: {} }],
  }),
  det({
    id: 'pricing_survey.answer',
    title: 'Answer the pricing question',
    description:
      'Send your own answer once: a monthly price band and an optional note (500) to the TManage ' +
      'team. A second answer is refused (409). Only answer with what the member said.',
    input: bodyArgs([], {
      band: z.enum(PRICING_BANDS),
      note: z.string().max(PRICING_NOTE_MAX).nullish(),
    }),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Five to nine', args: { band: '5_9' } }],
  }),
  det({
    id: 'pricing_survey.skip',
    title: 'Skip the pricing question',
    description: 'Skip the pricing question for good; it is not asked again.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Skip', args: {} }],
  }),
  det({
    id: 'referral.get',
    title: "Read the company's invite link",
    description: "The owner's invite link for other companies and its state. Company owner only.",
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Invite link', args: {} }],
  }),
  det({
    id: 'referral.code.create',
    title: "Create the company's invite link",
    description:
      'Create the invite link on first use (idempotent) and return the page state. Owner only; ' +
      'nothing is sent to anyone.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Create', args: {} }],
  }),
  det({
    id: 'public_links.list',
    title: 'List public links',
    description:
      'Public links of one object (targetType and targetId together), or every link in the company ' +
      'when both are omitted (needs org.security.manage). Shows the token hint, never the token.',
    input: bodyArgs([], { targetType: f.shortText(64).optional(), targetId: uuid().optional() }),
    redact: 'standard',
    examples: [
      { summary: 'Links of a version', args: { targetType: 'deliverable_version', targetId: U1 } },
    ],
  }),
  det({
    id: 'public_links.create',
    title: 'Create a public link',
    description:
      'Create a link an outsider can open without signing in: kind, the target (targetType and ' +
      'its UUID), optional audienceEmail, requireCode, language en/ar, expiresInDays 1-30 ' +
      '(default from the service) and optional maxUses. The answer holds the link token once.',
    input: bodyArgs([], {
      kind: z.enum(PUBLIC_LINK_KINDS),
      targetType: f.shortText(64),
      targetId: uuid(),
      audienceEmail: email(LINK_EMAIL_MAX).nullish(),
      requireCode: f.bool().optional(),
      language: z.enum(['en', 'ar']).optional(),
      expiresInDays: f.int(1, LINK_EXPIRY_DAYS_MAX).optional(),
      maxUses: f.int(1).nullish(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Share link for a week',
        args: { kind: 'share', targetType: 'deliverable_version', targetId: U1, expiresInDays: 7 },
      },
    ],
  }),
  det({
    id: 'public_links.delete',
    title: 'Revoke a public link',
    description:
      'End one public link now (linkId from public_links.list); outsiders can no longer open it.',
    input: pathOnly('linkId'),
    redact: 'standard',
    examples: [{ summary: 'Revoke', args: { linkId: U1 } }],
  }),
  det({
    id: 'public_links.manage.list',
    title: 'Search all public links',
    description:
      "The company's public links, 25 per page: optional q (search), kind, createdBy (a user " +
      'UUID), state active / ending_soon / ended / all (default active) and page (from 1).',
    input: bodyArgs([], {
      q: z.string().max(PUBLIC_LINK_SEARCH_MAX).optional(),
      kind: z.enum(PUBLIC_LINK_KINDS).optional(),
      createdBy: uuid().optional(),
      state: z.enum(PUBLIC_LINK_STATE_FILTERS).optional(),
      page: z
        .string()
        .regex(/^\d{1,6}$/u)
        .optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'Ending soon', args: { state: 'ending_soon' } }],
  }),
  det({
    id: 'public_links.manage.revoke',
    title: 'Revoke public links in bulk',
    description: 'Revoke up to 100 public links at once (linkIds from public_links.manage.list).',
    input: bodyArgs([], { linkIds: linkIds() }),
    redact: 'standard',
    examples: [{ summary: 'Revoke two', args: { linkIds: [U1, U2] } }],
  }),
  det({
    id: 'public_links.manage.expiry',
    title: 'Change when public links end',
    description:
      'Set a new end time (ISO, in the future and within 30 days) for up to 100 links ' +
      '(linkIds from public_links.manage.list).',
    input: bodyArgs([], { linkIds: linkIds(), expiresAt: f.iso() }),
    redact: 'standard',
    examples: [
      { summary: 'End Friday', args: { linkIds: [U1], expiresAt: '2026-11-27T18:00:00Z' } },
    ],
  }),
  det({
    id: 'approvals.external_approvals.list',
    title: 'List external approvers of a version',
    description:
      'People outside the company asked to approve one version (deliverableId from ' +
      'approvals.deliverables.list, versionId from approvals.deliverables.get), with link status ' +
      'and decision.',
    input: pathOnly('deliverableId', 'versionId'),
    redact: 'standard',
    examples: [{ summary: 'Approvers', args: { deliverableId: U1, versionId: U2 } }],
  }),
  det({
    id: 'approvals.external_approvals.create',
    title: 'Ask an outsider to approve a version',
    description:
      'E-mail a person outside the company a link to approve one version: email, optional name ' +
      '(120) and message (1000), expiresInDays 1-30, language en/ar. The answer includes the ' +
      "approver's page URL once.",
    input: bodyArgs(['deliverableId', 'versionId'], {
      email: email(LINK_EMAIL_MAX),
      name: z.string().max(APPROVER_NAME_MAX).nullish(),
      message: z.string().max(APPROVER_MESSAGE_MAX).nullish(),
      expiresInDays: f.int(1, APPROVAL_EXPIRY_DAYS_MAX).optional(),
      language: z.enum(['en', 'ar']).optional(),
    }),
    redact: 'standard',
    notifies: true,
    examples: [
      {
        summary: 'Ask the client lead',
        args: { deliverableId: U1, versionId: U2, email: 'lead@client.example', name: 'Sam' },
      },
    ],
  }),
  det({
    id: 'audit.integrity.get',
    title: 'Verify the audit chain',
    description:
      "Check that the company's audit history is unbroken; returns ok or the first bad row id.",
    input: noArgs(),
    redact: 'audit',
    examples: [{ summary: 'Verify', args: {} }],
  }),
  det({
    id: 'audit.catalog.list',
    title: 'List audit action types',
    description: 'Every audit action with its English and Arabic description.',
    input: noArgs(),
    redact: 'audit',
    examples: [{ summary: 'Catalog', args: {} }],
  }),
  det({
    id: 'audit.export_signature.get',
    title: 'Get the signed audit chain head',
    description:
      'The signed head of the audit chain, used to prove an audit export (audit.events.export) ' +
      'was not altered.',
    input: noArgs(),
    redact: 'audit',
    examples: [{ summary: 'Signature', args: {} }],
  }),
  det({
    id: 'admin.security_events.list',
    title: 'List security events',
    description:
      "The company's security signals, newest first: optional kind (a rule key), from (ISO), " +
      "reviewed 'true'/'false', limit 1-100 and cursor (nextCursor of the last page).",
    input: bodyArgs([], {
      kind: f.shortText(80).optional(),
      from: f.iso().optional(),
      reviewed: z.enum(['true', 'false']).optional(),
      limit: f.int(1, SIGNAL_PAGE_MAX).optional(),
      cursor: f.id(64).optional(),
    }),
    redact: 'audit',
    examples: [{ summary: 'Not yet reviewed', args: { reviewed: 'false', limit: 20 } }],
  }),
  det({
    id: 'admin.security_events.reviewed.create',
    title: 'Mark a security event reviewed',
    description:
      'Mark one security event reviewed (signalId from admin.security_events.list). Write-once.',
    input: pathOnly('signalId'),
    redact: 'audit',
    examples: [{ summary: 'Reviewed', args: { signalId: U1 } }],
  }),
  det({
    id: 'admin.file_safety.blocked.list',
    title: 'List blocked files',
    description: 'Files the virus check rejected and kept in quarantine.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Blocked files', args: {} }],
  }),
  det({
    id: 'admin.file_safety.blocked.delete',
    title: 'Delete a blocked file',
    description:
      'Remove one quarantined file for good; take fileId out of admin.file_safety.blocked.list.',
    input: pathOnly('fileId'),
    redact: 'standard',
    examples: [{ summary: 'Delete', args: { fileId: U1 } }],
  }),
  det({
    id: 'mail.bounces.status',
    title: 'Check whether an address bounced',
    description:
      'Whether mail to one e-mail address bounced in this company and is held back. Changes ' +
      'nothing (it is a POST so the address stays out of URLs).',
    input: bodyArgs([], { address: email(MAIL_ADDRESS_MAX) }),
    redact: 'people',
    examples: [{ summary: 'Check', args: { address: 'pat@client.example' } }],
  }),
  det({
    id: 'mail.bounces.clear',
    title: 'Clear a bounce hold',
    description: 'Lift the bounce hold on one address so mail to it is sent again.',
    input: bodyArgs([], { address: email(MAIL_ADDRESS_MAX) }),
    redact: 'people',
    examples: [{ summary: 'Clear', args: { address: 'pat@client.example' } }],
  }),
  det({
    id: 'admin.incidents.list',
    title: 'List service incidents',
    description: 'TManage service incidents that affect this company.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Incidents', args: {} }],
  }),
  det({
    id: 'security.sign_in_policy.get',
    title: 'Read the sign-in policy',
    description:
      'Allowed sign-in methods, which roles must use two-step sign-in, and any grace period.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Sign-in policy', args: {} }],
  }),
  det({
    id: 'org.settings.file_safety.set',
    title: 'Choose allowed file types',
    description:
      'Set which file type presets members may upload (a non-empty list of documents, images, ' +
      'design, video, archives).',
    input: bodyArgs([], { presets: z.array(z.enum(FILE_TYPE_PRESETS)).min(1) }),
    redact: 'config',
    examples: [
      { summary: 'No video or archives', args: { presets: ['documents', 'images', 'design'] } },
    ],
  }),
  det({
    id: 'org.settings.client_file_policy.get',
    title: 'Read which files clients can receive',
    description:
      "The client file policy ('checked' or 'virus_scanned'), whether a scanner is set up and " +
      'whether sharing is possible.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Policy', args: {} }],
  }),
  det({
    id: 'org.settings.client_file_policy.set',
    title: 'Change which files clients can receive',
    description:
      "Set clientFiles to 'checked' or 'virus_scanned' (clients get only scanned-clean files). " +
      'Company owner only.',
    input: bodyArgs([], { clientFiles: z.enum(CLIENT_FILES_POLICIES) }),
    redact: 'config',
    examples: [{ summary: 'Scanned only', args: { clientFiles: 'virus_scanned' } }],
  }),
  det({
    id: 'support.threads.list',
    title: 'List support conversations',
    description:
      'Your conversations with the TManage support team (all of the company for an admin), and ' +
      'the response-time policy.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'My conversations', args: {} }],
  }),
  det({
    id: 'support.threads.create',
    title: 'Contact TManage support',
    description:
      'Start a conversation with the TManage support team: subject (160), message (5000), ' +
      'optional category and priority, the page path the member was on, the app version and one ' +
      'uploaded file id. Write only what the member asked to send.',
    input: bodyArgs([], {
      subject: f.shortText(SUPPORT_SUBJECT_MAX),
      message: f.text(SUPPORT_BODY_MAX),
      category: z.enum(SUPPORT_CATEGORIES).optional(),
      priority: z.enum(SUPPORT_PRIORITIES).optional(),
      contextPath: z
        .string()
        .max(SUPPORT_PATH_MAX)
        .regex(/^\/(?!\/)\S*$/u)
        .optional(),
      appVersion: z
        .string()
        .regex(/^[\w.+-]{1,40}$/u)
        .optional(),
      attachmentFileId: uuid().optional(),
    }),
    redact: 'standard',
    notifies: true,
    examples: [
      {
        summary: 'A question',
        args: {
          subject: 'Invoice numbering',
          message: 'How do I restart numbering?',
          category: 'billing',
        },
      },
    ],
  }),
  det({
    id: 'support.threads.get',
    title: 'Open a support conversation',
    description: 'One support conversation with its messages (threadId from support.threads.list).',
    input: pathOnly('threadId'),
    redact: 'standard',
    examples: [{ summary: 'Open', args: { threadId: U1 } }],
  }),
  det({
    id: 'support.threads.messages.create',
    title: 'Reply in a support conversation',
    description:
      'Send a message (5000) to the TManage support team in one conversation, optionally with one ' +
      'uploaded file id.',
    input: bodyArgs(['threadId'], {
      message: f.text(SUPPORT_BODY_MAX),
      attachmentFileId: uuid().optional(),
    }),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Reply', args: { threadId: U1, message: 'That fixed it, thanks.' } }],
  }),
  det({
    id: 'support.threads.close',
    title: 'Close a support conversation',
    description: 'Mark one support conversation solved.',
    input: pathOnly('threadId'),
    redact: 'standard',
    examples: [{ summary: 'Close', args: { threadId: U1 } }],
  }),
  det({
    id: 'connectors.list',
    title: 'List connectors',
    description:
      'Every connector (Google Drive, OneDrive, calendars, Jira, GitHub) and whether it is installed.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Connectors', args: {} }],
  }),
  det({
    id: 'connectors.get',
    title: "Read a connector's status",
    description: "One connector's status by connectorKey (from connectors.list, e.g. jira).",
    input: pathOnly('connectorKey'),
    redact: 'config',
    examples: [{ summary: 'Jira', args: { connectorKey: 'jira' } }],
  }),
  det({
    id: 'connectors.delete',
    title: 'Uninstall a connector',
    description:
      'Uninstall one connector and drop its stored credential (connectorKey from connectors.list).',
    input: pathOnly('connectorKey'),
    redact: 'config',
    examples: [{ summary: 'Remove Jira', args: { connectorKey: 'jira' } }],
  }),
  det({
    id: 'app_connect.get',
    title: 'Read an app connection',
    description: "Whether the company's GitHub app connection is set up.",
    input: bodyArgs([], { provider: z.enum(APP_CONNECT_PROVIDERS) }),
    redact: 'config',
    examples: [{ summary: 'GitHub', args: { provider: 'github' } }],
  }),
  det({
    id: 'app_connect.delete',
    title: 'Disconnect an app',
    description: "Disconnect the company's GitHub app connection.",
    input: bodyArgs([], { provider: z.enum(APP_CONNECT_PROVIDERS) }),
    redact: 'config',
    examples: [{ summary: 'Disconnect GitHub', args: { provider: 'github' } }],
  }),
  det({
    id: 'security.sso.get',
    title: 'Read the company sign-in (SSO) connection',
    description:
      'The SSO connection (issuer, client id, allowed domains, enforce, auto-join; never the secret) ' +
      'and the redirect URL to register.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'SSO', args: {} }],
  }),
  det({
    id: 'security.sso.delete',
    title: 'Remove the company sign-in (SSO) connection',
    description:
      'Remove the SSO connection and its stored secret; members sign in the usual way again. ' +
      'Company owner only.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Remove SSO', args: {} }],
  }),
  det({
    id: 'security.scim.get',
    title: 'Read user provisioning (SCIM) settings',
    description: 'Whether SCIM provisioning is on, its base URL and the key names (never a key).',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'SCIM', args: {} }],
  }),
  // Existing ops (D) that had no detail.
  det({
    id: 'onboarding.tour.complete.create',
    title: 'Mark a tour step done',
    description:
      'Mark one step of your own product tour complete (idempotent) and return the tour. Steps: ' +
      'welcome, create_project, invite_team, explore_work, share_portal (onboarding.tour.list).',
    input: bodyArgs([], { step: z.enum(TOUR_STEPS) }),
    redact: 'standard',
    examples: [{ summary: 'Done looking around', args: { step: 'welcome' } }],
  }),
  det({
    id: 'onboarding.wizard.get',
    title: 'Read the setup wizard',
    description:
      "The company's setup wizard: status and each step's outcome (done, skipped, none).",
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Wizard', args: {} }],
  }),
  det({
    id: 'onboarding.wizard.steps.create',
    title: 'Record a setup wizard step',
    description:
      'Record one wizard step as done or skipped. Steps: company, work_type, invite, storage, ' +
      "sample_project, finish (finish cannot be skipped). The step's own effect goes through its " +
      'own op.',
    input: bodyArgs([], { step: z.enum(WIZARD_STEPS), outcome: z.enum(WIZARD_OUTCOMES) }),
    redact: 'standard',
    examples: [{ summary: 'Skip storage', args: { step: 'storage', outcome: 'skipped' } }],
  }),
  det({
    id: 'onboarding.wizard.dismiss.create',
    title: 'Leave the setup wizard',
    description: 'Skip setup for now; a later visit resumes where it was.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Skip setup', args: {} }],
  }),
  det({
    id: 'getting_started.get',
    title: 'Read my getting-started checklist',
    description:
      'Your getting-started checklist: each step, whether it is done, and if it was hidden.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Checklist', args: {} }],
  }),
  det({
    id: 'getting_started.steps.complete.create',
    title: 'Tick a getting-started step',
    description:
      'Mark one checklist step done: invite_teammate, create_project, add_client, ' +
      'connect_storage, set_working_hours, try_ai_assistant.',
    input: bodyArgs([], { step: z.enum(CHECKLIST_STEPS) }),
    redact: 'standard',
    examples: [{ summary: 'Project made', args: { step: 'create_project' } }],
  }),
  det({
    id: 'getting_started.dismiss.create',
    title: 'Hide my getting-started checklist',
    description: 'Hide the checklist for you (dismissing twice keeps the first time).',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Hide', args: {} }],
  }),
  det({
    id: 'getting_started.setup_health.get',
    title: 'Read setup health',
    description: "The owner's four setup checks, each with an ok flag.",
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Setup health', args: {} }],
  }),
  det({
    id: 'org.settings.file_safety.get',
    title: 'Read file safety settings',
    description:
      'Enabled upload type presets and the ones on offer, the per-file size cap of the plan, ' +
      'whether clients get only scanned-clean files, and whether a scanner is present.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'File safety', args: {} }],
  }),
];
