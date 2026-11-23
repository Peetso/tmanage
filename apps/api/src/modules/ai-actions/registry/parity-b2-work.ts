/**
 * AI action registry — parity batch 2, lane "work" (2026-11-23).
 *
 * Owner rule (absolute, 2026-11-23): the in-app AI and the external MCP must be able to do
 * whatever the account has the right to do. ADR-0015 part 1: a route stays in `NEVER` only for
 * K1 (sign-in, password or step-up, OAuth, issuing a third-party credential), K2 (the AI approving
 * its own actions), K3 (showing or minting a raw secret), K4 (not an account action) or K5 (an
 * existing op covers it). Everything else becomes an op here: finance settings and invoice money
 * movements, time (automatic tracking, team time, rounding, period locks), working calendars,
 * schedule cascades and the critical path, objectives / phases / milestone publishing, automations
 * (app directory, connection health, webhooks, GitHub repo hooks), imports (Trello / Asana, undo),
 * invite contacts, quote / invoice / record PDFs, glossary details, chat groups, and the public
 * form attachments switch.
 *
 * Scope and risk rule (lane brief):
 * - A GET is `read` with scope `read`.
 * - Every change (POST / PUT / PATCH / DELETE) is `risk: 'confirm'` — the confirm card is the
 *   control, held in `pending_ai_actions` and run once as the member.
 * - Scope of a change: `org.manage`, `project.manage`, `finance.manage`, org-wide settings,
 *   integrations and anything client-facing (portal, publishing to a client, the public form)
 *   are `manage`; the member's own everyday work (their own timer and tracking, their own
 *   contacts, a chat group they belong to, a dependency on their work) is `write`.
 * - Sensitivity (non-read ops only, `workSensitivity`): money > hr > destructive > external > none.
 *
 * What the member may reach is still decided by the route's `@RequireCapability`, the service's
 * own `authorize()` and owner-only checks (rounding, tracking policy), re-run at execution time.
 * Inputs mirror each controller's own parser (field names, enums, bounds); cross-field rules
 * (date order, range length, the CSV mapping width) stay with the service.
 *
 * Kept in `NEVER` by this lane (see the lane report): `POST …/integrations/github/repo-hooks`
 * (K3, returns the signing secret), `POST …/finance/exports/`, `PUT` and `DELETE
 * …/finance/einvoicing/certificate` (K1 password step-up via `x-reauth-token`; the PUT also
 * stores a private key, K3).
 */
import { z } from 'zod';
import {
  ADDRESS_FIELDS,
  AUTO_TRACKING_POLICIES,
  CONTACT_IMPORT_MAX_BYTES,
  DEPENDENCY_KINDS,
  EINVOICE_REGIMES,
  HOLIDAY_PACK_KEYS,
  IDLE_THRESHOLD_MAX_MINUTES,
  IDLE_THRESHOLD_MIN_MINUTES,
  INVOICE_LANGUAGES,
  MAX_DEPENDENCY_LAG,
  MAX_HOLIDAY_LABEL_LENGTH,
  MIN_DEPENDENCY_LAG,
  PAYMENT_METHODS,
  PROJECT_EXPORT_FORMATS,
  TIME_ROUNDING_CHOICES,
  TRACKING_DEVICE_KINDS,
  VAT_REGISTRATION_STATUSES,
} from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';
import {
  INTEGRATION_CONNECTION_STATUSES,
  ORG_OBJECTIVE_STATUSES,
} from '../../../common/database/schema.js';
import { WEBHOOK_EVENT_KINDS } from '../../automations/webhook-event-catalog.js';
import { MAX_DEFINITION_LENGTH, MAX_TERM_LENGTH } from '../../docs/glossary.service.js';
import {
  MAX_DESCRIPTION,
  MAX_INVOICE_LINES,
  MAX_UNIT_PRICE_MINOR,
} from '../../finance/client-invoices-rules.js';
import {
  DIGIT_SYSTEMS,
  FINANCE_CURRENCIES,
  NUMBERING_RESETS,
  ZATCA_CATEGORIES,
} from '../../finance/finance-rules.js';
import { PM_TARGET_STATES } from '../../import/pm-import-plan.js';
import { MAX_PM_BOARDS, PM_SOURCES } from '../../import/pm-sources.js';
import { SUGGEST_QUERY_MAX } from '../../people/contact-suggestions.service.js';
import { UNLOCK_REASON_MAX, UNLOCK_REASON_MIN } from '../../time/locks-rules.js';
import type { AiActionOp, AiScope, HttpMethod, RiskClass, Sensitivity } from './types.js';
import { bodyArgs, det, f, noArgs, pathOnly, type AiActionDetail } from './detail.js';

const ORG = '/v1/organizations/:orgSlug';

function op(
  id: string,
  method: HttpMethod,
  path: string,
  capability: Capability,
  risk: RiskClass,
  scope: AiScope,
): AiActionOp {
  return { id, method, path: `${ORG}${path}`, capability, risk, scope };
}

const READ = ['read', 'read'] as const;
/** A change to org, project, finance, integration or client-facing state. */
const MANAGE = ['confirm', 'manage'] as const;
/** A change to the member's own everyday work. */
const OWN = ['confirm', 'write'] as const;

