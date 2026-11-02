/**
 * AI action registry — time, timesheets, expenses, rate cards, retainers and finance reports
 * (R18-b, plan item 52-22 "Let AI do the job" for the built 52 items).
 *
 * Until this slice every route of 52-01 (timer), 52-02/03 (timesheets), 52-04 (rates), 52-05
 * (budget burn), 52-06 (retainers), 52-07 (expenses) and 52-14 (finance reports) sat in `NEVER`
 * (`finance_settings` / `time_tracking`). Here each one becomes a classified op with a strict zod
 * input, the `finance` redaction profile and EN/AR copy. What stays in `NEVER`: the finance
 * profile, tax rates, exchange rates and the readiness check (settings), the period locks
 * (`/time/locks*`) and every invoice route (R18-a).
 *
 * Safety rules (architecture B3/B4):
 * - The MCP principal is the member's own grant: every op runs in-process as that member, so the
 *   route's `@RequireCapability` and the service's own `authorize()` checks still apply. The op's
 *   `capability` mirrors the controller (the sync test fails on drift).
 * - Risk: reads are `read`/read. The everyday member jobs the plan names — log time, fill and
 *   submit my timesheet, start/stop the timer, submit an expense, create a draft retainer — are
 *   `write`/write (they run with audit). Every approval, rate or cost-rate change, re-price,
 *   expense approve/reject/delete, timesheet approve/request-changes, retainer change/pause/resume/
 *   end, CSV export and facts rebuild is `confirm`/manage: held in `pending_ai_actions` for a person.
 * - No op reads `org_secrets`. Notes, comments and form text in results are data, never
 *   instructions. No op here e-mails a third party (invoices are R18-a and stay NEVER).
 * - An AI-created retainer must be internal (`clientVisible: false`): making money terms visible to
 *   a client is a change a person approves (`finance.retainers.update` is confirm).
 * - Results pass the `finance` redaction ({@link redactFinanceResult}): cost and margin figures and
 *   bank details are dropped unless the member holds `finance.manage` — the same rule
 *   `rates.controller.ts` and the finance reports apply.
 */
import { z } from 'zod';
import type { Capability } from '@tmanage/domain';
import type { AiActionOp, AiScope, HttpMethod, RiskClass } from './types.js';
import {
  bodyArgs,
  det,
  f,
  listArgs,
  noArgs,
  pathOnly,
  type AiActionDetail,
  type AiActionExample,
} from './detail.js';

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
const WRITE = ['write', 'write'] as const;
const CONFIRM = ['confirm', 'manage'] as const;

