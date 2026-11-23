/**
 * AI action details — work (items, subtasks, checklists, comments, time, links,
 * reminders, watchers, board columns, labels, custom fields, forms).
 *
 * Slice S2 (registry wave A). Item/comment bodies are untrusted member content; most
 * ops carry the `standard` profile, personal config (columns, custom fields, forms,
 * checklist templates) uses `config`, and comment creates set `notifies`
 * (→ `openWorldHint`). `:orgSlug` is never an argument — the tenant is taken from
 * the grant (architecture B3/T-TEN-01).
 */
import { z } from 'zod';
import {
  DEPENDENCY_KINDS,
  MAX_DEPENDENCY_LAG,
  MIN_DEPENDENCY_LAG,
  WORK_ITEM_STATES,
  WORK_ITEM_TITLE_MAX,
} from '@tmanage/domain';
import {
  atLeastOne,
  det,
  queryArgs,
  pathOnly,
  listArgs,
  bodyArgs,
  f,
  type AiActionDetail,
} from './detail.js';
import { WORK_FORM_FIELD_TYPES, WORK_ITEM_LINK_TYPES } from '../../../common/database/schema.js';
import { MAX_ESTIMATE_MINUTES } from '../../work/item-estimate.service.js';

/** = work/work-items.controller.ts:AUDIENCES */
const AUDIENCES = ['internal', 'client_visible', 'client_action_required'] as const;

/** An ISO-8601 instant with a time of day (a bare date is refused by the work-item route). */
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T/)
  .max(40)
  .describe('An ISO-8601 instant, e.g. 2026-09-30T17:00:00Z');

/** A calendar day, `YYYY-MM-DD`. */
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('A date, YYYY-MM-DD');