/** One op per NEVER route this lane converts (87 routes). */
export const workOps: readonly AiActionOp[] = [
  // Automations: the app directory, connection health, variables, webhooks.
  op('automations.apps.list', 'GET', '/automations/apps/', 'org.manage', ...READ),
  op(
    'automations.apps.connections.create',
    'POST',
    '/automations/apps/:appId/connections',
    'org.manage',
    ...MANAGE,
  ),
  op(
    'automations.connections.health.get',
    'GET',
    '/automations/connections/:id/health',
    'org.manage',
    ...READ,
  ),
  op(
    'automations.connections.health.list',
    'GET',
    '/automations/connections/health',
    'org.manage',
    ...READ,
  ),
  op(
    'automations.variables.delete',
    'DELETE',
    '/automations/variables/:key',
    'org.manage',
    ...MANAGE,
  ),
  op(
    'automations.webhooks.deliveries.list',
    'GET',
    '/automations/webhooks/:endpointId/deliveries/',
    'org.manage',
    ...READ,
  ),
  op('automations.webhooks.update', 'PATCH', '/automations/webhooks/:id', 'org.manage', ...MANAGE),
  op(
    'automations.webhooks.pause',
    'POST',
    '/automations/webhooks/:id/pause',
    'org.manage',
    ...MANAGE,
  ),
  op(
    'automations.webhooks.resume',
    'POST',
    '/automations/webhooks/:id/resume',
    'org.manage',
    ...MANAGE,
  ),
  op(
    'automations.webhooks.replay',
    'POST',
    '/automations/webhooks/:id/replay',
    'org.manage',
    ...MANAGE,
  ),
  op(
    'automations.webhooks.deliveries.retry',
    'POST',
    '/automations/webhooks/:endpointId/deliveries/:deliveryId/retry',
    'org.manage',
    ...MANAGE,
  ),
  // GitHub repo hooks (the create route stays NEVER: it returns the signing secret).
  op(
    'integrations.github.repo_hooks.list',
    'GET',
    '/integrations/github/repo-hooks',
    'org.manage',
    ...READ,
  ),
  op(
    'integrations.github.repo_hooks.delete',
    'DELETE',
    '/integrations/github/repo-hooks/:id',
    'org.manage',
    ...MANAGE,
  ),
  // Record files: approval certificates, evidence bundles, signed documents, project export.
  op(
    'approvals.record.pdf.get',
    'GET',
    '/approvals/:approvalId/record.pdf',
    'approval.read',
    ...READ,
  ),
  op(
    'approvals.projections.record.pdf.get',
    'GET',
    '/approvals/projections/:deliverableVersionId/record.pdf',
    'approval.read',
    ...READ,
  ),
  op(
    'approvals.evidence.get',
    'GET',
    '/approvals/:approvalId/evidence.zip',
    'approval.read',
    ...READ,
  ),
  op(
    'esign.requests.signed_pdf.get',
    'GET',
    '/signature-requests/:signatureRequestId/signed.pdf',
    'approval.read',
    ...READ,
  ),
  op(
    'esign.portal.signed_pdf.get',
    'GET',
    '/portal/signature-requests/:signatureRequestId/signed.pdf',
    'client_projection.read',
    ...READ,
  ),
  op('projects.export.get', 'GET', '/projects/:projectId/export/', 'work.export', ...READ),
  // Public form: the visitors' attachments switch.
  op(
    'work_forms.attachments.set',
    'PUT',
    '/work-forms/:formId/attachments',
    'work.create',
    ...MANAGE,
  ),
  // Quote and invoice documents.
  op('quotes.pdf.get', 'GET', '/quotes/:quoteId/pdf', 'project.manage', ...READ),
  op(
    'portal.quotes.pdf.get',
    'GET',
    '/portal/quotes/:quoteId/pdf',
    'client_projection.read',
    ...READ,
  ),
  op(
    'client_invoices.payments.record',
    'POST',
    '/client-invoices/:invoiceId/payments',
    'finance.manage',
    ...MANAGE,
  ),
  op(
    'client_invoices.void',
    'POST',
    '/client-invoices/:invoiceId/void',
    'finance.manage',
    ...MANAGE,
  ),
  op(
    'client_invoices.credit_notes.create',
    'POST',
    '/client-invoices/:invoiceId/credit-notes',
    'finance.manage',
    ...MANAGE,
  ),
  op(
    'client_invoices.print.get',
    'GET',
    '/client-invoices/:invoiceId/print',
    'finance.view',
    ...READ,
  ),
  op(
    'client_invoices.einvoice.get',
    'GET',
    '/client-invoices/:invoiceId/einvoice',
    'finance.view',
    ...READ,
  ),
  op('client_invoices.pdf.get', 'GET', '/client-invoices/:invoiceId/pdf', 'finance.view', ...READ),
  op(
    'portal.invoices.print.get',
    'GET',
    '/portal/invoices/:invoiceId/print',
    'client_projection.read',
    ...READ,
  ),
  op(
    'portal.invoices.pdf.get',
    'GET',
    '/portal/invoices/:invoiceId/pdf',
    'client_projection.read',
    ...READ,
  ),
  // Finance settings.
  op('finance.profile.get', 'GET', '/finance/profile', 'finance.view', ...READ),
  op('finance.profile.set', 'PUT', '/finance/profile', 'finance.manage', ...MANAGE),
  op('finance.tax_rates.list', 'GET', '/finance/tax-rates', 'finance.view', ...READ),
  op('finance.tax_rates.create', 'POST', '/finance/tax-rates', 'finance.manage', ...MANAGE),
  op(
    'finance.tax_rates.update',
    'PUT',
    '/finance/tax-rates/:taxRateId',
    'finance.manage',
    ...MANAGE,
  ),
  op('finance.exchange_rates.list', 'GET', '/finance/exchange-rates', 'finance.view', ...READ),
  op(
    'finance.exchange_rates.create',
    'POST',
    '/finance/exchange-rates',
    'finance.manage',
    ...MANAGE,
  ),
  op('finance.readiness.get', 'GET', '/finance/readiness', 'finance.view', ...READ),
  // Time: automatic tracking, the timer discard, rounding, team time, period locks.
  op('time.auto.get', 'GET', '/time/auto/', 'work.read', ...READ),
  op('time.auto.settings.set', 'PUT', '/time/auto/settings', 'work.read', ...OWN),
  op('time.timer.discard', 'POST', '/time/timer/discard', 'work.read', ...OWN),
  op('time.auto.current_task.set', 'PUT', '/time/auto/current-task', 'work.read', ...OWN),
  op('time.auto.heartbeat', 'POST', '/time/auto/heartbeat', 'work.read', ...OWN),
  op('time.auto.policy.set', 'PATCH', '/time/auto/policy', 'org.manage', ...MANAGE),
  op('time.auto.device.set', 'PUT', '/time/auto/device', 'work.read', ...OWN),
  op('time.rounding.set', 'PATCH', '/time/rounding', 'org.manage', ...MANAGE),
  op('time.team.list', 'GET', '/time/team/', 'time.view_team', ...READ),
  op('time.team.day.get', 'GET', '/time/team/:membershipId/day', 'time.view_team', ...READ),
  op('time.locks.create', 'POST', '/time/locks/', 'finance.manage', ...MANAGE),
  op('time.locks.delete', 'DELETE', '/time/locks/:lockId', 'finance.manage', ...MANAGE),
  // Chat groups.
  op(
    'conversations.group.update',
    'PATCH',
    '/conversations/:conversationId/group/',
    'conversation.write',
    ...OWN,
  ),
  op(
    'conversations.group.members.add',
    'POST',
    '/conversations/:conversationId/group/members',
    'conversation.write',
    ...OWN,
  ),
  op(
    'conversations.group.members.remove',
    'DELETE',
    '/conversations/:conversationId/group/members/:userId',
    'conversation.write',
    ...OWN,
  ),
  op(
    'conversations.group.members.role.set',
    'PUT',
    '/conversations/:conversationId/group/members/:userId/role',
    'conversation.write',
    ...OWN,
  ),
  op(
    'conversations.group.leave',
    'POST',
    '/conversations/:conversationId/group/leave',
    'conversation.read',
    ...OWN,
  ),
  op('portal.chat.list', 'GET', '/portal/chat/list', 'client_projection.read', ...READ),
  // Working calendars.
  op('working_calendar.get', 'GET', '/working-calendar', 'work.read', ...READ),
  op('working_calendar.set', 'PUT', '/working-calendar', 'org.manage', ...MANAGE),
  op(
    'working_calendar.holidays.create',
    'POST',
    '/working-calendar/holidays',
    'org.manage',
    ...MANAGE,
  ),
  op(
    'working_calendar.holidays.delete',
    'DELETE',
    '/working-calendar/holidays/:holidayId',
    'org.manage',
    ...MANAGE,
  ),
  op(
    'working_calendar.holidays.import_pack',
    'POST',
    '/working-calendar/import-pack',
    'org.manage',
    ...MANAGE,
  ),
  op(
    'projects.working_calendar.get',
    'GET',
    '/projects/:projectId/working-calendar',
    'work.read',
    ...READ,
  ),
  op(
    'projects.working_calendar.set',
    'PUT',
    '/projects/:projectId/working-calendar',
    'project.manage',
    ...MANAGE,
  ),
  op(
    'projects.working_calendar.delete',
    'DELETE',
    '/projects/:projectId/working-calendar',
    'project.manage',
    ...MANAGE,
  ),
  // Invite contacts (the caller's own suggestions).
  op('contacts.import_file', 'POST', '/contacts/import-file', 'people.view', ...OWN),
  op('contacts.suggestions.list', 'GET', '/contacts/suggest', 'people.view', ...READ),
  op('contacts.import_preview', 'POST', '/contacts/import-preview', 'people.view', ...OWN),
  op('contacts.suggestions.clear', 'DELETE', '/contacts/suggestions', 'people.view', ...OWN),
  // Schedule: typed dependencies, cascades, critical path, baselines, work keys.
  op(
    'work_items.dependencies.update',
    'PATCH',
    '/work-items/:workItemId/dependencies/:dependencyId',
    'work.update',
    ...OWN,
  ),
  op(
    'work_items.schedule.cascade_preview',
    'POST',
    '/work-items/:workItemId/schedule/cascade-preview',
    'work.update',
    ...OWN,
  ),
  op(
    'work_items.schedule.cascade_apply',
    'POST',
    '/work-items/:workItemId/schedule/cascade-apply',
    'work.update',
    ...OWN,
  ),
  op(
    'projects.work_key_prefix.set',
    'PUT',
    '/projects/:projectId/work-key-prefix',
    'project.manage',
    ...MANAGE,
  ),
  op(
    'work_items.code_links.list',
    'GET',
    '/work-items/:workItemId/code-links',
    'work.read',
    ...READ,
  ),
  op(
    'work_items.code_links.delete',
    'DELETE',
    '/work-items/:workItemId/code-links/:linkId',
    'work.update',
    ...OWN,
  ),
  op(
    'projects.baselines.set_current',
    'PATCH',
    '/projects/:projectId/baselines/:baselineId',
    'project.manage',
    ...MANAGE,
  ),
  op(
    'projects.schedule.critical_path.get',
    'GET',
    '/projects/:projectId/schedule/critical-path',
    'work.read',
    ...READ,
  ),
  op(
    'projects.schedule.recompute',
    'POST',
    '/projects/:projectId/schedule/recompute',
    'project.manage',
    ...MANAGE,
  ),
  // Client timeline: milestone publishing and phase dates.
  op(
    'projects.milestones.publish',
    'POST',
    '/projects/:projectId/milestones/:id/publish',
    'project.manage',
    ...MANAGE,
  ),
  op(
    'projects.milestones.unpublish',
    'DELETE',
    '/projects/:projectId/milestones/:id/publish',
    'project.manage',
    ...MANAGE,
  ),
  op(
    'projects.phases.dates.set',
    'PUT',
    '/projects/:projectId/phases/:phaseId/dates',
    'project.manage',
    ...MANAGE,
  ),
  // Imports: undo, and Trello / Asana with the token already connected.
  op('imports.undo', 'POST', '/imports/:jobId/undo', 'org.manage', ...MANAGE),
  op('imports.pm.discover', 'POST', '/imports/pm/:source/discover', 'org.manage', ...MANAGE),
  op('imports.pm.preview', 'POST', '/imports/pm/:source/preview', 'org.manage', ...MANAGE),
  op('imports.pm.jobs.create', 'POST', '/imports/pm/:source/jobs', 'org.manage', ...MANAGE),
  op(
    'imports.pm.connection.delete',
    'DELETE',
    '/imports/pm/:source/connection',
    'org.manage',
    ...MANAGE,
  ),
  op('imports.pm.jobs.get', 'GET', '/imports/pm/:source/jobs/:jobId', 'org.manage', ...READ),
];