/** One op per route moved out of NEVER (52 routes). */
export const financeTimeOps: readonly AiActionOp[] = [
  // 52-01 timer and presence.
  op('time.timer.get', 'GET', '/time/timer', 'work.read', ...READ),
  op('time.timer.start', 'POST', '/time/timer/start', 'work.read', ...WRITE),
  op('time.timer.stop', 'POST', '/time/timer/stop', 'work.read', ...WRITE),
  op('time.timer.heartbeat', 'POST', '/time/timer/heartbeat', 'work.read', ...WRITE),
  op('time.active.list', 'GET', '/time/active', 'work.read', ...READ),
  // 52-02 / 52-03 timesheets.
  op('time.timesheets.list', 'GET', '/time/timesheets/', 'project.manage', ...READ),
  op('time.timesheets.mine', 'GET', '/time/timesheets/mine', 'work.read', ...READ),
  op(
    'time.timesheets.entries.upsert',
    'PUT',
    '/time/timesheets/:timesheetId/entries',
    'work.read',
    ...WRITE,
  ),
  op(
    'time.timesheets.entries.move',
    'POST',
    '/time/timesheets/:timesheetId/entries/move',
    'work.read',
    ...WRITE,
  ),
  op(
    'time.timesheets.submit',
    'POST',
    '/time/timesheets/:timesheetId/submit',
    'work.read',
    ...WRITE,
  ),
  op(
    'time.timesheets.approve',
    'POST',
    '/time/timesheets/:timesheetId/approve',
    'project.manage',
    ...CONFIRM,
  ),
  op(
    'time.timesheets.request_changes',
    'POST',
    '/time/timesheets/:timesheetId/request-changes',
    'project.manage',
    ...CONFIRM,
  ),
  op(
    'time.timesheets.copy_from',
    'POST',
    '/time/timesheets/:timesheetId/copy-from',
    'work.read',
    ...WRITE,
  ),
  op(
    'time.timesheets.export',
    'GET',
    '/time/timesheets/:timesheetId/export.csv',
    'project.manage',
    ...CONFIRM,
  ),
  // 52-04 rate cards, the resolver, re-price and cost rates.
  op('finance.rate_cards.list', 'GET', '/finance/rate-cards', 'finance.view', ...READ),
  op('finance.rate_cards.create', 'POST', '/finance/rate-cards', 'finance.manage', ...CONFIRM),
  op(
    'finance.rate_cards.assign',
    'PUT',
    '/finance/rate-cards/assign',
    'finance.manage',
    ...CONFIRM,
  ),
  op(
    'finance.rate_cards.update',
    'PUT',
    '/finance/rate-cards/:rateCardId',
    'finance.manage',
    ...CONFIRM,
  ),
  op(
    'finance.rate_cards.entries.list',
    'GET',
    '/finance/rate-cards/:rateCardId/entries',
    'finance.view',
    ...READ,
  ),
  op(
    'finance.rate_cards.entries.create',
    'POST',
    '/finance/rate-cards/:rateCardId/entries',
    'finance.manage',
    ...CONFIRM,
  ),
  op(
    'finance.rate_cards.entries.delete',
    'DELETE',
    '/finance/rate-cards/:rateCardId/entries/:entryId',
    'finance.manage',
    ...CONFIRM,
  ),
  op('finance.rates.resolve', 'GET', '/finance/rates/resolve', 'finance.view', ...READ),
  op('finance.rates.reprice', 'POST', '/finance/rates/reprice', 'finance.manage', ...CONFIRM),
  op(
    'finance.cost_rates.get',
    'GET',
    '/finance/cost-rates/:membershipId',
    'finance.manage',
    ...READ,
  ),
  op(
    'finance.cost_rates.set',
    'PUT',
    '/finance/cost-rates/:membershipId',
    'finance.manage',
    ...CONFIRM,
  ),
  // 52-07 expenses.
  op('finance.expenses.create', 'POST', '/expenses/', 'work.read', ...WRITE),
  op('finance.expenses.list', 'GET', '/expenses/', 'work.read', ...READ),
  op('finance.expenses.export', 'GET', '/expenses/export.csv', 'finance.manage', ...CONFIRM),
  op('finance.expenses.get', 'GET', '/expenses/:expenseId', 'work.read', ...READ),
  op('finance.expenses.update', 'PUT', '/expenses/:expenseId', 'work.read', ...WRITE),
  op('finance.expenses.delete', 'DELETE', '/expenses/:expenseId', 'work.read', ...CONFIRM),
  op('finance.expenses.submit', 'POST', '/expenses/:expenseId/submit', 'work.read', ...WRITE),
  op(
    'finance.expenses.approve',
    'POST',
    '/expenses/:expenseId/approve',
    'project.manage',
    ...CONFIRM,
  ),
  op(
    'finance.expenses.reject',
    'POST',
    '/expenses/:expenseId/reject',
    'project.manage',
    ...CONFIRM,
  ),
  // 52-05 budget burn and the client's own budget projection.
  op('finance.budget.burn', 'GET', '/projects/:projectId/budget/burn', 'work.read', ...READ),
  op(
    'portal.projects.budget.get',
    'GET',
    '/portal/projects/:projectId/budget',
    'client_projection.read',
    ...READ,
  ),
  // 52-14 finance reports.
  op(
    'insights.finance.profitability',
    'GET',
    '/insights/finance/profitability',
    'finance.view',
    ...READ,
  ),
  op('insights.finance.unbilled', 'GET', '/insights/finance/unbilled', 'finance.view', ...READ),
  op(
    'insights.finance.utilisation',
    'GET',
    '/insights/finance/utilisation',
    'finance.view',
    ...READ,
  ),
  op('insights.finance.export', 'GET', '/insights/finance/export.csv', 'report.export', ...CONFIRM),
  op(
    'insights.finance.facts.rebuild',
    'POST',
    '/insights/finance/facts/rebuild',
    'finance.manage',
    ...CONFIRM,
  ),
  // 52-06 retainers.
  op(
    'finance.retainers.list',
    'GET',
    '/client-organizations/:clientOrganizationId/retainers',
    'work.read',
    ...READ,
  ),
  op(
    'finance.retainers.create',
    'POST',
    '/client-organizations/:clientOrganizationId/retainers',
    'finance.manage',
    ...WRITE,
  ),
  op('finance.retainers.get', 'GET', '/retainers/:retainerId', 'work.read', ...READ),
  op('finance.retainers.update', 'PUT', '/retainers/:retainerId', 'finance.manage', ...CONFIRM),
  op(
    'finance.retainers.pause',
    'POST',
    '/retainers/:retainerId/pause',
    'finance.manage',
    ...CONFIRM,
  ),
  op(
    'finance.retainers.resume',
    'POST',
    '/retainers/:retainerId/resume',
    'finance.manage',
    ...CONFIRM,
  ),
  op('finance.retainers.end', 'POST', '/retainers/:retainerId/end', 'finance.manage', ...CONFIRM),
  op(
    'finance.retainers.periods.list',
    'GET',
    '/retainers/:retainerId/periods',
    'work.read',
    ...READ,
  ),
  op(
    'finance.retainers.periods.entries.list',
    'GET',
    '/retainers/:retainerId/periods/:periodId/entries',
    'work.read',
    ...READ,
  ),
  op('portal.retainers.list', 'GET', '/portal/retainers/', 'client_projection.read', ...READ),
  op(
    'portal.retainers.get',
    'GET',
    '/portal/retainers/:retainerId',
    'client_projection.read',
    ...READ,
  ),
];

/**
 * The non-read ops that run at once (risk `write`): the member's own everyday jobs the plan names.
 * Every other POST/PUT/DELETE op of this file is `confirm` (the slice test enforces it).
 */
export const FINANCE_TIME_WRITE_ALLOWLIST: readonly string[] = [
  'time.timer.start',
  'time.timer.stop',
  'time.timer.heartbeat',
  'time.timesheets.entries.upsert',
  'time.timesheets.entries.move',
  'time.timesheets.submit',
  'time.timesheets.copy_from',
  'finance.expenses.create',
  'finance.expenses.update',
  'finance.expenses.submit',
  'finance.retainers.create',
];

// ---- input building blocks ----

const day = (): z.ZodString => z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'a date YYYY-MM-DD');
const week = (): z.ZodString => z.string().regex(/^\d{4}-W\d{2}$/u, 'an ISO week like 2026-W44');
const month = (): z.ZodString => z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u, 'a month YYYY-MM');
const minutes = (): z.ZodNumber => f.int(1, 1440);
const currency = (): z.ZodString => z.string().regex(/^[A-Z]{3}$/u, 'an ISO currency code');
const minor = (min = 0): z.ZodNumber => f.int(min, 1_000_000_000_000);
const note = (): z.ZodString => f.text(500);

const EXPENSE_CATEGORIES = ['Ads', 'Software', 'Travel', 'Print', 'Freelancer', 'Other'] as const;
const EXPENSE_STATES = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'invoiced',
  'locked',
] as const;