export const workDetails: readonly AiActionDetail[] = [
  det({
    id: 'work_forms.create',
    title: 'Create a work form',
    description:
      'Create an intake form: a name and 1 to 50 fields, each with a unique label, a type and whether it is required.',
    input: bodyArgs([], {
      name: f.shortText(300),
      fields: z
        .array(
          z
            .object({
              label: f.shortText(200),
              type: z.enum(WORK_FORM_FIELD_TYPES),
              required: f.bool(),
            })
            .strict(),
        )
        .min(1)
        .max(50),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Design request form',
        args: {
          name: 'Design request',
          fields: [
            { label: 'What do you need?', type: 'text', required: true },
            { label: 'Deadline', type: 'date', required: false },
          ],
        },
      },
    ],
  }),
  det({
    id: 'work_forms.list',
    title: 'List work form',
    description: 'List work form.',
    input: listArgs([], {}, { cursor: null }),
    redact: 'standard',
    examples: [{ summary: 'List work form', args: {} }],
  }),
  det({
    id: 'work_forms.submissions.create',
    title: 'Create work form submissions',
    description: 'Create work form submissions.',
    input: bodyArgs(['formId'], {
      projectId: f.id().optional(),
      title: f.shortText().optional(),
      values: z.array(z.unknown()).max(500).optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Create work form submissions',
        args: { formId: 'form_1', projectId: 'proj_1', title: 'Draft the Q4 brief' },
      },
    ],
  }),
  det({
    id: 'work_items.activity.list',
    title: 'List work item activity',
    description: 'List work item activity.',
    input: listArgs(['workItemId'], {}, { cursor: null }),
    redact: 'standard',
    examples: [{ summary: 'List work item activity', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.apply_checklist_template.create',
    title: 'Create work item apply checklist template',
    description: 'Create work item apply checklist template.',
    input: bodyArgs(['workItemId', 'templateId'], {}),
    redact: 'standard',
    examples: [
      {
        summary: 'Create work item apply checklist template',
        args: { workItemId: 'wi_1', templateId: 'tmpl_1' },
      },
    ],
  }),
  det({
    id: 'work_items.blockers.list',
    title: 'List work item blockers',
    description: 'List work item blockers.',
    input: queryArgs(['workItemId']),
    redact: 'standard',
    examples: [{ summary: 'List work item blockers', args: { workItemId: 'wi_1' } }],
  }),
  // R32 C25.
  det({
    id: 'work_items.client_audience.list',
    title: 'Which clients can see a work item',
    description:
      'The client companies a client-facing work item is limited to. An empty list means every ' +
      'client company the project is shared with.',
    input: queryArgs(['workItemId']),
    redact: 'standard',
    examples: [{ summary: 'Who can see this task', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.bulk_transition.create',
    title: 'Move many work items to one state',
    description:
      'Move up to 500 work items to one state, answered per item. `targetStatus` is one of ' +
      'backlog, ready, in_progress, blocked, internal_review, done, archived. Items whose move ' +
      'needs facts (blocked, leaving blocked, done, reopening) are reported as refused; move ' +
      'those one at a time with work_items.transitions.create.',
    input: bodyArgs([], {
      ids: z.array(f.id()).min(1).max(500),
      targetStatus: z.enum(WORK_ITEM_STATES),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Send three tasks back to the backlog',
        args: { ids: ['wi_1', 'wi_2', 'wi_3'], targetStatus: 'backlog' },
      },
    ],
  }),
  det({
    id: 'work_items.checklist.create',
    title: 'Create work item checklist',
    description: 'Add a checklist line (label) to a work item.',
    input: bodyArgs(['workItemId'], { label: f.shortText(300) }),
    redact: 'standard',
    examples: [
      { summary: 'Create work item checklist', args: { workItemId: 'wi_1', label: 'In review' } },
    ],
  }),
  det({
    id: 'work_items.checklist.list',
    title: 'List work item checklist',
    description: 'List work item checklist.',
    input: queryArgs(['workItemId']),
    redact: 'standard',
    examples: [{ summary: 'List work item checklist', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.checklist.update',
    title: 'Update work item checklist',
    description: 'Rename a checklist line or tick it off: send label and/or done.',
    input: atLeastOne(
      bodyArgs(['workItemId', 'itemId'], {
        label: f.shortText(300).optional(),
        done: f.bool().optional(),
      }),
      ['label', 'done'],
    ),
    redact: 'standard',
    examples: [
      {
        summary: 'Update work item checklist',
        args: { workItemId: 'wi_1', itemId: 'ite_1', label: 'In review' },
      },
    ],
  }),
  det({
    id: 'work_items.comments.create',
    title: 'Create work item comments',
    description: 'Create work item comments. Notifies the people involved.',
    input: bodyArgs(['workItemId'], { body: f.text(5000) }),
    redact: 'standard',
    notifies: true,
    examples: [
      { summary: 'Create work item comments', args: { workItemId: 'wi_1', body: 'A note' } },
    ],
  }),
  det({
    id: 'work_items.comments.list',
    title: 'List work item comments',
    description: 'List work item comments.',
    input: queryArgs(['workItemId']),
    redact: 'standard',
    examples: [{ summary: 'List work item comments', args: { workItemId: 'wi_1' } }],
  }),
  // 53-11.
  det({
    id: 'work_items.comments.mention_candidates.list',
    title: 'Find people to mention on a work item',
    description:
      'People who can see this work item whose name starts with q. Insert the returned mention ' +
      'token in a comment to notify them.',
    input: listArgs(['workItemId'], { q: f.shortText(100).optional() }, { cursor: null }),
    redact: 'standard',
    examples: [{ summary: 'Names starting with li', args: { workItemId: 'wi_1', q: 'li' } }],
  }),
  det({
    id: 'work_items.create',
    title: 'Create work item',
    description:
      'Create work item. Internal by default; a client audience (client_visible or ' +
      'client_action_required) publishes it to the client portal and needs approval in TManage first.',
    input: bodyArgs([], {
      projectId: f.id(),
      title: f.shortText(WORK_ITEM_TITLE_MAX),
      description: f.text().optional(),
      type: f.shortText(32).optional(),
      ownerUserId: f.id().optional(),
      audience: z.enum(AUDIENCES).optional(),
      startAt: instant.nullable().optional(),
      dueAt: instant.nullable().optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Create work item',
        args: {
          projectId: 'proj_1',
          title: 'Draft the Q4 brief',
          type: 'task',
          audience: 'internal',
          dueAt: '2026-10-20T14:00:00Z',
        },
      },
    ],
  }),
  det({
    id: 'work_items.custom_fields.list',
    title: 'List work item custom fields',
    description: 'List work item custom fields.',
    input: queryArgs(['workItemId']),
    redact: 'config',
    examples: [{ summary: 'List work item custom fields', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.custom_fields.set',
    title: 'Set work item custom fields',
    description: 'Set work item custom fields.',
    input: bodyArgs(['workItemId', 'key'], { value: z.number().optional() }),
    redact: 'config',
    examples: [
      {
        summary: 'Set work item custom fields',
        args: { workItemId: 'wi_1', key: 'k1', value: 100 },
      },
    ],
  }),
  det({
    id: 'work_items.delete',
    title: 'Delete work item',
    description: 'Delete work item. Confirm-class: needs your approval before it runs.',
    input: pathOnly('workItemId'),
    redact: 'standard',
    examples: [{ summary: 'Delete work item', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.dependencies.create',
    title: 'Create work item dependencies',
    description:
      'Make this work item depend on another (dependsOnWorkItemId): kind FS (default), SS, FF or SF, with an optional lag in working days.',
    input: bodyArgs(['workItemId'], {
      dependsOnWorkItemId: f.id(),
      kind: z.enum(DEPENDENCY_KINDS).optional().describe('Default FS (finish to start)'),
      lagWorkingDays: f.int(MIN_DEPENDENCY_LAG, MAX_DEPENDENCY_LAG).optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Create work item dependencies',
        args: { workItemId: 'wi_1', dependsOnWorkItemId: 'dep_1' },
      },
    ],
  }),
  det({
    id: 'work_items.dependencies.delete',
    title: 'Delete work item dependencies',
    description:
      'Delete work item dependencies. Confirm-class: needs your approval before it runs.',
    input: pathOnly('workItemId', 'dependencyId'),
    redact: 'standard',
    examples: [
      {
        summary: 'Delete work item dependencies',
        args: { workItemId: 'wi_1', dependencyId: 'dep_1' },
      },
    ],
  }),
  det({
    id: 'work_items.estimate.list',
    title: 'List work item estimate',
    description: 'List work item estimate.',
    input: queryArgs(['workItemId']),
    redact: 'standard',
    examples: [{ summary: 'List work item estimate', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.estimate.set',
    title: 'Set work item estimate',
    description:
      'Set the estimate of a work item in minutes, and optionally the remaining minutes (null clears the override).',
    input: bodyArgs(['workItemId'], {
      minutes: f.int(1, MAX_ESTIMATE_MINUTES),
      remainingMinutes: f.int(0, MAX_ESTIMATE_MINUTES).nullable().optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'Estimate three hours', args: { workItemId: 'wi_1', minutes: 180 } }],
  }),
  det({
    id: 'work_items.files.create',
    title: 'Create work item files',
    description: 'Attach an uploaded file (fileAssetId) to a work item.',
    input: bodyArgs(['workItemId'], { fileAssetId: f.id() }),
    redact: 'standard',
    examples: [{ summary: 'Attach a file', args: { workItemId: 'wi_1', fileAssetId: 'file_1' } }],
  }),
  det({
    id: 'work_items.files.delete',
    title: 'Delete work item files',
    description: 'Delete work item files. Confirm-class: needs your approval before it runs.',
    input: pathOnly('workItemId', 'linkId'),
    redact: 'standard',
    examples: [
      { summary: 'Delete work item files', args: { workItemId: 'wi_1', linkId: 'lnk_1' } },
    ],
  }),
  det({
    id: 'work_items.files.list',
    title: 'List work item files',
    description: 'List work item files. Confirm-class: needs your approval before it runs.',
    input: queryArgs(['workItemId']),
    redact: 'standard',
    examples: [{ summary: 'List work item files', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.get',
    title: 'Get work item',
    description: 'Get work item.',
    input: pathOnly('workItemId'),
    redact: 'standard',
    examples: [{ summary: 'Get work item', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.health',
    title: 'Health of work item',
    description: 'Health of work item.',
    input: pathOnly('workItemId'),
    redact: 'standard',
    examples: [{ summary: 'Health of work item', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.labels.delete',
    title: 'Delete work item labels',
    description: 'Delete work item labels. Confirm-class: needs your approval before it runs.',
    input: pathOnly('workItemId', 'labelId'),
    redact: 'standard',
    examples: [
      { summary: 'Delete work item labels', args: { workItemId: 'wi_1', labelId: 'lbl_1' } },
    ],
  }),
  det({
    id: 'work_items.labels.list',
    title: 'List work item labels',
    description: 'List work item labels.',
    input: queryArgs(['workItemId']),
    redact: 'standard',
    examples: [{ summary: 'List work item labels', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.labels.set',
    title: 'Set work item labels',
    description: 'Put a label (labelId) on a work item.',
    input: bodyArgs(['workItemId'], { labelId: f.id() }),
    redact: 'standard',
    examples: [{ summary: 'Add a label', args: { workItemId: 'wi_1', labelId: 'lbl_1' } }],
  }),
  det({
    id: 'work_items.links.create',
    title: 'Create work item links',
    description: 'Link this work item to another: it blocks, is blocked by, or relates to it.',
    input: bodyArgs(['workItemId'], {
      toWorkItemId: f.id(),
      linkType: z.enum(WORK_ITEM_LINK_TYPES),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Mark one item as blocking another',
        args: { workItemId: 'wi_1', toWorkItemId: 'wi_2', linkType: 'blocks' },
      },
    ],
  }),
  det({
    id: 'work_items.links.delete',
    title: 'Delete work item links',
    description: 'Delete work item links. Confirm-class: needs your approval before it runs.',
    input: pathOnly('workItemId', 'linkId'),
    redact: 'standard',
    examples: [
      { summary: 'Delete work item links', args: { workItemId: 'wi_1', linkId: 'lnk_1' } },
    ],
  }),
  det({
    id: 'work_items.links.list',
    title: 'List work item links',
    description: 'List work item links.',
    input: queryArgs(['workItemId']),
    redact: 'standard',
    examples: [{ summary: 'List work item links', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.list',
    title: 'List work item',
    description: 'List work item.',
    input: listArgs(
      [],
      { projectId: f.id().optional(), state: f.shortText(200).optional() },
      { cursor: 'after' },
    ),
    redact: 'standard',
    examples: [{ summary: 'List work item', args: {} }],
  }),
  det({
    id: 'work_items.project_health.get',
    title: 'Get work item project health',
    description: 'Get work item project health.',
    input: pathOnly('projectId'),
    redact: 'standard',
    examples: [{ summary: 'Get work item project health', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'work_items.recurrence.delete',
    title: 'Delete work item recurrence',
    description: 'Delete work item recurrence. Confirm-class: needs your approval before it runs.',
    input: pathOnly('workItemId'),
    redact: 'standard',
    examples: [{ summary: 'Delete work item recurrence', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.recurrence.generate_next.create',
    title: 'Create work item recurrence generate next',
    description: 'Create work item recurrence generate next.',
    input: bodyArgs(['workItemId'], {}),
    redact: 'standard',
    examples: [
      { summary: 'Create work item recurrence generate next', args: { workItemId: 'wi_1' } },
    ],
  }),
  det({
    id: 'work_items.recurrence.list',
    title: 'List work item recurrence',
    description: 'List work item recurrence.',
    input: queryArgs(['workItemId']),
    redact: 'standard',
    examples: [{ summary: 'List work item recurrence', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.recurrence.set',
    title: 'Set work item recurrence',
    description: 'Set work item recurrence.',
    input: bodyArgs(['workItemId'], {
      freq: f.shortText().optional(),
      interval: f.int().optional(),
      until: f.iso().optional(),
      // R17-e (53-09) v2 body: preset or RRULE subset, spawn and holiday settings.
      preset: f.shortText(16).optional(),
      rrule: f.shortText(512).optional(),
      spawnMode: f.shortText(12).optional(),
      spawnAheadDays: f.int(0, 30).optional(),
      holidayPolicy: f.shortText(20).optional(),
      countLimit: f.int(1, 365).optional(),
      timeZone: f.shortText(64).optional(),
      startsOn: f.iso().optional(),
      endsOn: f.iso().optional(),
      // r46: how far an edit reaches ('all' | 'this_and_future') and from which date.
      scope: f.shortText(16).optional(),
      fromDate: f.iso().optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'Set work item recurrence', args: { workItemId: 'wi_1' } }],
  }),
  // ---- R17-e · 53-09 recurring work v2 ----
  det({
    id: 'work_items.recurrence.preview.list',
    title: 'Preview work item recurrence dates',
    description: 'List the next dates a repeat rule will create, over the company calendar.',
    input: queryArgs(['workItemId'], { count: f.int(1, 30).optional() }),
    redact: 'standard',
    examples: [{ summary: 'Preview the next dates', args: { workItemId: 'wi_1', count: 5 } }],
  }),
  det({
    id: 'work_items.recurrence.skip.create',
    title: 'Skip one work item recurrence date',
    description: 'Skip one occurrence (YYYY-MM-DD) of a repeat rule before it is created.',
    input: bodyArgs(['workItemId'], { occurrenceKey: f.iso() }),
    redact: 'standard',
    examples: [
      { summary: 'Skip one date', args: { workItemId: 'wi_1', occurrenceKey: '2026-11-08' } },
    ],
  }),
  det({
    id: 'work_items.recurrence.pause.create',
    title: 'Pause work item recurrence',
    description: 'Pause a repeat rule; no new tasks are created until it is resumed.',
    input: bodyArgs(['workItemId'], {}),
    redact: 'standard',
    examples: [{ summary: 'Pause a repeat rule', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.recurrence.resume.create',
    title: 'Resume work item recurrence',
    description: 'Resume a paused repeat rule.',
    input: bodyArgs(['workItemId'], {}),
    redact: 'standard',
    examples: [{ summary: 'Resume a repeat rule', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.recurrence.end.create',
    title: 'End work item recurrence',
    description: 'End a repeat rule for good. Confirm-class: needs your approval before it runs.',
    input: bodyArgs(['workItemId'], {}),
    redact: 'standard',
    examples: [{ summary: 'End a repeat rule', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.relations.graph.list',
    title: 'List work item relations graph',
    description: 'List work item relations graph.',
    input: queryArgs(['workItemId'], { depth: f.int().optional() }),
    redact: 'standard',
    examples: [{ summary: 'List work item relations graph', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.reminder.delete',
    title: 'Delete work item reminder',
    description: 'Delete work item reminder. Confirm-class: needs your approval before it runs.',
    input: pathOnly('workItemId'),
    redact: 'standard',
    examples: [{ summary: 'Delete work item reminder', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.reminder.set',
    title: 'Set work item reminder',
    description: 'Remind me about a work item at an instant (ISO-8601 date-time).',
    input: bodyArgs(['workItemId'], { remindAt: f.iso() }),
    redact: 'standard',
    examples: [
      {
        summary: 'Remind me tomorrow morning',
        args: { workItemId: 'wi_1', remindAt: '2026-11-24T09:00:00Z' },
      },
    ],
  }),
  det({
    id: 'work_items.reminders.due.list',
    title: 'List work item reminders due',
    description: 'List work item reminders due.',
    input: listArgs([], {}, { limit: false, cursor: 'before' }),
    redact: 'standard',
    examples: [{ summary: 'List work item reminders due', args: {} }],
  }),
  det({
    id: 'work_items.subtasks.create',
    title: 'Create work item subtasks',
    description: 'Add a subtask (title) to a work item.',
    input: bodyArgs(['workItemId'], { title: f.shortText(WORK_ITEM_TITLE_MAX) }),
    redact: 'standard',
    examples: [
      {
        summary: 'Create work item subtasks',
        args: { workItemId: 'wi_1', title: 'Draft the Q4 brief' },
      },
    ],
  }),
  det({
    id: 'work_items.subtasks.delete',
    title: 'Delete work item subtasks',
    description: 'Delete work item subtasks. Confirm-class: needs your approval before it runs.',
    input: pathOnly('workItemId', 'subtaskId'),
    redact: 'standard',
    examples: [
      { summary: 'Delete work item subtasks', args: { workItemId: 'wi_1', subtaskId: 'st_1' } },
    ],
  }),
  det({
    id: 'work_items.subtasks.list',
    title: 'List work item subtasks',
    description: 'List work item subtasks.',
    input: queryArgs(['workItemId']),
    redact: 'standard',
    examples: [{ summary: 'List work item subtasks', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.subtasks.set',
    title: 'Set work item subtasks',
    description: 'Change a subtask: send at least one of title, done or position.',
    input: atLeastOne(
      bodyArgs(['workItemId', 'subtaskId'], {
        title: f.shortText(WORK_ITEM_TITLE_MAX).optional(),
        done: f.bool().optional(),
        position: f.int(0, 1_000_000).optional(),
      }),
      ['title', 'done', 'position'],
    ),
    redact: 'standard',
    examples: [
      {
        summary: 'Set work item subtasks',
        args: { workItemId: 'wi_1', subtaskId: 'st_1', title: 'Draft the Q4 brief' },
      },
    ],
  }),
  det({
    id: 'work_items.time_logs.create',
    title: 'Create work item time logs',
    description:
      'Log time on a work item: minutes (1-1440) on a calendar day (spentOn, not ahead), with an optional note, billable flag, and the start/end instants of the span. ' +
      "Time typed in needs the owner's permission (Admin > Time) and a reason (3-500 characters); it waits for a manager's approval. Refused: the reason is in the answer.",
    input: bodyArgs(['workItemId'], {
      minutes: f.int(1, 24 * 60),
      spentOn: dateOnly,
      note: z.string().max(500).nullable().optional(),
      billable: f.bool().optional().describe('Default true'),
      startedAt: f.iso().optional().describe('With endedAt: ISO instant with a zone, last 31 days'),
      endedAt: f.iso().optional(),
      reason: z.string().min(3).max(500).optional().describe('Why this time is typed in'),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Log 90 minutes today',
        args: {
          workItemId: 'wi_1',
          minutes: 90,
          spentOn: '2026-11-23',
          note: 'Client call',
          reason: 'Call on my phone, timer was off',
        },
      },
    ],
  }),
  det({
    id: 'work_items.time_logs.delete',
    title: 'Delete work item time logs',
    description: 'Delete work item time logs. Confirm-class: needs your approval before it runs.',
    input: pathOnly('workItemId', 'entryId'),
    redact: 'standard',
    examples: [
      { summary: 'Delete work item time logs', args: { workItemId: 'wi_1', entryId: 'e_1' } },
    ],
  }),
  det({
    id: 'work_items.time_logs.list',
    title: 'List work item time logs',
    description: 'List work item time logs.',
    input: queryArgs(['workItemId']),
    redact: 'standard',
    examples: [{ summary: 'List work item time logs', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.transitions.create',
    title: 'Move a work item to another state',
    description:
      'Move one work item to another state. `version` is the current version of the item: read it ' +
      'from work_items.get just before this call (a stale version is refused). `to` is one of ' +
      'backlog, ready, in_progress, blocked, internal_review, done, archived. Some moves need ' +
      '`facts`: to blocked needs blockerReason and blockerAsk (blockerOwnerUserId optional); ' +
      'leaving blocked needs blockerResolution; done (only from internal_review) needs ownerId ' +
      '(a member user id) and completedAt (an ISO 8601 time, not in the future); reopening a ' +
      'done item needs reopenReason.',
    input: bodyArgs(['workItemId'], {
      version: f.int(),
      to: z.enum(WORK_ITEM_STATES),
      facts: f.config().optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Start work on a task',
        args: { workItemId: 'wi_1', version: 3, to: 'in_progress' },
      },
      {
        summary: 'Mark a reviewed task done',
        args: {
          workItemId: 'wi_1',
          version: 5,
          to: 'done',
          facts: { ownerId: 'usr_1', completedAt: '2026-11-23T09:00:00Z' },
        },
      },
    ],
  }),
  det({
    id: 'work_items.update',
    title: 'Update work item',
    description:
      'Change a work item. version is the version you read (from work_items.get or the list); a stale one is refused. ' +
      'Choosing a client audience (client_visible or client_action_required) ' +
      'shows it in the client portal and needs approval in TManage first.',
    input: bodyArgs(['workItemId'], {
      version: f.int(1, Number.MAX_SAFE_INTEGER).describe('The version you read'),
      title: f.shortText(WORK_ITEM_TITLE_MAX).optional(),
      description: z.string().max(5000).nullable().optional().describe('null or blank clears it'),
      projectId: f.id().optional(),
      type: f.shortText(32).optional(),
      ownerUserId: f.id().nullable().optional(),
      audience: z.enum(AUDIENCES).optional(),
      startAt: instant.nullable().optional(),
      dueAt: instant.nullable().optional(),
      rank: z.number().nullable().optional().describe('Hand-made sort key; null = creation order'),
      billable: f.bool().nullable().optional(),
      points: f
        .int(0, 100)
        .nullable()
        .optional()
        .describe('Story points, when the project uses them'),
      iterationId: f.id().nullable().optional().describe('An open iteration; null = backlog'),
      // C25: limit a client-facing item to some of the project's client companies.
      clientOrganizationIds: z.array(f.id()).max(100).optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Update work item',
        args: {
          workItemId: 'wi_1',
          version: 3,
          title: 'Draft the Q4 brief',
          type: 'task',
          audience: 'internal',
          dueAt: '2026-10-20T14:00:00Z',
        },
      },
    ],
  }),
  det({
    id: 'work_items.watchers.delete',
    title: 'Delete work item watchers',
    description: 'Delete work item watchers. Confirm-class: needs your approval before it runs.',
    input: pathOnly('workItemId'),
    redact: 'standard',
    examples: [{ summary: 'Delete work item watchers', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.watchers.list',
    title: 'List work item watchers',
    description: 'List work item watchers.',
    input: queryArgs(['workItemId']),
    redact: 'standard',
    examples: [{ summary: 'List work item watchers', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.watchers.set',
    title: 'Set work item watchers',
    description: 'Set work item watchers.',
    input: bodyArgs(['workItemId'], {}),
    redact: 'standard',
    examples: [{ summary: 'Set work item watchers', args: { workItemId: 'wi_1' } }],
  }),
  // R33 C26.
  det({
    id: 'work_items.people.get',
    title: 'Who is on a work item',
    description: 'The people who do a work item (the lead first) and the people who supervise it.',
    input: queryArgs(['workItemId']),
    redact: 'standard',
    examples: [{ summary: 'Who is doing this task', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.people.doers.set',
    title: 'Set who does a work item',
    description:
      'Replace the people who do a work item. The first person becomes the lead (owner); an ' +
      'empty list leaves the item unassigned.',
    input: bodyArgs(['workItemId'], { userIds: z.array(f.id()).max(50) }),
    redact: 'standard',
    examples: [
      { summary: 'Two people do this task', args: { workItemId: 'wi_1', userIds: ['u_1', 'u_2'] } },
    ],
  }),
  det({
    id: 'work_items.people.supervisors.set',
    title: 'Set who supervises a work item',
    description:
      'Replace the people who supervise a work item. They are told when it is marked done.',
    input: bodyArgs(['workItemId'], { userIds: z.array(f.id()).max(50) }),
    redact: 'standard',
    examples: [{ summary: 'Supervise this task', args: { workItemId: 'wi_1', userIds: ['u_3'] } }],
  }),
  det({
    id: 'work_items.people.watchers.add',
    title: 'Add watchers to a work item',
    description: 'Add several people as watchers of a work item at once.',
    input: bodyArgs(['workItemId'], { userIds: z.array(f.id()).max(50) }),
    redact: 'standard',
    examples: [
      { summary: 'Watch this task', args: { workItemId: 'wi_1', userIds: ['u_4', 'u_5'] } },
    ],
  }),
  // C27.
  det({
    id: 'work_items.people.watchers.remove',
    title: 'Remove a watcher from a work item',
    description:
      'Take one person off the watchers of a work item. Anyone may remove themselves; removing ' +
      'someone else needs the right to edit the item.',
    input: listArgs(['workItemId', 'userId']),
    redact: 'standard',
    examples: [{ summary: 'Stop someone watching', args: { workItemId: 'wi_1', userId: 'u_4' } }],
  }),
  det({
    id: 'work.board_columns.create',
    title: 'Create work board columns',
    description: 'Create work board columns.',
    input: bodyArgs([], {
      label: f.shortText().optional(),
      stateKey: f.shortText().optional(),
      position: f.int().optional(),
    }),
    redact: 'config',
    examples: [
      {
        summary: 'Create work board columns',
        args: { label: 'In review', stateKey: 'in_progress' },
      },
    ],
  }),
  det({
    id: 'work.board_columns.delete',
    title: 'Delete work board columns',
    description: 'Delete work board columns. Confirm-class: needs your approval before it runs.',
    input: pathOnly('columnId'),
    redact: 'config',
    examples: [{ summary: 'Delete work board columns', args: { columnId: 'col_1' } }],
  }),
  det({
    id: 'work.board_columns.list',
    title: 'List work board columns',
    description: 'List work board columns.',
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'List work board columns', args: {} }],
  }),
  det({
    id: 'work.board_columns.set',
    title: 'Set work board columns',
    description: 'Set work board columns.',
    input: bodyArgs(['columnId'], {
      label: f.shortText().optional(),
      stateKey: f.shortText().optional(),
      position: f.int().optional(),
    }),
    redact: 'config',
    examples: [
      {
        summary: 'Set work board columns',
        args: { columnId: 'col_1', label: 'In review', stateKey: 'in_progress' },
      },
    ],
  }),
  det({
    id: 'work.checklist_templates.create',
    title: 'Create work checklist templates',
    description: 'Create work checklist templates.',
    input: bodyArgs([], {
      name: f.shortText().optional(),
      labels: z.array(z.unknown()).max(500).optional(),
    }),
    redact: 'config',
    examples: [{ summary: 'Create work checklist templates', args: { name: 'Design review' } }],
  }),
  det({
    id: 'work.checklist_templates.delete',
    title: 'Delete work checklist templates',
    description:
      'Delete work checklist templates. Confirm-class: needs your approval before it runs.',
    input: pathOnly('templateId'),
    redact: 'config',
    examples: [{ summary: 'Delete work checklist templates', args: { templateId: 'tmpl_1' } }],
  }),
  det({
    id: 'work.checklist_templates.list',
    title: 'List work checklist templates',
    description: 'List work checklist templates.',
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'List work checklist templates', args: {} }],
  }),
  det({
    id: 'work.custom_fields.create',
    title: 'Create work custom fields',
    description: 'Create work custom fields.',
    input: bodyArgs([], {
      key: f.shortText().optional(),
      name: f.shortText().optional(),
      fieldType: f.shortText().optional(),
      options: z.array(z.unknown()).max(500).optional(),
    }),
    redact: 'config',
    examples: [
      { summary: 'Create work custom fields', args: { key: 'priority', name: 'Design review' } },
    ],
  }),
  det({
    id: 'work.custom_fields.delete',
    title: 'Delete work custom fields',
    description: 'Delete work custom fields. Confirm-class: needs your approval before it runs.',
    input: pathOnly('key'),
    redact: 'config',
    examples: [{ summary: 'Delete work custom fields', args: { key: 'k1' } }],
  }),
  det({
    id: 'work.custom_fields.list',
    title: 'List work custom fields',
    description: 'List work custom fields.',
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'List work custom fields', args: {} }],
  }),
  det({
    id: 'work.labels.create',
    title: 'Create work labels',
    description: 'Create work labels.',
    input: bodyArgs([], { name: f.shortText().optional(), color: f.shortText().optional() }),
    redact: 'standard',
    examples: [
      { summary: 'Create work labels', args: { name: 'Design review', color: '#4f46e5' } },
    ],
  }),
  det({
    id: 'work.labels.list',
    title: 'List work labels',
    description: 'List work labels.',
    input: queryArgs(),
    redact: 'standard',
    examples: [{ summary: 'List work labels', args: {} }],
  }),
  det({
    id: 'work.quick_add.resolve',
    title: 'Resolve quick-add text',
    description:
      'Parse a quick-add line into a title and chips (owner, project, due date). Only names the caller can see are matched.',
    input: bodyArgs([], { q: f.shortText(300), projectId: f.id().optional() }),
    redact: 'standard',
    examples: [{ summary: 'Resolve quick-add text', args: { q: 'Draft brief @sara tomorrow' } }],
  }),
];