/** One entry per new op whose risk is not `read`. */
export const workSensitivity: Readonly<Record<string, Sensitivity>> = {
  'automations.apps.connections.create': 'none',
  'automations.variables.delete': 'destructive',
  'automations.webhooks.update': 'external',
  'automations.webhooks.pause': 'none',
  'automations.webhooks.resume': 'external',
  'automations.webhooks.replay': 'external',
  'automations.webhooks.deliveries.retry': 'external',
  'integrations.github.repo_hooks.delete': 'destructive',
  'work_forms.attachments.set': 'external',
  'client_invoices.payments.record': 'money',
  'client_invoices.void': 'money',
  'client_invoices.credit_notes.create': 'money',
  'finance.profile.set': 'money',
  'finance.tax_rates.create': 'money',
  'finance.tax_rates.update': 'money',
  'finance.exchange_rates.create': 'money',
  'time.auto.settings.set': 'none',
  'time.timer.discard': 'destructive',
  'time.auto.current_task.set': 'none',
  'time.auto.heartbeat': 'none',
  'time.auto.policy.set': 'hr',
  'time.auto.device.set': 'none',
  'time.rounding.set': 'money',
  'time.locks.create': 'money',
  'time.locks.delete': 'money',
  'conversations.group.update': 'none',
  'conversations.group.members.add': 'none',
  'conversations.group.members.remove': 'destructive',
  'conversations.group.members.role.set': 'none',
  'conversations.group.leave': 'none',
  'working_calendar.set': 'none',
  'working_calendar.holidays.create': 'none',
  'working_calendar.holidays.delete': 'destructive',
  'working_calendar.holidays.import_pack': 'none',
  'projects.working_calendar.set': 'none',
  'projects.working_calendar.delete': 'destructive',
  'contacts.import_file': 'none',
  'contacts.import_preview': 'none',
  'contacts.suggestions.clear': 'destructive',
  'work_items.dependencies.update': 'none',
  'work_items.schedule.cascade_preview': 'none',
  'work_items.schedule.cascade_apply': 'none',
  'projects.work_key_prefix.set': 'none',
  'work_items.code_links.delete': 'destructive',
  'projects.baselines.set_current': 'none',
  'projects.schedule.recompute': 'none',
  'projects.milestones.publish': 'external',
  'projects.milestones.unpublish': 'destructive',
  'projects.phases.dates.set': 'external',
  'imports.undo': 'destructive',
  'imports.pm.discover': 'none',
  'imports.pm.preview': 'none',
  'imports.pm.jobs.create': 'none',
  'imports.pm.connection.delete': 'destructive',
};

// ---- input building blocks (mirroring each controller's parser) ----

const day = (): z.ZodString => z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'a date YYYY-MM-DD');
const uuid = (): z.ZodString =>
  z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu, 'an id (UUID)');
const currency = () => z.enum(FINANCE_CURRENCIES);
const lang = () => z.enum(INVOICE_LANGUAGES).optional();
const nullableText = (max: number) => z.string().max(max).nullable().optional();
const prefix = () => z.string().regex(/^[A-Z0-9-]{1,16}$/u, '1 to 16 of A-Z, 0-9 or -');
const safeCount = () => f.int(0, Number.MAX_SAFE_INTEGER);
/** `automations/webhooks.controller.ts` MAX_DESCRIPTION_LENGTH. */
const WEBHOOK_DESCRIPTION_MAX = 300;
/** `webhook-deliveries.controller.ts` MAX_PAGE_SIZE. */
const WEBHOOK_DELIVERIES_PAGE_MAX = 200;
/** `finance.service.ts` MAX_LIST. */
const FINANCE_LIST_MAX = 200;

/** `client-invoices-rules.ts` validateLine: a credit-note line. */
const creditLine = z
  .object({
    id: uuid().nullable().optional(),
    descriptionEn: z.string().max(MAX_DESCRIPTION).nullable().optional(),
    descriptionAr: z.string().max(MAX_DESCRIPTION).nullable().optional(),
    quantity: z.number().positive().max(100_000),
    unit: z.enum(['item', 'hour', 'day', 'month', 'fixed']).optional(),
    unitPriceMinor: f.int(0, MAX_UNIT_PRICE_MINOR),
    discountBp: f.int(0, 10_000).optional(),
    taxBp: f.int(0, 10_000).optional(),
  })
  .strict();

/** `working-calendar.validate.ts` parseCalendarInput. */
const calendarBody = {
  workingDays: z.array(f.int(0, 6)).min(1).max(7),
  dayStart: z.string().regex(/^\d{2}:\d{2}$/u, 'HH:MM'),
  dayEnd: z.string().regex(/^\d{2}:\d{2}$/u, 'HH:MM'),
  timeZone: z.string().min(1).max(64),
  version: safeCount(),
};

/** `finance-rules.ts` validateProfile: every field optional (absent keeps the current value). */
const addressJson = z
  .object(
    Object.fromEntries(ADDRESS_FIELDS.map((k) => [k, z.string().max(120).nullable().optional()])),
  )
  .strict()
  .nullable()
  .optional();

/** `pm-sources.ts` isPmBoardId: a Trello board id (24 hex) or an Asana project gid (digits). */
const pmBoardIds = () =>
  z
    .array(z.string().regex(/^([0-9a-f]{24}|\d{1,30})$/u, 'a Trello board id or Asana gid'))
    .min(1)
    .max(MAX_PM_BOARDS);
const pmOptions = {
  source: z.enum(PM_SOURCES),
  projectId: uuid(),
  boardIds: pmBoardIds(),
  statusMap: z.record(z.string().max(120), z.enum(PM_TARGET_STATES)).optional(),
  userMap: z.record(z.string().max(254), uuid().nullable()).optional(),
};

const webhookEvents = () =>
  z.array(z.enum(WEBHOOK_EVENT_KINDS)).min(1).max(WEBHOOK_EVENT_KINDS.length);

const PDF_NOTE = 'The result is the file itself (application/pdf), not JSON.';

// ---- details ----

