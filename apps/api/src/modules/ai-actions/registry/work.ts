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
import { det, pathOnly, listArgs, bodyArgs, f, type AiActionDetail } from './detail.js';

export const workDetails: readonly AiActionDetail[] = [
  det({
    id: 'work_forms.create',
    title: 'Create work form',
    description: 'Create work form.',
    input: bodyArgs([], {
      name: f.shortText().optional(),
      fields: z.array(z.unknown()).max(500).optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'Create work form', args: { name: 'Design review' } }],
  }),
  det({
    id: 'work_forms.list',
    title: 'List work form',
    description: 'List work form.',
    input: listArgs(),
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
    input: listArgs(['workItemId']),
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
    input: listArgs(['workItemId']),
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
    input: listArgs(['workItemId']),
    redact: 'standard',
    examples: [{ summary: 'Who can see this task', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.bulk_transition.create',
    title: 'Create work item bulk transition',
    description: 'Create work item bulk transition.',
    input: bodyArgs([], {
      ids: z.array(f.id()).max(500).optional(),
      targetStatus: f.shortText().optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'Create work item bulk transition', args: {} }],
  }),
  det({
    id: 'work_items.checklist.create',
    title: 'Create work item checklist',
    description: 'Create work item checklist.',
    input: bodyArgs(['workItemId'], { label: f.shortText().optional() }),
    redact: 'standard',
    examples: [
      { summary: 'Create work item checklist', args: { workItemId: 'wi_1', label: 'In review' } },
    ],
  }),
  det({
    id: 'work_items.checklist.list',
    title: 'List work item checklist',
    description: 'List work item checklist.',
    input: listArgs(['workItemId']),
    redact: 'standard',
    examples: [{ summary: 'List work item checklist', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.checklist.update',
    title: 'Update work item checklist',
    description: 'Update work item checklist.',
    input: bodyArgs(['workItemId', 'itemId'], {
      label: f.shortText().optional(),
      done: f.bool().optional(),
    }),
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
    input: bodyArgs(['workItemId'], { body: f.text().optional() }),
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
    input: listArgs(['workItemId']),
    redact: 'standard',
    examples: [{ summary: 'List work item comments', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.create',
    title: 'Create work item',
    description:
      'Create work item. Internal by default; a client audience (client_visible or ' +
      'client_action_required) publishes it to the client portal and needs approval in TManage first.',
    input: bodyArgs([], {
      projectId: f.id().optional(),
      title: f.shortText().optional(),
      description: f.text().optional(),
      type: f.shortText().optional(),
      ownerUserId: f.id().optional(),
      audience: z.enum(['internal', 'client_visible', 'client_action_required']).optional(),
      startAt: f.iso().optional(),
      dueAt: f.iso().optional(),
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
    input: listArgs(['workItemId']),
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
    description: 'Create work item dependencies.',
    input: bodyArgs(['workItemId'], { dependsOnWorkItemId: f.id().optional() }),
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
    input: listArgs(['workItemId']),
    redact: 'standard',
    examples: [{ summary: 'List work item estimate', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.estimate.set',
    title: 'Set work item estimate',
    description: 'Set work item estimate.',
    input: bodyArgs(['workItemId'], { minutes: f.int().optional() }),
    redact: 'standard',
    examples: [{ summary: 'Set work item estimate', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.files.create',
    title: 'Create work item files',
    description: 'Create work item files.',
    input: bodyArgs(['workItemId'], { fileAssetId: f.id().optional() }),
    redact: 'standard',
    examples: [{ summary: 'Create work item files', args: { workItemId: 'wi_1' } }],
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
    input: listArgs(['workItemId']),
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
    input: listArgs(['workItemId']),
    redact: 'standard',
    examples: [{ summary: 'List work item labels', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.labels.set',
    title: 'Set work item labels',
    description: 'Set work item labels.',
    input: bodyArgs(['workItemId'], { labelId: f.id().optional() }),
    redact: 'standard',
    examples: [{ summary: 'Set work item labels', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.links.create',
    title: 'Create work item links',
    description: 'Create work item links.',
    input: bodyArgs(['workItemId'], {
      toWorkItemId: f.id().optional(),
      linkType: f.shortText().optional(),
    }),
    redact: 'standard',
    examples: [
      { summary: 'Create work item links', args: { workItemId: 'wi_1', toWorkItemId: 'wi_2' } },
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
    input: listArgs(['workItemId']),
    redact: 'standard',
    examples: [{ summary: 'List work item links', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.list',
    title: 'List work item',
    description: 'List work item.',
    input: listArgs([], { projectId: f.id().optional(), state: f.shortText(200).optional() }),
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
    input: listArgs(['workItemId']),
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
    }),
    redact: 'standard',
    examples: [{ summary: 'Set work item recurrence', args: { workItemId: 'wi_1' } }],
  }),
  // ---- R17-e · 53-09 recurring work v2 ----
  det({
    id: 'work_items.recurrence.preview.list',
    title: 'Preview work item recurrence dates',
    description: 'List the next dates a repeat rule will create, over the company calendar.',
    input: listArgs(['workItemId'], { count: f.int(1, 30).optional() }),
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
    input: listArgs(['workItemId'], { depth: f.int().optional() }),
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
    description: 'Set work item reminder.',
    input: bodyArgs(['workItemId'], { remindAt: f.iso().optional() }),
    redact: 'standard',
    examples: [{ summary: 'Set work item reminder', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.reminders.due.list',
    title: 'List work item reminders due',
    description: 'List work item reminders due.',
    input: listArgs(),
    redact: 'standard',
    examples: [{ summary: 'List work item reminders due', args: {} }],
  }),
  det({
    id: 'work_items.subtasks.create',
    title: 'Create work item subtasks',
    description: 'Create work item subtasks.',
    input: bodyArgs(['workItemId'], { title: f.shortText().optional() }),
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
    input: listArgs(['workItemId']),
    redact: 'standard',
    examples: [{ summary: 'List work item subtasks', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.subtasks.set',
    title: 'Set work item subtasks',
    description: 'Set work item subtasks.',
    input: bodyArgs(['workItemId', 'subtaskId'], {
      title: f.shortText().optional(),
      done: f.bool().optional(),
      position: f.int().optional(),
    }),
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
    description: 'Create work item time logs.',
    input: bodyArgs(['workItemId'], {
      minutes: f.int().optional(),
      spentOn: f.iso().optional(),
      note: f.text().optional(),
    }),
    redact: 'standard',
    examples: [
      { summary: 'Create work item time logs', args: { workItemId: 'wi_1', note: 'Looks good' } },
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
    input: listArgs(['workItemId']),
    redact: 'standard',
    examples: [{ summary: 'List work item time logs', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_items.transitions.create',
    title: 'Create work item transitions',
    description: 'Create work item transitions.',
    input: bodyArgs(['workItemId'], {
      version: f.int().optional(),
      to: f.shortText().optional(),
      facts: f.config().optional(),
    }),
    redact: 'standard',
    examples: [
      { summary: 'Create work item transitions', args: { workItemId: 'wi_1', to: 'done' } },
    ],
  }),
  det({
    id: 'work_items.update',
    title: 'Update work item',
    description:
      'Change a work item. Choosing a client audience (client_visible or client_action_required) ' +
      'shows it in the client portal and needs approval in TManage first.',
    input: bodyArgs(['workItemId'], {
      version: f.int().optional(),
      title: f.shortText().optional(),
      description: f.text().optional(),
      projectId: f.id().optional(),
      type: f.shortText().optional(),
      ownerUserId: f.id().optional(),
      audience: z.enum(['internal', 'client_visible', 'client_action_required']).optional(),
      startAt: f.iso().optional(),
      dueAt: f.iso().optional(),
      // C25: limit a client-facing item to some of the project's client companies.
      clientOrganizationIds: z.array(f.id()).max(100).optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Update work item',
        args: {
          workItemId: 'wi_1',
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
    input: listArgs(['workItemId']),
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
    input: listArgs(['workItemId']),
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
    input: listArgs(),
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
    input: listArgs(),
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
    input: listArgs(),
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
    input: listArgs(),
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