const expenseFields = {
  projectId: f.id().nullable().optional(),
  spentOn: day(),
  category: z.enum(EXPENSE_CATEGORIES),
  amountMinor: minor(1),
  currency: currency(),
  billable: f.bool().nullable().optional(),
  markupBp: f.int(0, 100_000).optional(),
  taxBp: f.int(0, 10_000).optional(),
  note: note().nullable().optional(),
  receiptFileAssetId: f.id().nullable().optional(),
};

const expenseFilters = {
  period: month().optional(),
  state: z.enum(EXPENSE_STATES).optional(),
  projectId: f.id().optional(),
  billable: z.enum(['true', 'false']).optional(),
};

const entryLine = z
  .object({
    id: f.id().optional(),
    workItemId: f.id().nullable().optional(),
    projectId: f.id().nullable().optional(),
    spentOn: day(),
    minutes: minutes(),
    billable: f.bool().optional(),
    note: note().nullable().optional(),
  })
  .strict();

const retainerFields = {
  name: f.shortText(120),
  period: z.enum(['monthly', 'quarterly']).optional(),
  hoursPerPeriod: f.int(1, 10_000).nullable().optional(),
  amountPerPeriodMinor: minor(1).nullable().optional(),
  rollover: z.enum(['none', 'cap', 'unlimited']).optional(),
  rolloverCapMinutes: f.int(0, 600_000).nullable().optional(),
  billingTiming: z.enum(['advance', 'arrears']).optional(),
  startsOn: day(),
  endsOn: day().nullable().optional(),
  projects: z.array(f.id()).max(100).optional(),
};

const range = { from: day().optional(), to: day().optional() };

// ---- details ----

interface Copy {
  readonly title: string;
  readonly description: string;
  readonly descriptionAr: string;
  readonly input: z.ZodTypeAny;
  readonly examples: readonly AiActionExample[];
}

function detail(id: string, copy: Copy): AiActionDetail {
  return det({ id, redact: 'finance', notifies: false, ...copy });
}

const ex = (summary: string, args: Record<string, unknown> = {}): AiActionExample => ({
  summary,
  args,
});