export const workDetails: readonly AiActionDetail[] = [
  // Automations.
  det({
    id: 'automations.apps.list',
    title: 'List the automation app directory',
    description:
      'The integration catalog (id, name, category, what each app can do), each app with this ' +
      'workspace’s recorded connections (id, label, status, non-secret settings). No secrets.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Directory', args: {} }],
  }),
  det({
    id: 'automations.apps.connections.create',
    title: 'Record a connection to a catalog app',
    description:
      'Add a connection record for one app from automations.apps.list. label is required; ' +
      'status is connected or pending (default pending); config is non-secret settings only ' +
      '(at most 30 keys, values text, number or true/false) — a key that looks like a password, ' +
      'token or API key is refused. No credential is stored. An off-catalog appId is a 404.',
    input: bodyArgs(['appId'], {
      label: f.shortText(300),
      status: z.enum(INTEGRATION_CONNECTION_STATUSES).optional(),
      config: z
        .record(z.string().min(1).max(64), z.union([z.string().max(2048), z.number(), z.boolean()]))
        .optional(),
    }),
    redact: 'config',
    examples: [
      {
        summary: 'Slack, pending',
        args: { appId: 'slack', label: 'Studio Slack', config: { channel: 'general' } },
      },
    ],
  }),
  det({
    id: 'automations.connections.health.get',
    title: 'Check one connection’s health',
    description:
      'The health verdict of one recorded integration connection (id from automations.apps.list).',
    input: pathOnly('id'),
    redact: 'standard',
    examples: [{ summary: 'One connection', args: { id: 'conn_1' } }],
  }),
  det({
    id: 'automations.connections.health.list',
    title: 'Check every connection’s health',
    description: 'The health verdict of every integration connection the workspace has recorded.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'All', args: {} }],
  }),
  det({
    id: 'automations.variables.delete',
    title: 'Delete an automation variable',
    description:
      'Remove one automation variable by its key (starts with a letter; letters, digits or ' +
      'underscore; at most 64). Automations that read it get nothing afterwards.',
    input: bodyArgs([], {
      key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u, 'a variable key'),
    }),
    redact: 'config',
    examples: [{ summary: 'Remove', args: { key: 'client_code' } }],
  }),
  det({
    id: 'automations.webhooks.deliveries.list',
    title: 'List a webhook’s deliveries',
    description:
      'Recent delivery attempts of one outbound webhook endpoint, newest first: status, response ' +
      'code and time (never a body or the secret). limit 1–200 (default 50); before is the last ' +
      'id of the previous page (nextCursor).',
    input: bodyArgs(['endpointId'], {
      limit: f.int(1, WEBHOOK_DELIVERIES_PAGE_MAX).optional(),
      before: f.id(64).optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'Latest 20', args: { endpointId: 'wh_1', limit: 20 } }],
  }),
  det({
    id: 'automations.webhooks.update',
    title: 'Edit a webhook',
    description:
      'Turn an outbound webhook on or off, change the events it is subscribed to, or its ' +
      'description (null clears it). Send at least one field. Events are sent to the endpoint’s ' +
      'outside URL, so this changes what leaves the workspace.',
    input: bodyArgs(['id'], {
      enabled: f.bool().optional(),
      events: webhookEvents().optional(),
      description: z.string().max(WEBHOOK_DESCRIPTION_MAX).nullable().optional(),
    }),
    redact: 'config',
    examples: [{ summary: 'Turn off', args: { id: 'wh_1', enabled: false } }],
  }),
  det({
    id: 'automations.webhooks.pause',
    title: 'Pause a webhook',
    description: 'Stop deliveries to one webhook endpoint; staged attempts are cancelled.',
    input: pathOnly('id'),
    redact: 'config',
    examples: [{ summary: 'Pause', args: { id: 'wh_1' } }],
  }),
  det({
    id: 'automations.webhooks.resume',
    title: 'Resume a webhook',
    description:
      'Resume a paused webhook endpoint and clear its failure streak. Refused when the URL now ' +
      'resolves to a private address (400) or the endpoint needs a new secret first (409).',
    input: pathOnly('id'),
    redact: 'config',
    examples: [{ summary: 'Resume', args: { id: 'wh_1' } }],
  }),
  det({
    id: 'automations.webhooks.replay',
    title: 'Replay past events to a webhook',
    description:
      'Re-send the workspace’s past events of the endpoint’s kinds between from and to ' +
      '(ISO-8601 instants, a window of at most 7 days, not in the future, at most 10 000 ' +
      'events). At most one replay per endpoint per hour; the endpoint must be active.',
    input: bodyArgs(['id'], { from: f.iso(), to: f.iso() }),
    redact: 'config',
    examples: [
      {
        summary: 'One day',
        args: { id: 'wh_1', from: '2026-11-20T00:00:00Z', to: '2026-11-21T00:00:00Z' },
      },
    ],
  }),
  det({
    id: 'automations.webhooks.deliveries.retry',
    title: 'Retry a webhook delivery',
    description:
      'Queue one failed delivery again (ids from automations.webhooks.deliveries.list). ' +
      'Returns the delivery id and the attempt number.',
    input: pathOnly('endpointId', 'deliveryId'),
    redact: 'standard',
    examples: [{ summary: 'Retry', args: { endpointId: 'wh_1', deliveryId: 'whd_9' } }],
  }),
  det({
    id: 'integrations.github.repo_hooks.list',
    title: 'List GitHub repository hooks',
    description:
      'The GitHub repositories connected by a pasted webhook, each with the projects it feeds. ' +
      'Never the secret.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'All', args: {} }],
  }),
  det({
    id: 'integrations.github.repo_hooks.delete',
    title: 'Remove a GitHub repository hook',
    description:
      'Disconnect one GitHub repository hook (id from integrations.github.repo_hooks.list); its ' +
      'delivery ids go with it and GitHub’s later deliveries are refused.',
    input: pathOnly('id'),
    redact: 'config',
    examples: [{ summary: 'Remove', args: { id: 'gh_1' } }],
  }),
  // Record files.
  det({
    id: 'approvals.record.pdf.get',
    title: 'Download an approval certificate (PDF)',
    description:
      `The sealed approval record of one approval as a PDF certificate. ${PDF_NOTE} ` +
      'approvals.record.get gives the same facts as JSON.',
    input: pathOnly('approvalId'),
    redact: 'standard',
    examples: [{ summary: 'Certificate', args: { approvalId: 'ap_1' } }],
  }),
  det({
    id: 'approvals.projections.record.pdf.get',
    title: 'Download my approval certificate for a version (PDF)',
    description:
      'The certificate of the caller’s own decisions on a deliverable version published to them. ' +
      `${PDF_NOTE} approvals.projections.record.get gives the same facts as JSON.`,
    input: pathOnly('deliverableVersionId'),
    redact: 'client_safe',
    examples: [{ summary: 'Certificate', args: { deliverableVersionId: 'dv_1' } }],
  }),
  det({
    id: 'approvals.evidence.get',
    title: 'Download an approval evidence bundle (ZIP)',
    description:
      'The approval’s evidence bundle: the record PDF, the approved file and the chain proof. ' +
      'The result is the file itself (application/zip), not JSON; approvals.record.get gives ' +
      'the record as JSON. Rate-limited per workspace (5 a minute, 30 an hour).',
    input: pathOnly('approvalId'),
    redact: 'standard',
    examples: [{ summary: 'Bundle', args: { approvalId: 'ap_1' } }],
  }),
  det({
    id: 'esign.requests.signed_pdf.get',
    title: 'Download a signed document (PDF)',
    description:
      'The team’s copy of a signed document with its signature pages (id from ' +
      `esign.requests.list). ${PDF_NOTE} esign.requests.get gives the request as JSON.`,
    input: pathOnly('signatureRequestId'),
    redact: 'standard',
    examples: [{ summary: 'Signed copy', args: { signatureRequestId: 'sr_1' } }],
  }),
  det({
    id: 'esign.portal.signed_pdf.get',
    title: 'Download my signed document (PDF)',
    description:
      'The signer’s own copy of a signed document in the client portal (id from ' +
      `esign.portal.list); a request not addressed to the caller is a 404. ${PDF_NOTE}`,
    input: pathOnly('signatureRequestId'),
    redact: 'client_safe',
    examples: [{ summary: 'My copy', args: { signatureRequestId: 'sr_1' } }],
  }),
  det({
    id: 'projects.export.get',
    title: 'Export a project',
    description:
      'Download one project’s work items as a file: format csv (ClickUp task-CSV columns) or ' +
      'json. The result is the file itself, not a JSON summary; work_items.list gives the same ' +
      'items as JSON. Rate-limited.',
    input: bodyArgs(['projectId'], { format: z.enum(PROJECT_EXPORT_FORMATS) }),
    redact: 'standard',
    examples: [{ summary: 'CSV', args: { projectId: 'pr_1', format: 'csv' } }],
  }),
  // Public form.
  det({
    id: 'work_forms.attachments.set',
    title: 'Turn file attachments on or off for a public form',
    description:
      'Let visitors of a published public form attach files, stored in projectId (a project ' +
      'id from projects.list), or turn attachments off with projectId null. Opens or closes ' +
      'an upload door to the public.',
    input: bodyArgs(['formId'], { projectId: z.string().min(1).max(36).nullable() }),
    redact: 'standard',
    examples: [
      { summary: 'On', args: { formId: 'wf_1', projectId: 'pr_1' } },
      { summary: 'Off', args: { formId: 'wf_1', projectId: null } },
    ],
  }),
  // Quote and invoice documents.
  det({
    id: 'quotes.pdf.get',
    title: 'Download a quote (PDF)',
    description:
      'One quote as a PDF (id from quotes.list). lang: en, ar or bi (both); default the ' +
      `quote’s own language. ${PDF_NOTE} quotes.get gives the same facts as JSON.`,
    input: bodyArgs(['quoteId'], { lang: lang() }),
    redact: 'finance',
    examples: [{ summary: 'Bilingual', args: { quoteId: 'q_1', lang: 'bi' } }],
  }),
  det({
    id: 'portal.quotes.pdf.get',
    title: 'Download a quote sent to me (PDF)',
    description:
      'A quote sent to the caller’s company, as a PDF, in the client portal. lang: en, ar or ' +
      `bi. ${PDF_NOTE}`,
    input: bodyArgs(['quoteId'], { lang: lang() }),
    redact: 'client_safe',
    examples: [{ summary: 'English', args: { quoteId: 'q_1', lang: 'en' } }],
  }),
  det({
    id: 'client_invoices.payments.record',
    title: 'Record a payment on an invoice',
    description:
      'Record money received against an issued client invoice (id from client_invoices.list): ' +
      'paidOn (YYYY-MM-DD), amountMinor (minor units, at least 1), method transfer, cash, ' +
      'cheque or card_offline (default transfer), optional reference and note. Returns the ' +
      'invoice with its new balance. Money: a person confirms.',
    input: bodyArgs(['invoiceId'], {
      paidOn: day(),
      amountMinor: f.int(1, MAX_UNIT_PRICE_MINOR),
      method: z.enum(PAYMENT_METHODS).optional(),
      reference: z.string().max(120).nullable().optional(),
      note: z.string().max(MAX_DESCRIPTION).nullable().optional(),
    }),
    redact: 'finance',
    examples: [
      {
        summary: 'Bank transfer',
        args: { invoiceId: 'inv_1', paidOn: '2026-11-20', amountMinor: 115000, method: 'transfer' },
      },
    ],
  }),
  det({
    id: 'client_invoices.void',
    title: 'Void an invoice',
    description:
      'Void an issued client invoice with a reason (required, at most 500 characters). The ' +
      'number stays used; a void cannot be undone. Money: a person confirms.',
    input: bodyArgs(['invoiceId'], { reason: f.shortText(MAX_DESCRIPTION) }),
    redact: 'finance',
    examples: [{ summary: 'Duplicate', args: { invoiceId: 'inv_1', reason: 'Issued twice' } }],
  }),
  det({
    id: 'client_invoices.credit_notes.create',
    title: 'Issue a credit note',
    description:
      'Credit an issued invoice: a reason, then either full: true (credit every line as issued) ' +
      `or lines (1–${MAX_INVOICE_LINES}, each with descriptionEn or descriptionAr, quantity, ` +
      'unitPriceMinor, optional unit, discountBp, taxBp). Issues a numbered document. Money: a ' +
      'person confirms.',
    input: bodyArgs(['invoiceId'], {
      reason: f.shortText(MAX_DESCRIPTION),
      full: z.literal(true).optional(),
      lines: z.array(creditLine).min(1).max(MAX_INVOICE_LINES).optional(),
    }),
    redact: 'finance',
    examples: [
      { summary: 'Whole invoice', args: { invoiceId: 'inv_1', reason: 'Cancelled', full: true } },
      {
        summary: 'One line',
        args: {
          invoiceId: 'inv_1',
          reason: 'Discount agreed',
          lines: [{ descriptionEn: 'Goodwill', quantity: 1, unitPriceMinor: 10000 }],
        },
      },
    ],
  }),
  det({
    id: 'client_invoices.print.get',
    title: 'Get an invoice’s print view (HTML)',
    description:
      'The invoice as a printable HTML page (text/html, every value escaped). lang: en, ar or ' +
      'bi. client_invoices.get gives the same facts as JSON.',
    input: bodyArgs(['invoiceId'], { lang: lang() }),
    redact: 'finance',
    examples: [{ summary: 'Arabic', args: { invoiceId: 'inv_1', lang: 'ar' } }],
  }),
  det({
    id: 'client_invoices.einvoice.get',
    title: 'Get an invoice’s e-invoice status',
    description:
      'The e-invoice record of an issued invoice (ZATCA or PINT AE): regime, status, counter, ' +
      'previous hash, XML hash and whether the rebuilt XML still matches.',
    input: pathOnly('invoiceId'),
    redact: 'finance',
    examples: [{ summary: 'Status', args: { invoiceId: 'inv_1' } }],
  }),
  det({
    id: 'client_invoices.pdf.get',
    title: 'Download an invoice (PDF)',
    description:
      'One client invoice as a PDF (id from client_invoices.list). lang: en, ar or bi; default ' +
      `the invoice’s own. ${PDF_NOTE} client_invoices.get gives the same facts as JSON.`,
    input: bodyArgs(['invoiceId'], { lang: lang() }),
    redact: 'finance',
    examples: [{ summary: 'Default language', args: { invoiceId: 'inv_1' } }],
  }),
  det({
    id: 'portal.invoices.print.get',
    title: 'Get my invoice’s print view (HTML)',
    description:
      'An invoice addressed to the caller’s company as a printable HTML page, in the client ' +
      'portal. lang: en, ar or bi. portal.invoices.get gives the same facts as JSON.',
    input: bodyArgs(['invoiceId'], { lang: lang() }),
    redact: 'client_safe',
    examples: [{ summary: 'English', args: { invoiceId: 'inv_1', lang: 'en' } }],
  }),
  det({
    id: 'portal.invoices.pdf.get',
    title: 'Download my invoice (PDF)',
    description:
      'An invoice addressed to the caller’s company as a PDF, in the client portal. lang: en, ar ' +
      `or bi. ${PDF_NOTE} portal.invoices.get gives the same facts as JSON.`,
    input: bodyArgs(['invoiceId'], { lang: lang() }),
    redact: 'client_safe',
    examples: [{ summary: 'PDF', args: { invoiceId: 'inv_1' } }],
  }),
  // Finance settings.
  det({
    id: 'finance.profile.get',
    title: 'Get the finance settings',
    description:
      'The workspace’s finance profile: country, base currency, tax number and scheme, default ' +
      'tax rate, legal names and addresses, document prefixes and numbering, week start, digits, ' +
      'payment terms, VAT status and e-invoice regime (and bank details for finance managers).',
    input: noArgs(),
    redact: 'finance',
    examples: [{ summary: 'Profile', args: {} }],
  }),
  det({
    id: 'finance.profile.set',
    title: 'Change the finance settings',
    description:
      'Change any field of the finance profile; absent fields keep their value. version is the ' +
      'one last read (finance.profile.get) — a stale one is a 409. Prefixes are 1–16 of A-Z, ' +
      '0-9 or -; defaultTaxRateBp 0–10000; weekStart 0 (Sunday)–6. Changes what every new ' +
      'invoice and quote says. Rounding has its own op (time.rounding.set).',
    input: bodyArgs([], {
      version: safeCount().optional(),
      country: z
        .string()
        .regex(/^[A-Z]{2}$/u, 'ISO country code')
        .optional(),
      baseCurrency: currency().optional(),
      taxRegistrationNo: z
        .string()
        .regex(/^([A-Za-z0-9-]{3,32})?$/u)
        .nullable()
        .optional(),
      taxScheme: z.enum(['VAT', 'GST', 'NONE']).optional(),
      defaultTaxRateBp: f.int(0, 10_000).optional(),
      legalNameEn: nullableText(200),
      legalNameAr: nullableText(200),
      addressEn: nullableText(500),
      addressAr: nullableText(500),
      invoicePrefix: prefix().optional(),
      quotePrefix: prefix().optional(),
      creditNotePrefix: prefix().optional(),
      numberingReset: z.enum(NUMBERING_RESETS).optional(),
      weekStart: f.int(0, 6).optional(),
      digits: z.enum(DIGIT_SYSTEMS).optional(),
      showHijri: f.bool().optional(),
      bankDetailsText: nullableText(2000),
      paymentTermsDays: f.int(0, 365).optional(),
      vatRegistrationStatus: z.enum(VAT_REGISTRATION_STATUSES).optional(),
      einvoiceRegime: z.enum(EINVOICE_REGIMES).nullable().optional(),
      addressJson,
    }),
    redact: 'finance',
    examples: [
      { summary: 'Payment terms', args: { version: 3, paymentTermsDays: 14 } },
      { summary: 'Invoice prefix', args: { invoicePrefix: 'INV-' } },
    ],
  }),
  det({
    id: 'finance.tax_rates.list',
    title: 'List tax rates',
    description:
      'The workspace’s tax rates: code, English and Arabic names, rate in basis points, ZATCA ' +
      'category, default and archived flags.',
    input: noArgs(),
    redact: 'finance',
    examples: [{ summary: 'All', args: {} }],
  }),
  det({
    id: 'finance.tax_rates.create',
    title: 'Add a tax rate',
    description:
      'Add a tax rate: code (A-Z, 0-9, _; 1–16), nameEn and nameAr (1–64), rateBp 0–10000 ' +
      '(1500 = 15 %), optional zatcaCategory S, Z, E or O, optional isDefault.',
    input: bodyArgs([], {
      code: z.string().regex(/^[A-Z0-9_]{1,16}$/u, 'A-Z, 0-9 or _'),
      nameEn: f.shortText(64),
      nameAr: f.shortText(64),
      rateBp: f.int(0, 10_000),
      zatcaCategory: z.enum(ZATCA_CATEGORIES).nullable().optional(),
      isDefault: f.bool().optional(),
    }),
    redact: 'finance',
    examples: [
      {
        summary: 'Reduced rate',
        args: { code: 'RED5', nameEn: 'Reduced', nameAr: 'مخفّض', rateBp: 500, zatcaCategory: 'S' },
      },
    ],
  }),
  det({
    id: 'finance.tax_rates.update',
    title: 'Edit a tax rate',
    description:
      'Change a tax rate’s names, rate, ZATCA category, default or archived flag (id from ' +
      'finance.tax_rates.list); absent fields keep their value, the code never changes. An ' +
      'archived rate cannot be the default.',
    input: bodyArgs(['taxRateId'], {
      nameEn: f.shortText(64).optional(),
      nameAr: f.shortText(64).optional(),
      rateBp: f.int(0, 10_000).optional(),
      zatcaCategory: z.enum(ZATCA_CATEGORIES).nullable().optional(),
      isDefault: f.bool().optional(),
      archived: f.bool().optional(),
    }),
    redact: 'finance',
    examples: [{ summary: 'New rate', args: { taxRateId: 'tr_1', rateBp: 1500 } }],
  }),
  det({
    id: 'finance.exchange_rates.list',
    title: 'List exchange rates',
    description:
      'The manual exchange rates, newest first. Optional from and to (currency codes), limit ' +
      '1–200 (default 50).',
    input: bodyArgs([], {
      from: currency().optional(),
      to: currency().optional(),
      limit: f.int(1, FINANCE_LIST_MAX).optional(),
    }),
    redact: 'finance',
    examples: [{ summary: 'USD to SAR', args: { from: 'USD', to: 'SAR' } }],
  }),
  det({
    id: 'finance.exchange_rates.create',
    title: 'Add an exchange rate',
    description:
      'Record a manual exchange rate: fromCurrency and toCurrency (different), rate as a ' +
      'positive decimal string (up to 10 digits and 8 decimals) and effectiveOn (YYYY-MM-DD).',
    input: bodyArgs([], {
      fromCurrency: currency(),
      toCurrency: currency(),
      rate: z.string().regex(/^\d{1,10}(\.\d{1,8})?$/u, 'a positive decimal'),
      effectiveOn: day(),
    }),
    redact: 'finance',
    examples: [
      {
        summary: 'USD to SAR',
        args: { fromCurrency: 'USD', toCurrency: 'SAR', rate: '3.75', effectiveOn: '2026-11-01' },
      },
    ],
  }),
  det({
    id: 'finance.readiness.get',
    title: 'Check finance readiness',
    description:
      'What is still missing before invoicing and e-invoicing work: the invoicing and ' +
      'e-invoicing checklists, the e-invoice regime in force and whether it is ready.',
    input: noArgs(),
    redact: 'finance',
    examples: [{ summary: 'Readiness', args: {} }],
  }),
  // Time.
  det({
    id: 'time.auto.get',
    title: 'Get my automatic time tracking',
    description:
      'The caller’s automatic tracking: the workspace policy, their own switch, the task they ' +
      'are working on now and the session in progress.',
    input: noArgs(),
    redact: 'finance',
    examples: [{ summary: 'Mine', args: {} }],
  }),
  det({
    id: 'time.auto.settings.set',
    title: 'Turn my automatic tracking on or off',
    description:
      'The caller’s own switch for automatic tracking (enabled; absent means off). With the ' +
      'workspace policy "required" it stays on; turning it off files the open session.',
    input: bodyArgs([], { enabled: f.bool().optional() }),
    redact: 'finance',
    examples: [{ summary: 'On', args: { enabled: true } }],
  }),
  det({
    id: 'time.timer.discard',
    title: 'Discard my running timer',
    description:
      'Throw away the caller’s running timer without logging its time (time.timer.stop logs ' +
      'it instead). 409 when no timer runs.',
    input: noArgs(),
    redact: 'finance',
    examples: [{ summary: 'Discard', args: {} }],
  }),
  det({
    id: 'time.auto.current_task.set',
    title: 'Set what I am working on now',
    description:
      'Set (or clear, with both null) the work item or project automatic tracking books the ' +
      'caller’s time to. The session in progress is split at this moment. Rate-limited.',
    input: bodyArgs([], {
      workItemId: uuid().nullable().optional(),
      projectId: uuid().nullable().optional(),
    }),
    redact: 'finance',
    examples: [
      { summary: 'A task', args: { workItemId: '0193a1b2-0000-7000-8000-000000000001' } },
      { summary: 'Clear', args: { workItemId: null, projectId: null } },
    ],
  }),
  det({
    id: 'time.auto.heartbeat',
    title: 'Send an activity heartbeat',
    description:
      'Tell automatic tracking the caller is active: idleSeconds is how long they have been ' +
      'idle (0 or more). Extends or closes the session; 409 when tracking is off for them. ' +
      'Rate-limited.',
    input: bodyArgs([], { idleSeconds: f.int(0, Number.MAX_SAFE_INTEGER) }),
    redact: 'finance',
    examples: [{ summary: 'Active', args: { idleSeconds: 0 } }],
  }),
  det({
    id: 'time.auto.policy.set',
    title: 'Set the automatic tracking policy',
    description:
      'Company owner only: automatic tracking off, optional or required for everyone, and ' +
      `optionally maxIdleMinutes (${IDLE_THRESHOLD_MIN_MINUTES}–${IDLE_THRESHOLD_MAX_MINUTES}), ` +
      'when someone counts as away. "off" files every open session at once.',
    input: bodyArgs([], {
      policy: z.enum(AUTO_TRACKING_POLICIES),
      maxIdleMinutes: f.int(IDLE_THRESHOLD_MIN_MINUTES, IDLE_THRESHOLD_MAX_MINUTES).optional(),
    }),
    redact: 'config',
    examples: [{ summary: 'Optional, 5 min', args: { policy: 'optional', maxIdleMinutes: 5 } }],
  }),
  det({
    id: 'time.auto.device.set',
    title: 'Report where my tracking runs',
    description:
      'Report the caller’s tracking device: desktop, or a browser whose idle permission is ' +
      'allowed, prompt, blocked or unsupported. The owner sees it in team time.',
    input: bodyArgs([], { device: z.enum(TRACKING_DEVICE_KINDS) }),
    redact: 'standard',
    examples: [{ summary: 'Desktop app', args: { device: 'desktop' } }],
  }),
  det({
    id: 'time.rounding.set',
    title: 'Set time rounding',
    description:
      'Company owner only: round logged time up to 5, 6, 10, 15 or 30 minutes, or 1 for no ' +
      'rounding. Changes how much billable time every new entry counts.',
    input: bodyArgs([], { roundingMinutes: z.literal(TIME_ROUNDING_CHOICES) }),
    redact: 'finance',
    examples: [{ summary: 'Quarter hours', args: { roundingMinutes: 15 } }],
  }),
  det({
    id: 'time.team.list',
    title: 'See the team’s time',
    description:
      'Who is working now and on what, and each person’s minutes today, this week and in the ' +
      'range from–to (YYYY-MM-DD, default this week, at most 62 days). Optional membershipId ' +
      'or projectId filter.',
    input: bodyArgs([], {
      from: day().optional(),
      to: day().optional(),
      membershipId: uuid().optional(),
      projectId: uuid().optional(),
    }),
    redact: 'finance',
    examples: [{ summary: 'This week', args: {} }],
  }),
  det({
    id: 'time.team.day.get',
    title: 'See one person’s day',
    description:
      'One person’s sessions on one company day (membershipId from time.team.list; day ' +
      'YYYY-MM-DD, default today): start, end, task, automatic or manual.',
    input: bodyArgs(['membershipId'], { day: day().optional() }),
    redact: 'finance',
    examples: [
      { summary: 'Today', args: { membershipId: '0193a1b2-0000-7000-8000-000000000002' } },
    ],
  }),
  det({
    id: 'time.locks.create',
    title: 'Lock a time period',
    description:
      'Lock whole calendar months against time changes: periodStart is the first of a month, ' +
      'periodEnd the last day of a month (YYYY-MM-DD), within five years. An overlapping open ' +
      'lock is a 409. Money: a person confirms.',
    input: bodyArgs([], { periodStart: day(), periodEnd: day() }),
    redact: 'finance',
    examples: [
      { summary: 'October', args: { periodStart: '2026-10-01', periodEnd: '2026-10-31' } },
    ],
  }),
  det({
    id: 'time.locks.delete',
    title: 'Unlock a time period',
    description:
      'Reopen a locked period (id from time.locks.list) with a reason ' +
      `(${UNLOCK_REASON_MIN}–${UNLOCK_REASON_MAX} characters). Money: a person confirms.`,
    input: bodyArgs(['lockId'], {
      reason: z.string().min(UNLOCK_REASON_MIN).max(UNLOCK_REASON_MAX),
    }),
    redact: 'finance',
    examples: [{ summary: 'Correction', args: { lockId: 'tl_1', reason: 'Late timesheet fix' } }],
  }),
  // Chat groups.
  det({
    id: 'conversations.group.update',
    title: 'Change a chat group’s settings',
    description:
      'Group admins only: rename (1–120), describe (null clears, at most 500), set the photo ' +
      '(a file id or null) or who may send (onlyAdminsCanSend). Send at least one field. ' +
      'Members see a notice in the chat.',
    input: bodyArgs(['conversationId'], {
      name: f.shortText(120).optional(),
      description: z.string().max(500).nullable().optional(),
      photoFileAssetId: uuid().nullable().optional(),
      onlyAdminsCanSend: f.bool().optional(),
    }),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Rename', args: { conversationId: 'cv_1', name: 'Launch team' } }],
  }),
  det({
    id: 'conversations.group.members.add',
    title: 'Add someone to a chat group',
    description:
      'Group admins only: add an active member or client contact of the workspace (userId) to ' +
      'the group. They see the conversation from now on; the group gets a notice.',
    input: bodyArgs(['conversationId'], { userId: uuid() }),
    redact: 'standard',
    notifies: true,
    examples: [
      {
        summary: 'Add',
        args: { conversationId: 'cv_1', userId: '0193a1b2-0000-7000-8000-000000000003' },
      },
    ],
  }),
  det({
    id: 'conversations.group.members.remove',
    title: 'Remove someone from a chat group',
    description:
      'Group admins only: remove a person (userId from conversations.members.list). Naming ' +
      'yourself leaves the group. The group gets a notice.',
    input: pathOnly('conversationId', 'userId'),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Remove', args: { conversationId: 'cv_1', userId: 'u_3' } }],
  }),
  det({
    id: 'conversations.group.members.role.set',
    title: 'Make someone a group admin or member',
    description:
      'Group admins only: role admin or member. A client contact cannot be an admin, and a ' +
      'group keeps at least one admin.',
    input: bodyArgs(['conversationId', 'userId'], { role: z.enum(['admin', 'member']) }),
    redact: 'standard',
    notifies: true,
    examples: [
      { summary: 'Make admin', args: { conversationId: 'cv_1', userId: 'u_3', role: 'admin' } },
    ],
  }),
  det({
    id: 'conversations.group.leave',
    title: 'Leave a chat group',
    description:
      'The caller leaves the group. When they were the last admin, the oldest remaining ' +
      'internal member becomes admin.',
    input: pathOnly('conversationId'),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Leave', args: { conversationId: 'cv_1' } }],
  }),
  det({
    id: 'portal.chat.list',
    title: 'List my portal chats',
    description: 'The client contact’s chats in the portal, with the caller’s own user id.',
    input: noArgs(),
    redact: 'client_safe',
    examples: [{ summary: 'Chats', args: {} }],
  }),
  // Working calendars.
  det({
    id: 'working_calendar.get',
    title: 'Get the working calendar',
    description:
      'The workspace’s working days, hours, time zone, holidays and version — what due-date ' +
      'and schedule maths use.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Calendar', args: {} }],
  }),
  det({
    id: 'working_calendar.set',
    title: 'Change the working calendar',
    description:
      'Set the working days (weekday numbers, 0 = Sunday … 6 = Saturday, at least one), dayStart ' +
      'and dayEnd (HH:MM, start before end), timeZone (IANA) and the version last read ' +
      '(working_calendar.get; 0 when none existed). Moves schedule maths for every project ' +
      'without its own calendar.',
    input: bodyArgs([], calendarBody),
    redact: 'standard',
    examples: [
      {
        summary: 'Sun–Thu',
        args: {
          workingDays: [0, 1, 2, 3, 4],
          dayStart: '09:00',
          dayEnd: '17:00',
          timeZone: 'Asia/Riyadh',
          version: 2,
        },
      },
    ],
  }),
  det({
    id: 'working_calendar.holidays.create',
    title: 'Add a holiday',
    description:
      'Add a non-working day: date (YYYY-MM-DD, within five years), labelEn (required) and ' +
      `labelAr (optional), each at most ${MAX_HOLIDAY_LABEL_LENGTH} characters, no markup.`,
    input: bodyArgs([], {
      date: day(),
      labelEn: f.shortText(MAX_HOLIDAY_LABEL_LENGTH),
      labelAr: z.string().max(MAX_HOLIDAY_LABEL_LENGTH).nullable().optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'National Day', args: { date: '2026-09-23', labelEn: 'National Day' } }],
  }),
  det({
    id: 'working_calendar.holidays.delete',
    title: 'Remove a holiday',
    description: 'Remove one holiday (id from working_calendar.get); it becomes a working day.',
    input: pathOnly('holidayId'),
    redact: 'standard',
    examples: [{ summary: 'Remove', args: { holidayId: 'hol_1' } }],
  }),
  det({
    id: 'working_calendar.holidays.import_pack',
    title: 'Import a holiday pack',
    description:
      `Add a shipped public-holiday pack (packKey: ${HOLIDAY_PACK_KEYS.join(', ')}); dates ` +
      'already on the calendar are skipped.',
    input: bodyArgs([], { packKey: z.enum(HOLIDAY_PACK_KEYS) }),
    redact: 'standard',
    examples: [{ summary: 'Saudi 2027', args: { packKey: 'ksa-2027' } }],
  }),
  det({
    id: 'projects.working_calendar.get',
    title: 'Get a project’s working calendar',
    description:
      'The working calendar a project uses: its own override, or the workspace calendar when ' +
      'it has none.',
    input: pathOnly('projectId'),
    redact: 'standard',
    examples: [{ summary: 'Project', args: { projectId: 'pr_1' } }],
  }),
  det({
    id: 'projects.working_calendar.set',
    title: 'Give a project its own working calendar',
    description:
      'Set a project’s own working days, hours and time zone (same rules as ' +
      'working_calendar.set; version from projects.working_calendar.get, 0 for a first override).',
    input: bodyArgs(['projectId'], calendarBody),
    redact: 'standard',
    examples: [
      {
        summary: 'Mon–Fri',
        args: {
          projectId: 'pr_1',
          workingDays: [1, 2, 3, 4, 5],
          dayStart: '08:00',
          dayEnd: '16:00',
          timeZone: 'Europe/London',
          version: 0,
        },
      },
    ],
  }),
  det({
    id: 'projects.working_calendar.delete',
    title: 'Remove a project’s own working calendar',
    description: 'Drop a project’s calendar override; it follows the workspace calendar again.',
    input: pathOnly('projectId'),
    redact: 'standard',
    examples: [{ summary: 'Reset', args: { projectId: 'pr_1' } }],
  }),
  // Invite contacts.
  det({
    id: 'contacts.import_file',
    title: 'Import invite contacts from a file',
    description:
      'Keep the e-mail addresses of a CSV or vCard file (text, at most 2 MB) as the caller’s own ' +
      'invite suggestions. mapping (CSV only) names the 0-based columns for email, name and ' +
      'company; createClients also adds new companies as client companies (needs org.manage). ' +
      'Returns counts only, never addresses. Needs people.invite or client_member.manage.',
    input: bodyArgs([], {
      format: z.enum(['csv', 'vcard']),
      text: z.string().min(1).max(CONTACT_IMPORT_MAX_BYTES),
      mapping: z
        .object({
          email: f.int(0, 1000),
          name: f.int(0, 1000).nullable().optional(),
          company: f.int(0, 1000).nullable().optional(),
        })
        .strict()
        .nullable()
        .optional(),
      createClients: f.bool().optional(),
    }),
    redact: 'people',
    examples: [
      {
        summary: 'CSV',
        args: { format: 'csv', text: 'email,name\nsara@example.com,Sara\n' },
      },
    ],
  }),
  det({
    id: 'contacts.suggestions.list',
    title: 'Suggest people to invite',
    description:
      `At most 20 of the caller’s own invite suggestions matching q (1–${SUGGEST_QUERY_MAX} ` +
      'characters).',
    input: bodyArgs([], { q: z.string().min(1).max(SUGGEST_QUERY_MAX) }),
    redact: 'people',
    examples: [{ summary: 'By name', args: { q: 'sar' } }],
  }),
  det({
    id: 'contacts.import_preview',
    title: 'Preview a contacts import',
    description:
      'What contacts.import_file would do with this file, row by row (duplicates by e-mail, ' +
      'errors). Writes nothing. Same inputs as contacts.import_file.',
    input: bodyArgs([], {
      format: z.enum(['csv', 'vcard']),
      text: z.string().min(1).max(CONTACT_IMPORT_MAX_BYTES),
      mapping: z
        .object({
          email: f.int(0, 1000),
          name: f.int(0, 1000).nullable().optional(),
          company: f.int(0, 1000).nullable().optional(),
        })
        .strict()
        .nullable()
        .optional(),
      createClients: f.bool().optional(),
    }),
    redact: 'people',
    examples: [{ summary: 'vCard', args: { format: 'vcard', text: 'BEGIN:VCARD\nEND:VCARD\n' } }],
  }),
  det({
    id: 'contacts.suggestions.clear',
    title: 'Clear my invite suggestions',
    description: 'Delete every invite suggestion the caller has imported.',
    input: noArgs(),
    redact: 'people',
    examples: [{ summary: 'Clear', args: {} }],
  }),
  // Schedule.
  det({
    id: 'work_items.dependencies.update',
    title: 'Edit a dependency',
    description:
      'Change a typed dependency of a work item: kind FS, SS, FF or SF and/or lagWorkingDays ' +
      `(${MIN_DEPENDENCY_LAG}–${MAX_DEPENDENCY_LAG}). Send at least one. Ids from ` +
      'projects.dependencies.list.',
    input: bodyArgs(['workItemId', 'dependencyId'], {
      kind: z.enum(DEPENDENCY_KINDS).optional(),
      lagWorkingDays: f.int(MIN_DEPENDENCY_LAG, MAX_DEPENDENCY_LAG).optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Start-to-start',
        args: { workItemId: 'wi_1', dependencyId: 'dep_1', kind: 'SS' },
      },
    ],
  }),
  det({
    id: 'work_items.schedule.cascade_preview',
    title: 'Preview a schedule cascade',
    description:
      'What moving a work item to startAt / dueAt (ISO dates or null, start ≤ due; both ' +
      'required) would do to the items that depend on it. Writes nothing; pass the returned ' +
      'move list to work_items.schedule.cascade_apply.',
    input: bodyArgs(['workItemId'], {
      startAt: f.iso().nullable(),
      dueAt: f.iso().nullable(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Slip a week',
        args: { workItemId: 'wi_1', startAt: '2026-12-07', dueAt: '2026-12-11' },
      },
    ],
  }),
  det({
    id: 'work_items.schedule.cascade_apply',
    title: 'Apply a schedule cascade',
    description:
      'Move a work item and every dependent item the preview showed. expectedMoves is the id ' +
      'list work_items.schedule.cascade_preview returned (at most 2000); a plan that changed ' +
      'since is refused. Cross-project moves need project.manage on each project.',
    input: bodyArgs(['workItemId'], {
      startAt: f.iso().nullable(),
      dueAt: f.iso().nullable(),
      expectedMoves: z.array(z.string().max(64)).max(2000),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Apply',
        args: {
          workItemId: 'wi_1',
          startAt: '2026-12-07',
          dueAt: '2026-12-11',
          expectedMoves: ['wi_2', 'wi_3'],
        },
      },
    ],
  }),
  det({
    id: 'projects.work_key_prefix.set',
    title: 'Set a project’s work-key prefix',
    description:
      'Set the prefix of a project’s work keys (e.g. WEB for WEB-12): a letter then 1–9 letters ' +
      'or digits, upper-cased. Returns how many items were keyed.',
    input: bodyArgs(['projectId'], {
      prefix: z.string().regex(/^\s*[A-Za-z][A-Za-z0-9]{1,9}\s*$/u, 'e.g. WEB'),
    }),
    redact: 'standard',
    examples: [{ summary: 'WEB', args: { projectId: 'pr_1', prefix: 'WEB' } }],
  }),
  det({
    id: 'work_items.code_links.list',
    title: 'List a work item’s code links',
    description:
      'The work item’s key and the commits, branches and pull requests linked to it from GitHub.',
    input: pathOnly('workItemId'),
    redact: 'standard',
    examples: [{ summary: 'Links', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.code_links.delete',
    title: 'Remove a code link',
    description: 'Unlink one commit, branch or pull request (id from work_items.code_links.list).',
    input: pathOnly('workItemId', 'linkId'),
    redact: 'standard',
    examples: [{ summary: 'Unlink', args: { workItemId: 'wi_1', linkId: 'cl_1' } }],
  }),
  det({
    id: 'projects.baselines.set_current',
    title: 'Make a baseline current',
    description:
      'Make one saved baseline (id from projects.baselines.list) the one variance is measured ' +
      'against. isCurrent must be true.',
    input: bodyArgs(['projectId', 'baselineId'], { isCurrent: z.literal(true) }),
    redact: 'standard',
    examples: [
      { summary: 'Activate', args: { projectId: 'pr_1', baselineId: 'bl_2', isCurrent: true } },
    ],
  }),
  det({
    id: 'projects.schedule.critical_path.get',
    title: 'Get a project’s critical path',
    description:
      'The project’s critical path: the chain of items that sets the end date, with float per ' +
      'item. Rate-limited.',
    input: pathOnly('projectId'),
    redact: 'standard',
    examples: [{ summary: 'Critical path', args: { projectId: 'pr_1' } }],
  }),
  det({
    id: 'projects.schedule.recompute',
    title: 'Recompute a project’s schedule',
    description: 'Recompute the project’s critical path now and return it.',
    input: pathOnly('projectId'),
    redact: 'standard',
    examples: [{ summary: 'Recompute', args: { projectId: 'pr_1' } }],
  }),
  // Client timeline.
  det({
    id: 'projects.milestones.publish',
    title: 'Publish a milestone to the client',
    description:
      'Show one milestone (id from projects.milestones.list) on the client’s portal timeline; ' +
      'only the allowlisted fields are copied. The client sees it.',
    input: pathOnly('projectId', 'id'),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Publish', args: { projectId: 'pr_1', id: 'ms_1' } }],
  }),
  det({
    id: 'projects.milestones.unpublish',
    title: 'Remove a milestone from the client timeline',
    description: 'Take a published milestone off the client’s portal timeline (deletes the copy).',
    input: pathOnly('projectId', 'id'),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Unpublish', args: { projectId: 'pr_1', id: 'ms_1' } }],
  }),
  det({
    id: 'projects.phases.dates.set',
    title: 'Set a phase’s dates and colour',
    description:
      'Set a timeline phase’s startsOn and endsOn (YYYY-MM-DD or null, end on or after start) ' +
      'and colorToken (a design-token name or null). Phase ids from projects.phases.list. Feeds ' +
      'the client timeline.',
    input: bodyArgs(['projectId', 'phaseId'], {
      startsOn: day().nullish(),
      endsOn: day().nullish(),
      colorToken: z
        .string()
        .regex(/^[a-z][a-z0-9.-]{0,31}$/u, 'a design-token name')
        .nullish(),
    }),
    redact: 'standard',
    notifies: true,
    examples: [
      {
        summary: 'Discovery',
        args: { projectId: 'pr_1', phaseId: 'ph_1', startsOn: '2026-12-01', endsOn: '2026-12-19' },
      },
    ],
  }),
  // Imports.
  det({
    id: 'imports.undo',
    title: 'Undo an import',
    description:
      'Within 7 days of the commit, remove what one import created (documents and work items ' +
      'soft-deleted, phases removed). Job ids: imports.list. 409 when already undone, too ' +
      'late or unsupported.',
    input: pathOnly('jobId'),
    redact: 'standard',
    examples: [{ summary: 'Undo', args: { jobId: 'job_1' } }],
  }),
  det({
    id: 'imports.pm.discover',
    title: 'Read Trello or Asana boards for import',
    description:
      'With the token already connected (source trello or asana), read 1–10 boards and return ' +
      'their lists or sections, people and a suggested mapping. Writes nothing.',
    input: bodyArgs([], { source: z.enum(PM_SOURCES), boardIds: pmBoardIds() }),
    redact: 'standard',
    examples: [
      {
        summary: 'Trello board',
        args: { source: 'trello', boardIds: ['5f1a2b3c4d5e6f7a8b9c0d1e'] },
      },
    ],
  }),
  det({
    id: 'imports.pm.preview',
    title: 'Preview a Trello or Asana import',
    description:
      'Counts of what the import would create in projectId (cards already imported included). ' +
      'statusMap maps a list / section name to backlog, ready, in_progress, internal_review or ' +
      'done; userMap maps a person key to a user id or null. Writes nothing.',
    input: bodyArgs([], pmOptions),
    redact: 'standard',
    examples: [
      {
        summary: 'Asana project',
        args: {
          source: 'asana',
          projectId: '0193a1b2-0000-7000-8000-000000000010',
          boardIds: ['1209876543210'],
          statusMap: { Doing: 'in_progress' },
        },
      },
    ],
  }),
  det({
    id: 'imports.pm.jobs.create',
    title: 'Start a Trello or Asana import',
    description:
      'Start the background import with the same inputs as imports.pm.preview; the token is ' +
      'deleted when the job ends. Follow it with imports.pm.jobs.get.',
    input: bodyArgs([], pmOptions),
    redact: 'standard',
    examples: [
      {
        summary: 'Trello',
        args: {
          source: 'trello',
          projectId: '0193a1b2-0000-7000-8000-000000000010',
          boardIds: ['5f1a2b3c4d5e6f7a8b9c0d1e'],
        },
      },
    ],
  }),
  det({
    id: 'imports.pm.connection.delete',
    title: 'Forget the Trello or Asana token',
    description: 'Delete the stored Trello or Asana token now (source trello or asana).',
    input: bodyArgs([], { source: z.enum(PM_SOURCES) }),
    redact: 'standard',
    examples: [{ summary: 'Asana', args: { source: 'asana' } }],
  }),
  det({
    id: 'imports.pm.jobs.get',
    title: 'Check a Trello or Asana import',
    description:
      'The state of one import job (running, committed, committed_with_errors or failed) with ' +
      'its counts. jobId from imports.pm.jobs.create.',
    input: bodyArgs(['jobId'], { source: z.enum(PM_SOURCES) }),
    redact: 'standard',
    examples: [{ summary: 'Job', args: { source: 'trello', jobId: 'job_1' } }],
  }),

  // ---- details for existing ops (k: D) ----
  det({
    id: 'glossary.terms.create',
    title: 'Add a glossary term',
    description:
      `Add a term (1–${MAX_TERM_LENGTH}) and its definition (1–${MAX_DEFINITION_LENGTH}) to the ` +
      'workspace glossary. A term that exists (any case) is a 409.',
    input: bodyArgs([], {
      term: f.shortText(MAX_TERM_LENGTH),
      definition: f.text(MAX_DEFINITION_LENGTH),
    }),
    redact: 'standard',
    examples: [
      { summary: 'Term', args: { term: 'Retainer', definition: 'A monthly prepaid service.' } },
    ],
  }),
  det({
    id: 'glossary.terms.delete',
    title: 'Remove a glossary term',
    description: 'Remove one glossary term (ids: glossary.terms.list).',
    input: pathOnly('id'),
    redact: 'standard',
    examples: [{ summary: 'Remove', args: { id: 'gt_1' } }],
  }),
  det({
    id: 'glossary.terms.update',
    title: 'Edit a glossary term',
    description:
      'Change a term and/or its definition (id from glossary.terms.list). Send at least one.',
    input: bodyArgs(['id'], {
      term: f.shortText(MAX_TERM_LENGTH).optional(),
      definition: f.text(MAX_DEFINITION_LENGTH).optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'Definition', args: { id: 'gt_1', definition: 'Updated meaning.' } }],
  }),
  det({
    id: 'milestones.phase.set',
    title: 'Put a milestone in a phase',
    description:
      'Assign a milestone (projects.milestones.list) to a timeline phase (projects.phases.list).',
    input: pathOnly('milestoneId', 'phaseId'),
    redact: 'standard',
    examples: [{ summary: 'Assign', args: { milestoneId: 'ms_1', phaseId: 'ph_1' } }],
  }),
  det({
    id: 'objectives.create',
    title: 'Create an objective',
    description:
      'Add a workspace objective: name (1–300), optional description (at most 20 000), target ' +
      '(at most 300) and status open, met or missed (default open).',
    input: bodyArgs([], {
      name: f.shortText(300),
      description: z.string().max(20_000).optional(),
      target: z.string().max(300).optional(),
      status: z.enum(ORG_OBJECTIVE_STATUSES).optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'Q1', args: { name: 'Grow retainers', target: '10 retainers' } }],
  }),
  det({
    id: 'objectives.update',
    title: 'Close an objective',
    description:
      'Mark an open objective (objectives.list) met or missed. An objective is never reopened.',
    input: bodyArgs(['objectiveId'], { status: z.enum(['met', 'missed']) }),
    redact: 'standard',
    examples: [{ summary: 'Met', args: { objectiveId: 'ob_1', status: 'met' } }],
  }),
  det({
    id: 'objectives.key_results.create',
    title: 'Add a key result',
    description:
      'Add a measurable key result to an objective: title (1–300), unit (1–64), targetValue and ' +
      'optional currentValue (whole numbers, 0 or more; current defaults to 0).',
    input: bodyArgs(['objectiveId'], {
      title: f.shortText(300),
      unit: f.shortText(64),
      targetValue: safeCount(),
      currentValue: safeCount().optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Retainers',
        args: { objectiveId: 'ob_1', title: 'Signed retainers', unit: 'clients', targetValue: 10 },
      },
    ],
  }),
  det({
    id: 'objectives.key_results.update',
    title: 'Update a key result',
    description:
      'Change a key result’s title, unit, targetValue or currentValue (ids from ' +
      'objectives.key_results.list). Send at least one.',
    input: bodyArgs(['objectiveId', 'keyResultId'], {
      title: f.shortText(300).optional(),
      unit: f.shortText(64).optional(),
      targetValue: safeCount().optional(),
      currentValue: safeCount().optional(),
    }),
    redact: 'standard',
    examples: [
      { summary: 'Progress', args: { objectiveId: 'ob_1', keyResultId: 'kr_1', currentValue: 4 } },
    ],
  }),
  det({
    id: 'objectives.work_links.create',
    title: 'Link a work item to an objective',
    description: 'Link a work item (work_items.list) to an objective so its progress counts.',
    input: bodyArgs(['objectiveId'], { workItemId: f.id() }),
    redact: 'standard',
    examples: [{ summary: 'Link', args: { objectiveId: 'ob_1', workItemId: 'wi_1' } }],
  }),
  det({
    id: 'objectives.work_links.delete',
    title: 'Unlink a work item from an objective',
    description: 'Remove one objective–work item link (id from objectives.work_links.list).',
    input: pathOnly('objectiveId', 'linkId'),
    redact: 'standard',
    examples: [{ summary: 'Unlink', args: { objectiveId: 'ob_1', linkId: 'owl_1' } }],
  }),
  det({
    id: 'phases.delete',
    title: 'Delete a timeline phase',
    description:
      'Remove a phase definition (ids: projects.phases.list); its milestones lose the phase.',
    input: pathOnly('phaseId'),
    redact: 'standard',
    examples: [{ summary: 'Delete', args: { phaseId: 'ph_1' } }],
  }),
];
