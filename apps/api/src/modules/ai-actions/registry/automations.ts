/**
 * AI action details — automations (read and run only).
 *
 * Slice S4 (registry wave C). The AI can read runs, schedules and templates, edit templates and
 * their conditions/tags, and *run* or *schedule* a template (confirm-class, because a run can act
 * on many records and may message people). Automation **secrets** — variables, webhooks, app
 * connections and connection health — are in `NEVER` (plan §2), so none appear here.
 */
import { det, listArgs, pathOnly, bodyArgs, f, type AiActionDetail } from './detail.js';

export const automationsDetails: readonly AiActionDetail[] = [
  det({
    id: 'automations.runs.list',
    title: 'List automation runs',
    description: 'Recent automation runs and their outcomes.',
    input: listArgs(),
    redact: 'standard',
    examples: [{ summary: 'Recent', args: { limit: 20 } }],
  }),
  det({
    id: 'automations.runs.get',
    title: 'Get an automation run',
    description: 'One automation run with its steps.',
    input: pathOnly('runId'),
    redact: 'standard',
    examples: [{ summary: 'By id', args: { runId: 'run_1' } }],
  }),
  det({
    id: 'automations.schedules.list',
    title: 'List automation schedules',
    description: 'Scheduled automation triggers.',
    input: listArgs(),
    redact: 'standard',
    examples: [{ summary: 'All', args: {} }],
  }),
  det({
    id: 'automations.template_tags.list',
    title: 'List template tags',
    description: 'Tags used across automation templates.',
    input: listArgs(),
    redact: 'standard',
    examples: [{ summary: 'All', args: {} }],
  }),
  det({
    id: 'automations.templates.list',
    title: 'List automation templates',
    description: 'Automation templates defined in the workspace.',
    input: listArgs(),
    redact: 'standard',
    examples: [{ summary: 'All', args: {} }],
  }),
  det({
    id: 'automations.templates.create',
    title: 'Create an automation template',
    description: 'Define a new automation template (trigger + action).',
    input: bodyArgs([], {
      name: f.shortText(160),
      triggerKind: f.shortText(60),
      actionKind: f.shortText(60),
      config: f.config().optional(),
      enabled: f.bool().optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'New',
        args: { name: 'Auto-assign', triggerKind: 'item_created', actionKind: 'assign' },
      },
    ],
  }),
  det({
    id: 'automations.templates.update',
    title: 'Update an automation template',
    description: 'Change an automation template.',
    input: bodyArgs(['id'], {
      name: f.shortText(160).optional(),
      triggerKind: f.shortText(60).optional(),
      actionKind: f.shortText(60).optional(),
      config: f.config().optional(),
      enabled: f.bool().optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'Disable', args: { id: 'tpl_1', enabled: false } }],
  }),
  det({
    id: 'automations.templates.clone',
    title: 'Clone an automation template',
    description: 'Duplicate an automation template under a new name.',
    input: bodyArgs(['id'], { name: f.shortText(160) }),
    redact: 'standard',
    examples: [{ summary: 'Clone', args: { id: 'tpl_1', name: 'Auto-assign (copy)' } }],
  }),
  det({
    id: 'automations.templates.delete',
    title: 'Delete an automation rule',
    description: 'Remove an automation rule; its run history stays. Confirm-class.',
    input: pathOnly('id'),
    redact: 'standard',
    examples: [{ summary: 'Remove', args: { id: 'tpl_1' } }],
  }),
  det({
    id: 'automations.templates.conditions.list',
    title: 'List template conditions',
    description: 'Conditions on an automation template.',
    input: listArgs(['templateId']),
    redact: 'standard',
    examples: [{ summary: 'By template', args: { templateId: 'tpl_1' } }],
  }),
  det({
    id: 'automations.templates.conditions.create',
    title: 'Add a template condition',
    description: 'Add a condition to an automation template.',
    input: bodyArgs(['templateId'], {
      field: f.shortText(80),
      op: f.shortText(16),
      value: f.shortText(200),
      targetStep: f.shortText(60).optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'If high priority',
        args: { templateId: 'tpl_1', field: 'priority', op: 'eq', value: 'high' },
      },
    ],
  }),
  det({
    id: 'automations.templates.conditions.delete',
    title: 'Remove a template condition',
    description: 'Remove one condition from an automation rule. Confirm-class.',
    input: pathOnly('templateId', 'conditionId'),
    redact: 'standard',
    examples: [{ summary: 'Remove', args: { templateId: 'tpl_1', conditionId: 'cond_1' } }],
  }),
  det({
    id: 'automations.templates.tags.list',
    title: 'List template tags (one template)',
    description: 'Tags on one automation template.',
    input: listArgs(['templateId']),
    redact: 'standard',
    examples: [{ summary: 'By template', args: { templateId: 'tpl_1' } }],
  }),
  det({
    id: 'automations.templates.tags.create',
    title: 'Tag an automation template',
    description: 'Add a tag to an automation template.',
    input: bodyArgs(['templateId'], { label: f.shortText(60) }),
    redact: 'standard',
    examples: [{ summary: 'Tag', args: { templateId: 'tpl_1', label: 'triage' } }],
  }),
  det({
    id: 'automations.templates.tags.delete',
    title: 'Untag an automation template',
    description: 'Remove a tag from a template. Confirm-class.',
    input: pathOnly('templateId', 'tagId'),
    redact: 'standard',
    examples: [{ summary: 'Remove', args: { templateId: 'tpl_1', tagId: 'tag_1' } }],
  }),
  det({
    id: 'automations.templates.run',
    title: 'Run an automation',
    description:
      'Run an automation template now. Confirm-class: it can change many records and may message people.',
    input: bodyArgs(['templateId'], { dryRun: f.bool().optional() }),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Run', args: { templateId: 'tpl_1' } }],
  }),
  det({
    id: 'automations.templates.schedule',
    title: 'Schedule an automation',
    description: 'Schedule an automation template to run on a cadence. Confirm-class.',
    input: bodyArgs(['templateId'], {
      interval: f.shortText(20),
      hour: f.int(0, 23).optional(),
      dayOfWeek: f.int(0, 6).optional(),
      enabled: f.bool().optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'Daily 9am', args: { templateId: 'tpl_1', interval: 'daily', hour: 9 } }],
  }),
];