export const financeTimeDetails: readonly AiActionDetail[] = [
  detail('time.timer.get', {
    title: 'Show my running timer',
    description: "The signed-in member's running timer, if any: the task, start time and minutes.",
    descriptionAr: 'المؤقّت الجاري للعضو الحالي إن وُجد: المهمة ووقت البدء والدقائق.',
    input: noArgs(),
    examples: [ex('Is my timer running?'), ex('How long have I been tracking?')],
  }),
  detail('time.timer.start', {
    title: 'Start my timer',
    description:
      'Start tracking time on a task or project for the signed-in member. `force` stops a timer ' +
      'already running first.',
    descriptionAr:
      'بدء تتبّع الوقت على مهمة أو مشروع للعضو الحالي. ‏`force` يوقف أي مؤقّت جارٍ أولاً.',
    input: bodyArgs([], {
      workItemId: f.id().optional(),
      projectId: f.id().optional(),
      note: note().optional(),
      billable: f.bool().optional(),
      force: f.bool().optional(),
    }),
    examples: [
      ex('Start my timer on the Acme homepage task', { workItemId: 'wi_acme_home' }),
      ex('Start a non-billable timer on the Ops project', {
        projectId: 'prj_ops',
        billable: false,
      }),
    ],
  }),
  detail('time.timer.stop', {
    title: 'Stop my timer',
    description: 'Stop the running timer and save it as a time entry, with an optional note.',
    descriptionAr: 'إيقاف المؤقّت الجاري وحفظه كقيد وقت، مع ملاحظة اختيارية.',
    input: bodyArgs([], { note: note().optional() }),
    examples: [
      ex('Stop my timer'),
      ex('Stop my timer, note: hero copy done', { note: 'Hero copy done' }),
    ],
  }),
  detail('time.timer.heartbeat', {
    title: 'Keep my timer alive',
    description: 'Tell TManage the running timer is still in use (prevents the idle stop).',
    descriptionAr: 'إبلاغ TManage بأن المؤقّت الجاري ما زال مستخدماً (يمنع الإيقاف التلقائي).',
    input: noArgs(),
    examples: [ex('Keep my timer running'), ex("I'm still working, keep the timer on")],
  }),
  detail('time.active.list', {
    title: 'Who is tracking now',
    description: 'Members with a running timer right now, optionally for one project.',
    descriptionAr: 'الأعضاء الذين لديهم مؤقّت جارٍ الآن، ويمكن حصرها بمشروع واحد.',
    input: bodyArgs([], { projectId: f.id().optional() }),
    examples: [
      ex('Who is tracking time right now?'),
      ex('Who is working on Project X now?', { projectId: 'prj_x' }),
    ],
  }),
  detail('time.timesheets.list', {
    title: 'List team timesheets',
    description: "Every member's timesheet for a week (managers), optionally one member.",
    descriptionAr: 'الجداول الزمنية لكل الأعضاء في أسبوع (للمديرين)، ويمكن حصرها بعضو واحد.',
    input: bodyArgs([], { week: week().optional(), membershipId: f.id().optional() }),
    examples: [
      ex('Whose timesheets are still missing this week?'),
      ex("Show Sara's timesheet for week 44", { week: '2026-W44', membershipId: 'mem_sara' }),
    ],
  }),
  detail('time.timesheets.mine', {
    title: 'Show my timesheet',
    description: "The signed-in member's timesheet for a week (default this week), with its id.",
    descriptionAr: 'الجدول الزمني للعضو الحالي لأسبوع (افتراضياً هذا الأسبوع) مع معرّفه.',
    input: bodyArgs([], { week: week().optional() }),
    examples: [
      ex('Show my timesheet this week'),
      ex('Show my timesheet for last week', { week: '2026-W44' }),
    ],
  }),
  detail('time.timesheets.entries.upsert', {
    title: 'Log time on my timesheet',
    description:
      'Add or change time entries on a timesheet (1..1440 minutes each, dates inside its week). ' +
      'Pass the `version` you read; one bad line refuses the whole batch.',
    descriptionAr:
      'إضافة قيود وقت أو تعديلها في جدول زمني (من 1 إلى 1440 دقيقة لكل قيد، والتواريخ داخل أسبوعه). ' +
      'مرّر `version` الذي قرأته؛ أي سطر خاطئ يرفض الدفعة كلها.',
    input: bodyArgs(['timesheetId'], {
      version: f.int(1, 1_000_000),
      entries: z.array(entryLine).min(1).max(200),
    }),
    examples: [
      ex('Log 2 hours on the Acme homepage task for yesterday', {
        timesheetId: 'ts_44',
        version: 3,
        entries: [{ workItemId: 'wi_acme_home', spentOn: '2026-11-01', minutes: 120 }],
      }),
      ex('Fill my timesheet with 30 minutes of standup each day', {
        timesheetId: 'ts_44',
        version: 3,
        entries: [
          { projectId: 'prj_ops', spentOn: '2026-10-26', minutes: 30, note: 'Standup' },
          { projectId: 'prj_ops', spentOn: '2026-10-27', minutes: 30, note: 'Standup' },
        ],
      }),
    ],
  }),
  detail('time.timesheets.entries.move', {
    title: 'Move time entries to another task',
    description: 'Re-file up to 200 entries of an editable timesheet onto another task.',
    descriptionAr: 'نقل حتى 200 قيد من جدول زمني قابل للتعديل إلى مهمة أخرى.',
    input: bodyArgs(['timesheetId'], {
      entryIds: z.array(f.id()).min(1).max(200),
      workItemId: f.id(),
    }),
    examples: [
      ex('Move these two entries to the Acme logo task', {
        timesheetId: 'ts_44',
        entryIds: ['te_1', 'te_2'],
        workItemId: 'wi_acme_logo',
      }),
      ex('That entry was on the wrong task, move it', {
        timesheetId: 'ts_44',
        entryIds: ['te_9'],
        workItemId: 'wi_fix',
      }),
    ],
  }),
  detail('time.timesheets.submit', {
    title: 'Submit my timesheet',
    description: 'Submit a timesheet for approval. It is then read-only until a manager decides.',
    descriptionAr: 'إرسال جدول زمني للاعتماد. يصبح للقراءة فقط حتى يقرّر المدير.',
    input: pathOnly('timesheetId'),
    examples: [
      ex('Submit my timesheet', { timesheetId: 'ts_44' }),
      ex("I'm done for the week, submit it", { timesheetId: 'ts_44' }),
    ],
  }),
  detail('time.timesheets.approve', {
    title: 'Approve a timesheet',
    description: 'Approve a submitted timesheet. Needs your approval in TManage before it runs.',
    descriptionAr: 'اعتماد جدول زمني مُرسل. يحتاج موافقتك في TManage قبل التنفيذ.',
    input: pathOnly('timesheetId'),
    examples: [
      ex("Approve Sara's timesheet", { timesheetId: 'ts_sara_44' }),
      ex('Approve the design team timesheet for week 44', { timesheetId: 'ts_design_44' }),
    ],
  }),
  detail('time.timesheets.request_changes', {
    title: 'Send a timesheet back',
    description:
      'Return a submitted timesheet to its member with a note (3..500 characters). Needs approval.',
    descriptionAr: 'إعادة جدول زمني مُرسل إلى صاحبه مع ملاحظة (3 إلى 500 حرف). يحتاج موافقة.',
    input: bodyArgs(['timesheetId'], { note: z.string().min(3).max(500) }),
    examples: [
      ex('Send it back: Friday is missing', { timesheetId: 'ts_44', note: 'Friday is missing' }),
      ex('Ask Omar to split the Acme hours by task', {
        timesheetId: 'ts_omar_44',
        note: 'Please split the Acme hours by task',
      }),
    ],
  }),
  detail('time.timesheets.copy_from', {
    title: 'Copy last week into my timesheet',
    description: "Copy another week's lines into this editable timesheet (`sourceWeek` 2026-W44).",
    descriptionAr:
      'نسخ سطور أسبوع آخر إلى هذا الجدول الزمني القابل للتعديل (`sourceWeek` مثل 2026-W44).',
    input: bodyArgs(['timesheetId'], { sourceWeek: week() }),
    examples: [
      ex('Fill my timesheet this week like last week', {
        timesheetId: 'ts_45',
        sourceWeek: '2026-W44',
      }),
      ex('Copy week 40 into this week', { timesheetId: 'ts_45', sourceWeek: '2026-W40' }),
    ],
  }),
  detail('time.timesheets.export', {
    title: 'Export a timesheet (CSV)',
    description: 'The CSV text of one timesheet (2 MB cap). Needs approval.',
    descriptionAr: 'نص CSV لجدول زمني واحد (حد 2 ميغابايت). يحتاج موافقة.',
    input: pathOnly('timesheetId'),
    examples: [
      ex("Export Sara's timesheet", { timesheetId: 'ts_sara_44' }),
      ex('Give me week 44 as CSV', { timesheetId: 'ts_44' }),
    ],
  }),
  detail('finance.rate_cards.list', {
    title: 'List rate cards',
    description: 'The organization, client and project rate cards (bill rates only).',
    descriptionAr: 'بطاقات الأسعار على مستوى المؤسسة والعميل والمشروع (أسعار الفوترة فقط).',
    input: noArgs(),
    examples: [ex('What rate cards do we have?'), ex('Which clients have their own rates?')],
  }),
  detail('finance.rate_cards.create', {
    title: 'Create a rate card',
    description: 'A new org, client or project rate card in one currency. Needs approval.',
    descriptionAr: 'بطاقة أسعار جديدة للمؤسسة أو عميل أو مشروع بعملة واحدة. تحتاج موافقة.',
    input: bodyArgs([], {
      scope: z.enum(['org', 'client', 'project']),
      scopeId: f.id().nullable().optional(),
      name: f.shortText(120),
      currency: currency(),
    }),
    examples: [
      ex('Create a 2027 rate card in USD', {
        scope: 'org',
        name: 'Standard 2027',
        currency: 'USD',
      }),
      ex('Give Acme its own EUR rates', {
        scope: 'client',
        scopeId: 'cli_acme',
        name: 'Acme rates',
        currency: 'EUR',
      }),
    ],
  }),
  detail('finance.rate_cards.assign', {
    title: 'Assign a rate card to a project',
    description:
      'Point a project at a rate card (or none) and its billable default. Needs approval.',
    descriptionAr:
      'ربط مشروع ببطاقة أسعار (أو إلغاء الربط) وتحديد الافتراضي للفوترة. يحتاج موافقة.',
    input: bodyArgs([], {
      projectId: f.id(),
      rateCardId: f.id().nullable(),
      billableDefault: f.bool().optional(),
    }),
    examples: [
      ex('Use the Acme rates on the homepage project', {
        projectId: 'prj_home',
        rateCardId: 'rc_acme',
      }),
      ex('Make Project X non-billable by default', {
        projectId: 'prj_x',
        rateCardId: null,
        billableDefault: false,
      }),
    ],
  }),
  detail('finance.rate_cards.update', {
    title: 'Rename or archive a rate card',
    description: 'Change a rate card name or archive it. Needs approval.',
    descriptionAr: 'تغيير اسم بطاقة أسعار أو أرشفتها. يحتاج موافقة.',
    input: bodyArgs(['rateCardId'], {
      name: f.shortText(120).optional(),
      archived: f.bool().optional(),
    }),
    examples: [
      ex('Archive the 2025 rate card', { rateCardId: 'rc_2025', archived: true }),
      ex('Rename it to Standard', { rateCardId: 'rc_1', name: 'Standard' }),
    ],
  }),
  detail('finance.rate_cards.entries.list', {
    title: 'Show rate card lines',
    description: 'The hourly bill rates on one rate card, with their effective dates.',
    descriptionAr: 'أسعار الساعة للفوترة في بطاقة أسعار واحدة مع تواريخ سريانها.',
    input: pathOnly('rateCardId'),
    examples: [
      ex('What do we charge for a designer?', { rateCardId: 'rc_std' }),
      ex('Show the Acme rate lines', { rateCardId: 'rc_acme' }),
    ],
  }),
  detail('finance.rate_cards.entries.create', {
    title: 'Add a rate',
    description:
      'Add an hourly bill rate (minor units) for a role, member, service or the default. Needs approval.',
    descriptionAr:
      'إضافة سعر ساعة للفوترة (بالوحدات الصغرى) لدور أو عضو أو خدمة أو الافتراضي. يحتاج موافقة.',
    input: bodyArgs(['rateCardId'], {
      targetType: z.enum(['default', 'role', 'membership', 'service']),
      targetKey: f.shortText(120).nullable().optional(),
      hourlyMinor: minor(0),
      effectiveFrom: day(),
      effectiveTo: day().nullable().optional(),
    }),
    examples: [
      ex('Designers are 95 an hour from January', {
        rateCardId: 'rc_std',
        targetType: 'role',
        targetKey: 'designer',
        hourlyMinor: 9500,
        effectiveFrom: '2027-01-01',
      }),
      ex('Default rate 80 an hour', {
        rateCardId: 'rc_std',
        targetType: 'default',
        hourlyMinor: 8000,
        effectiveFrom: '2026-11-01',
      }),
    ],
  }),
  detail('finance.rate_cards.entries.delete', {
    title: 'Remove a rate',
    description: 'Remove one rate line of a rate card. Needs approval.',
    descriptionAr: 'حذف سطر سعر من بطاقة أسعار. يحتاج موافقة.',
    input: pathOnly('rateCardId', 'entryId'),
    examples: [
      ex('Remove the old designer rate', { rateCardId: 'rc_std', entryId: 're_1' }),
      ex('Delete that rate line', { rateCardId: 'rc_acme', entryId: 're_7' }),
    ],
  }),
  detail('finance.rates.resolve', {
    title: 'Which rate applies',
    description:
      'The bill rate that applies to a member on a project on a date, and where it came from.',
    descriptionAr: 'سعر الفوترة المطبّق على عضو في مشروع بتاريخ معيّن ومصدره.',
    input: bodyArgs([], {
      projectId: f.id().optional(),
      membershipId: f.id().optional(),
      on: day().optional(),
    }),
    examples: [
      ex("What is Sara's rate on Acme?", { projectId: 'prj_acme', membershipId: 'mem_sara' }),
      ex('Which rate applied on 1 October?', { projectId: 'prj_x', on: '2026-10-01' }),
    ],
  }),
  detail('finance.rates.reprice', {
    title: 'Re-price time entries',
    description:
      "Re-apply today's rates to unbilled entries of a project (or 'all') up to a date. Needs approval.",
    descriptionAr:
      'إعادة تطبيق الأسعار الحالية على قيود غير مفوترة لمشروع (أو `all`) حتى تاريخ. يحتاج موافقة.',
    input: bodyArgs([], { projectId: f.id(36), until: day() }),
    examples: [
      ex('Re-price Project X with the new rates', { projectId: 'prj_x', until: '2026-10-31' }),
      ex('Re-price everything up to October', { projectId: 'all', until: '2026-10-31' }),
    ],
  }),
  detail('finance.cost_rates.get', {
    title: "Show a member's cost rate",
    description: "A member's internal hourly cost history (finance managers only).",
    descriptionAr: 'سجل التكلفة الداخلية بالساعة لعضو (لمديري المالية فقط).',
    input: pathOnly('membershipId'),
    examples: [
      ex('What does Omar cost per hour?', { membershipId: 'mem_omar' }),
      ex("Show Sara's cost rate history", { membershipId: 'mem_sara' }),
    ],
  }),
  detail('finance.cost_rates.set', {
    title: "Set a member's cost rate",
    description: "Record a member's internal hourly cost from a date. Needs approval.",
    descriptionAr: 'تسجيل التكلفة الداخلية بالساعة لعضو اعتباراً من تاريخ. يحتاج موافقة.',
    input: bodyArgs(['membershipId'], {
      hourlyCostMinor: minor(0),
      currency: currency(),
      effectiveFrom: day(),
      effectiveTo: day().nullable().optional(),
    }),
    examples: [
      ex("Omar's cost is 40 an hour from November", {
        membershipId: 'mem_omar',
        hourlyCostMinor: 4000,
        currency: 'USD',
        effectiveFrom: '2026-11-01',
      }),
      ex("Set Sara's cost to 3500 EGP", {
        membershipId: 'mem_sara',
        hourlyCostMinor: 350000,
        currency: 'EGP',
        effectiveFrom: '2026-11-01',
      }),
    ],
  }),
  detail('finance.expenses.create', {
    title: 'Submit an expense',
    description:
      'Record an expense (amount in minor units) and submit it, or keep it as a `draft`.',
    descriptionAr: 'تسجيل مصروف (المبلغ بالوحدات الصغرى) وإرساله، أو حفظه كمسودة `draft`.',
    input: bodyArgs([], { ...expenseFields, state: z.enum(['draft', 'submitted']).optional() }),
    examples: [
      ex('Submit a 49 USD software expense for Acme', {
        projectId: 'prj_acme',
        spentOn: '2026-11-01',
        category: 'Software',
        amountMinor: 4900,
        currency: 'USD',
        billable: true,
      }),
      ex('Draft a taxi expense for yesterday', {
        spentOn: '2026-11-01',
        category: 'Travel',
        amountMinor: 1250,
        currency: 'EUR',
        state: 'draft',
      }),
    ],
  }),
  detail('finance.expenses.list', {
    title: 'List expenses',
    description: 'Expenses I may see, filtered by month, state, project or billable.',
    descriptionAr:
      'المصروفات المسموح لي برؤيتها، مع تصفية بالشهر أو الحالة أو المشروع أو قابلية الفوترة.',
    input: listArgs([], expenseFilters),
    examples: [
      ex('Which expenses are waiting for approval?', { state: 'submitted' }),
      ex('Billable expenses on Acme in October', {
        period: '2026-10',
        projectId: 'prj_acme',
        billable: 'true',
      }),
    ],
  }),
  detail('finance.expenses.export', {
    title: 'Export expenses (CSV)',
    description: 'The CSV text of the filtered expenses (2 MB cap). Needs approval.',
    descriptionAr: 'نص CSV للمصروفات المصفّاة (حد 2 ميغابايت). يحتاج موافقة.',
    input: bodyArgs([], expenseFilters),
    examples: [
      ex('Export September expenses', { period: '2026-09' }),
      ex('Export approved expenses', { state: 'approved' }),
    ],
  }),
  detail('finance.expenses.get', {
    title: 'Show an expense',
    description: 'One expense with its state, amounts and history.',
    descriptionAr: 'مصروف واحد مع حالته ومبالغه وسجله.',
    input: pathOnly('expenseId'),
    examples: [
      ex('Show that expense', { expenseId: 'exp_1' }),
      ex('Why was my expense rejected?', { expenseId: 'exp_9' }),
    ],
  }),
  detail('finance.expenses.update', {
    title: 'Edit an expense',
    description: 'Change fields of a draft or rejected expense; only the named fields change.',
    descriptionAr: 'تعديل حقول مصروف في المسودة أو مرفوض؛ تتغيّر الحقول المذكورة فقط.',
    input: bodyArgs(['expenseId'], {
      ...Object.fromEntries(
        Object.entries(expenseFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()]),
      ),
    }),
    examples: [
      ex('Change the amount to 52 USD', { expenseId: 'exp_1', amountMinor: 5200 }),
      ex('Mark it non-billable', { expenseId: 'exp_1', billable: false }),
    ],
  }),
  detail('finance.expenses.delete', {
    title: 'Delete an expense',
    description: 'Delete a draft expense. Needs approval.',
    descriptionAr: 'حذف مصروف في المسودة. يحتاج موافقة.',
    input: pathOnly('expenseId'),
    examples: [
      ex('Delete that draft expense', { expenseId: 'exp_3' }),
      ex('Remove the duplicate taxi expense', { expenseId: 'exp_4' }),
    ],
  }),
  detail('finance.expenses.submit', {
    title: 'Submit a draft expense',
    description: 'Send a draft expense for approval.',
    descriptionAr: 'إرسال مصروف في المسودة للاعتماد.',
    input: pathOnly('expenseId'),
    examples: [
      ex('Submit my taxi expense', { expenseId: 'exp_3' }),
      ex('Send that expense for approval', { expenseId: 'exp_5' }),
    ],
  }),
  detail('finance.expenses.approve', {
    title: 'Approve an expense',
    description: 'Approve a submitted expense. Needs approval.',
    descriptionAr: 'اعتماد مصروف مُرسل. يحتاج موافقة.',
    input: pathOnly('expenseId'),
    examples: [
      ex("Approve Omar's software expense", { expenseId: 'exp_7' }),
      ex('Approve that expense', { expenseId: 'exp_8' }),
    ],
  }),
  detail('finance.expenses.reject', {
    title: 'Reject an expense',
    description: 'Reject a submitted expense with a note. Needs approval.',
    descriptionAr: 'رفض مصروف مُرسل مع ملاحظة. يحتاج موافقة.',
    input: bodyArgs(['expenseId'], { note: note() }),
    examples: [
      ex('Reject it: no receipt', { expenseId: 'exp_7', note: 'No receipt attached' }),
      ex('Reject the duplicate', { expenseId: 'exp_8', note: 'Duplicate of exp_7' }),
    ],
  }),
  detail('finance.budget.burn', {
    title: 'Show project budget burn',
    description:
      "A project's budget burn over a range: spent vs budget, grouped by phase, person or week.",
    descriptionAr:
      'استهلاك ميزانية مشروع خلال فترة: المصروف مقابل الميزانية، مجمّعاً حسب المرحلة أو الشخص أو الأسبوع.',
    input: bodyArgs(['projectId'], {
      ...range,
      groupBy: f.shortText(20).optional(),
      after: f.cursor,
      limit: f.limit,
    }),
    examples: [
      ex('What is the burn on Project X?', { projectId: 'prj_x' }),
      ex('Burn on Acme by person this quarter', {
        projectId: 'prj_acme',
        from: '2026-10-01',
        to: '2026-12-31',
        groupBy: 'person',
      }),
    ],
  }),
  detail('portal.projects.budget.get', {
    title: 'Show my project budget (client)',
    description: "A client's own view of a shared project's budget.",
    descriptionAr: 'عرض العميل لميزانية مشروع مشترك معه.',
    input: pathOnly('projectId'),
    examples: [
      ex('How much of our budget is used?', { projectId: 'prj_x' }),
      ex('Show the website budget', { projectId: 'prj_web' }),
    ],
  }),
  detail('insights.finance.profitability', {
    title: 'Profitability report',
    description:
      'Revenue against cost by project, client or person over a range. Cost and margin show only ' +
      'for finance managers.',
    descriptionAr:
      'الإيراد مقابل التكلفة حسب المشروع أو العميل أو الشخص خلال فترة. التكلفة والهامش تظهر لمديري المالية فقط.',
    input: bodyArgs([], { by: z.enum(['project', 'client', 'person']).optional(), ...range }),
    examples: [
      ex('Which clients are unprofitable this quarter?', {
        by: 'client',
        from: '2026-10-01',
        to: '2026-12-31',
      }),
      ex('Profit by project last month', { by: 'project', from: '2026-10-01', to: '2026-10-31' }),
    ],
  }),
  detail('insights.finance.unbilled', {
    title: 'Unbilled work report',
    description: 'Billable time and expenses not yet invoiced, by project or client.',
    descriptionAr: 'الوقت والمصروفات القابلة للفوترة التي لم تُفوتر بعد، حسب المشروع أو العميل.',
    input: bodyArgs([], { by: z.enum(['project', 'client']).optional(), ...range }),
    examples: [
      ex('What have we not billed yet?'),
      ex('Unbilled work by client in October', {
        by: 'client',
        from: '2026-10-01',
        to: '2026-10-31',
      }),
    ],
  }),
  detail('insights.finance.utilisation', {
    title: 'Utilisation report',
    description: 'Billable and total hours against capacity per member over a range.',
    descriptionAr: 'الساعات القابلة للفوترة والإجمالية مقابل الطاقة لكل عضو خلال فترة.',
    input: bodyArgs([], { ...range, after: f.cursor }),
    examples: [
      ex('Who is under-utilised this month?', { from: '2026-11-01', to: '2026-11-30' }),
      ex('Team utilisation last quarter', { from: '2026-07-01', to: '2026-09-30' }),
    ],
  }),
  detail('insights.finance.export', {
    title: 'Export a finance report (CSV)',
    description: 'The CSV text of a profitability, unbilled or utilisation report. Needs approval.',
    descriptionAr: 'نص CSV لتقرير الربحية أو غير المفوتر أو الاستغلال. يحتاج موافقة.',
    input: bodyArgs([], {
      report: z.enum(['profitability', 'unbilled', 'utilisation']),
      by: z.enum(['project', 'client', 'person']).optional(),
      ...range,
    }),
    examples: [
      ex('Export September profitability by client', {
        report: 'profitability',
        by: 'client',
        from: '2026-09-01',
        to: '2026-09-30',
      }),
      ex('Export the unbilled report', { report: 'unbilled' }),
    ],
  }),
  detail('insights.finance.facts.rebuild', {
    title: 'Rebuild finance figures',
    description: 'Recompute the finance report facts now (rate-limited). Needs approval.',
    descriptionAr: 'إعادة حساب بيانات التقارير المالية الآن (بحد للمعدّل). يحتاج موافقة.',
    input: noArgs(),
    examples: [ex('Refresh the finance reports'), ex('Rebuild the profitability numbers')],
  }),
  detail('finance.retainers.list', {
    title: "List a client's retainers",
    description: 'The retainers of one client organization with their current period usage.',
    descriptionAr: 'عقود الاحتفاظ لعميل واحد مع استهلاك الفترة الحالية.',
    input: pathOnly('clientOrganizationId'),
    examples: [
      ex("Show Acme's retainers", { clientOrganizationId: 'co_acme' }),
      ex('How much retainer is left for Globex?', { clientOrganizationId: 'co_globex' }),
    ],
  }),
  detail('finance.retainers.create', {
    title: 'Create a draft retainer',
    description:
      'Create an internal (not client-visible) retainer for a client. Showing it to the client ' +
      'is a separate, approved change.',
    descriptionAr:
      'إنشاء عقد احتفاظ داخلي (غير مرئي للعميل). إظهاره للعميل تغيير منفصل يحتاج موافقة.',
    input: bodyArgs(['clientOrganizationId'], {
      ...retainerFields,
      clientVisible: z.literal(false),
    }),
    examples: [
      ex('Create a 20-hour monthly retainer for Acme', {
        clientOrganizationId: 'co_acme',
        name: 'Acme support',
        hoursPerPeriod: 20,
        startsOn: '2026-12-01',
        clientVisible: false,
      }),
      ex('Draft a quarterly 6000 USD retainer for Globex', {
        clientOrganizationId: 'co_globex',
        name: 'Globex care',
        period: 'quarterly',
        amountPerPeriodMinor: 600000,
        startsOn: '2027-01-01',
        clientVisible: false,
      }),
    ],
  }),
  detail('finance.retainers.get', {
    title: 'Show a retainer',
    description: 'One retainer with its terms, state and current period.',
    descriptionAr: 'عقد احتفاظ واحد مع شروطه وحالته وفترته الحالية.',
    input: pathOnly('retainerId'),
    examples: [
      ex('Show the Acme support retainer', { retainerId: 'ret_1' }),
      ex('Is that retainer paused?', { retainerId: 'ret_2' }),
    ],
  }),
  detail('finance.retainers.update', {
    title: 'Change a retainer',
    description: 'Change retainer terms or client visibility. Needs approval.',
    descriptionAr: 'تغيير شروط عقد احتفاظ أو ظهوره للعميل. يحتاج موافقة.',
    input: bodyArgs(['retainerId'], {
      ...Object.fromEntries(
        Object.entries(retainerFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()]),
      ),
      clientVisible: f.bool().optional(),
    }),
    examples: [
      ex('Raise the Acme retainer to 30 hours', { retainerId: 'ret_1', hoursPerPeriod: 30 }),
      ex('Show the retainer to the client', { retainerId: 'ret_1', clientVisible: true }),
    ],
  }),
  detail('finance.retainers.pause', {
    title: 'Pause a retainer',
    description: 'Pause an active retainer. Needs approval.',
    descriptionAr: 'إيقاف عقد احتفاظ نشط مؤقتاً. يحتاج موافقة.',
    input: pathOnly('retainerId'),
    examples: [
      ex('Pause the Acme retainer', { retainerId: 'ret_1' }),
      ex('Hold Globex for now', { retainerId: 'ret_2' }),
    ],
  }),
  detail('finance.retainers.resume', {
    title: 'Resume a retainer',
    description: 'Resume a paused retainer. Needs approval.',
    descriptionAr: 'استئناف عقد احتفاظ متوقف. يحتاج موافقة.',
    input: pathOnly('retainerId'),
    examples: [
      ex('Resume the Acme retainer', { retainerId: 'ret_1' }),
      ex('Start Globex again', { retainerId: 'ret_2' }),
    ],
  }),
  detail('finance.retainers.end', {
    title: 'End a retainer',
    description: 'End a retainer for good. Needs approval.',
    descriptionAr: 'إنهاء عقد احتفاظ نهائياً. يحتاج موافقة.',
    input: pathOnly('retainerId'),
    examples: [
      ex('End the Acme retainer', { retainerId: 'ret_1' }),
      ex('Globex cancelled, end it', { retainerId: 'ret_2' }),
    ],
  }),
  detail('finance.retainers.periods.list', {
    title: 'Retainer periods',
    description: "A retainer's periods with hours used, rolled over and left.",
    descriptionAr: 'فترات عقد الاحتفاظ مع الساعات المستخدمة والمرحّلة والمتبقية.',
    input: pathOnly('retainerId'),
    examples: [
      ex('How many retainer hours did Acme use each month?', { retainerId: 'ret_1' }),
      ex('Show the Globex retainer periods', { retainerId: 'ret_2' }),
    ],
  }),
  detail('finance.retainers.periods.entries.list', {
    title: 'Time on a retainer period',
    description: 'The time entries counted against one retainer period.',
    descriptionAr: 'قيود الوقت المحتسبة على فترة واحدة من عقد الاحتفاظ.',
    input: listArgs(['retainerId', 'periodId']),
    examples: [
      ex('What did we spend the October Acme hours on?', {
        retainerId: 'ret_1',
        periodId: 'rp_10',
      }),
      ex('List the entries of that period', { retainerId: 'ret_2', periodId: 'rp_3' }),
    ],
  }),
  detail('portal.retainers.list', {
    title: 'My retainers (client)',
    description: "A client's own retainers that the agency made visible.",
    descriptionAr: 'عقود الاحتفاظ الخاصة بالعميل التي أظهرتها الوكالة.',
    input: noArgs(),
    examples: [ex('What retainers do we have?'), ex('How many hours are left this month?')],
  }),
  detail('portal.retainers.get', {
    title: 'Show my retainer (client)',
    description: "A client's own view of one retainer and its usage.",
    descriptionAr: 'عرض العميل لعقد احتفاظ واحد واستهلاكه.',
    input: pathOnly('retainerId'),
    examples: [
      ex('Show our support retainer', { retainerId: 'ret_1' }),
      ex('How much of the retainer is used?', { retainerId: 'ret_1' }),
    ],
  }),
];

// ---- the `finance` redaction profile ----

/** Keys withheld from a member without `finance.manage` (the 52-04 / 52-14 cost rule). */
const FINANCE_SECRET_KEY = /cost|margin|bank_?details/iu;

/**
 * The `finance` redaction (architecture B4/T-RED): drop every key naming a cost, a margin or bank
 * details — `costSnapshotMinor`, `costMinor`, `marginBp`, cost-rate values, `bank_details_text` —
 * at any depth, unless the member holds `finance.manage`. Pure; returns a new value.
 */
export function redactFinanceResult(value: unknown, canSeeCost: boolean): unknown {
  if (canSeeCost) return value;
  if (Array.isArray(value)) return value.map((v) => redactFinanceResult(v, false));
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (FINANCE_SECRET_KEY.test(key)) continue;
    out[key] = redactFinanceResult(v, false);
  }
  return out;
}
