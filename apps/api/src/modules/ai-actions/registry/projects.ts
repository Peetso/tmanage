/**
 * AI action details — projects (core, members, milestones, phases, objectives, risks,
 * dependencies, baselines, budget, allocations, tags, custom fields, folders, templates,
 * status updates, portfolio, portal settings).
 *
 * Slice S2 (registry wave A). Budget and allocation figures carry the `billing` profile,
 * member data the `people` profile, saved config the `config` profile; published
 * status updates set `notifies`. `:orgSlug` is never an argument (architecture B3/T-TEN-01).
 */
import { z } from 'zod';
import { BUDGET_TYPES, PROJECT_NAME_MAX } from '@tmanage/domain';
import {
  atLeastOne,
  det,
  queryArgs,
  pathOnly,
  listArgs,
  noArgs,
  bodyArgs,
  f,
  type AiActionDetail,
} from './detail.js';
import { PERSON_ALLOCATION_STATUSES } from '../../people/allocations.repository.js';
import { BASELINE_KINDS } from '../../projects/baseline.repository.js';
import {
  MAX_BUDGET_AMOUNT_MINOR,
  MAX_BUDGET_HOURS,
  MAX_BUDGET_PHASES,
} from '../../projects/budget.service.js';
import { ProjectCustomFieldsService } from '../../projects/custom-fields.service.js';
import {
  PROJECT_CUSTOM_FIELD_TYPES,
  PROJECT_INTERNAL_RISK_IMPACTS,
  PROJECT_INTERNAL_RISK_LIKELIHOODS,
  PROJECT_INTERNAL_RISK_STATUSES,
  PROJECT_OBJECTIVE_STATUSES,
  PROJECT_RETRO_NOTE_CATEGORIES,
  PROJECT_RISK_SEVERITIES,
  PROJECT_RISK_STATUSES,
  PROJECT_STATUS_BANDS,
} from '../../../common/database/schema.js';
import { MAX_UPDATE_COMMENT_BODY_LENGTH } from '../../clients/update-comments.service.js';
import { PACK_ROLES } from '../../projects/template-packs.catalog.js';

/** A custom-field key: lower_snake_case (`custom-fields.service.ts` FIELD_KEY_PATTERN, max 120). */
const fieldKey = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9_]+$/);

/** A calendar date as the routes take it: `YYYY-MM-DD`. */
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('A date, YYYY-MM-DD');

export const projectsDetails: readonly AiActionDetail[] = [
  det({
    id: 'projects.allocations.create',
    title: 'Allocate a member to a project',
    description:
      'Allocate one member (membershipId) to the project at a percent of their capacity (1-100), optionally between two dates, tentative or confirmed. One active allocation per member and project.',
    input: bodyArgs(['projectId'], {
      membershipId: f.id(),
      percent: f.int(1, 100),
      startDate: dateOnly.optional(),
      endDate: dateOnly.optional(),
      status: z.enum(PERSON_ALLOCATION_STATUSES).optional().describe('Default confirmed'),
      hoursPerWeek: z.number().gt(0).max(168).optional(),
      note: z.string().max(300).optional(),
    }),
    redact: 'billing',
    examples: [
      {
        summary: 'Allocate a member at 50 % for a month',
        args: {
          projectId: 'proj_1',
          membershipId: 'mem_1',
          percent: 50,
          startDate: '2026-10-20',
          endDate: '2026-11-20',
        },
      },
    ],
  }),
  det({
    id: 'projects.allocations.confirm.create',
    title: 'Confirm a tentative allocation',
    description: 'Mark one tentative project allocation as confirmed.',
    input: pathOnly('projectId', 'id'),
    redact: 'billing',
    examples: [{ summary: 'Confirm', args: { projectId: 'proj_1', id: 'alloc_1' } }],
  }),
  // R21-b · 53-08: edit and remove an allocation.
  det({
    id: 'projects.allocations.update',
    title: 'Edit a project allocation',
    description:
      'Change one allocation’s percent, dates, weekly hours or note. Status changes go through confirm.',
    input: bodyArgs(['projectId', 'id'], {
      percent: z.number().optional(),
      startDate: f.iso().nullable().optional(),
      endDate: f.iso().nullable().optional(),
      hoursPerWeek: z.number().nullable().optional(),
      note: f.shortText().nullable().optional(),
    }),
    redact: 'billing',
    examples: [{ summary: 'Edit', args: { projectId: 'proj_1', id: 'alloc_1', percent: 60 } }],
  }),
  det({
    id: 'projects.allocations.delete',
    title: 'Remove a project allocation',
    description:
      'Remove one project allocation. Confirm-class: needs your approval before it runs.',
    input: pathOnly('projectId', 'id'),
    redact: 'billing',
    examples: [{ summary: 'Remove', args: { projectId: 'proj_1', id: 'alloc_1' } }],
  }),
  det({
    id: 'projects.allocations.list',
    title: 'List project allocations',
    description: 'List project allocations.',
    input: listArgs(['projectId'], {}, { cursor: null }),
    redact: 'billing',
    examples: [{ summary: 'List project allocations', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.baselines.create',
    title: 'Freeze a project baseline',
    description:
      "Freeze the project's current dates as a named baseline (label), of the whole plan or milestones only.",
    input: bodyArgs(['projectId'], {
      label: f.shortText(300),
      note: z.string().max(500).nullable().optional(),
      kind: z.enum(BASELINE_KINDS).optional().describe('Default full'),
    }),
    redact: 'standard',
    examples: [
      { summary: 'Freeze a baseline', args: { projectId: 'proj_1', label: 'Signed-off plan' } },
    ],
  }),
  det({
    id: 'projects.baselines.delete',
    title: 'Delete project baselines',
    description: 'Delete project baselines. Confirm-class: needs your approval before it runs.',
    input: pathOnly('projectId', 'baselineId'),
    redact: 'standard',
    examples: [
      { summary: 'Delete project baselines', args: { projectId: 'proj_1', baselineId: 'base_1' } },
    ],
  }),
  det({
    id: 'projects.baselines.list',
    title: 'List project baselines',
    description: 'List project baselines.',
    input: listArgs(['projectId'], {}, { cursor: null }),
    redact: 'standard',
    examples: [{ summary: 'List project baselines', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.baselines.overlay.get',
    title: 'Get the current baseline overlay',
    description:
      "The current baseline's frozen start and due dates per work item (timeline ghost bars).",
    input: pathOnly('projectId'),
    redact: 'standard',
    examples: [{ summary: 'Get the baseline overlay', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.baselines.variance.list',
    title: 'List project baselines variance',
    description:
      'How far each work item has moved from this baseline: against today, or against another baseline (against).',
    input: listArgs(
      ['projectId', 'baselineId'],
      { against: f.id().optional().describe('Another baseline id to compare with') },
      { limit: false },
    ),
    redact: 'standard',
    examples: [
      {
        summary: 'List project baselines variance',
        args: { projectId: 'proj_1', baselineId: 'base_1' },
      },
    ],
  }),
  det({
    id: 'projects.budget.list',
    title: 'List project budget',
    description: 'List project budget.',
    input: queryArgs(['projectId']),
    redact: 'billing',
    examples: [{ summary: 'List project budget', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.budget.set',
    title: 'Set project budget',
    description:
      "Set (create or replace) the project's budget: hours, money (minor units plus currency) or both. Give budgetHours null for a money-only budget.",
    input: bodyArgs(['projectId'], {
      budgetHours: z
        .number()
        .min(0)
        .max(MAX_BUDGET_HOURS)
        .nullable()
        .describe('Hours, in whole minutes (e.g. 40.5); null for a money-only budget'),
      budgetAmountMinor: z
        .number()
        .int()
        .min(0)
        .max(MAX_BUDGET_AMOUNT_MINOR)
        .nullable()
        .optional()
        .describe('Money in minor units (cents); needs currency'),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .nullable()
        .optional()
        .describe('ISO-4217 code, only with budgetAmountMinor'),
      budgetType: z.enum(BUDGET_TYPES).optional(),
      includeExpenses: f.bool().optional(),
      clientVisible: f.bool().optional(),
      alertThresholds: z
        .array(z.number().int().min(1).max(100))
        .min(1)
        .max(4)
        .optional()
        .describe('1-4 whole percents, ascending, e.g. [50, 80, 100]'),
      phases: z
        .array(
          z
            .object({
              phaseId: z.string().length(36).nullable().optional(),
              name: f.shortText(120),
              budgetHours: z.number().min(0).max(MAX_BUDGET_HOURS).nullable().optional(),
              budgetAmountMinor: z
                .number()
                .int()
                .min(0)
                .max(MAX_BUDGET_AMOUNT_MINOR)
                .nullable()
                .optional(),
              position: z.number().int().optional(),
            })
            .strict(),
        )
        .max(MAX_BUDGET_PHASES)
        .optional()
        .describe('Replaces the whole phase split'),
    }),
    redact: 'billing',
    examples: [
      {
        summary: 'Set a 120-hour budget',
        args: { projectId: 'proj_1', budgetHours: 120 },
      },
      {
        summary: 'Set a money budget of 25,000.00 SAR',
        args: {
          projectId: 'proj_1',
          budgetHours: null,
          budgetAmountMinor: 2_500_000,
          currency: 'SAR',
          budgetType: 'money',
        },
      },
    ],
  }),
  det({
    id: 'projects.clients.create',
    title: 'Share a project with a client company',
    description: 'Share the project with one client company (clientOrganizationId).',
    input: bodyArgs(['projectId'], { clientOrganizationId: f.id() }),
    redact: 'standard',
    examples: [
      {
        summary: 'Share with a client company',
        args: { projectId: 'proj_1', clientOrganizationId: 'co_1' },
      },
    ],
  }),
  det({
    id: 'projects.clients.delete',
    title: 'Delete project clients',
    description: 'Delete project clients. Confirm-class: needs your approval before it runs.',
    input: pathOnly('projectId', 'clientOrganizationId'),
    redact: 'standard',
    examples: [
      {
        summary: 'Delete project clients',
        args: { projectId: 'proj_1', clientOrganizationId: 'co_1' },
      },
    ],
  }),
  det({
    id: 'projects.client.update',
    title: 'Set project client',
    description:
      "Set a project's client company, or none; replaces any existing share. Confirm-class: client-facing.",
    input: bodyArgs(['projectId'], { clientOrganizationId: f.id().nullable() }),
    redact: 'standard',
    examples: [
      { summary: 'Set client', args: { projectId: 'proj_1', clientOrganizationId: 'co_1' } },
    ],
  }),
  det({
    id: 'projects.clients.list',
    title: 'List project clients',
    description: 'List project clients.',
    input: queryArgs(['projectId']),
    redact: 'standard',
    examples: [{ summary: 'List project clients', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.create',
    title: 'Create project',
    description:
      'Create a project in a workspace (workspaceId, from the workspace list) with a name, and optionally an owner and a target date.',
    input: bodyArgs([], {
      workspaceId: f.id(),
      name: f.shortText(PROJECT_NAME_MAX),
      ownerUserId: f.id().optional(),
      targetDate: dateOnly.optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Create project',
        args: { workspaceId: 'ws_1', name: 'Design review', targetDate: '2026-12-15' },
      },
    ],
  }),
  det({
    id: 'projects.custom_fields.create',
    title: 'Define a project custom field',
    description:
      'Define a custom field every project can carry: a lower_snake_case key, a name and a type (text, number or select; a select lists its options).',
    input: bodyArgs([], {
      key: fieldKey,
      name: f.shortText(ProjectCustomFieldsService.limits.maxNameLength),
      type: z.enum(PROJECT_CUSTOM_FIELD_TYPES),
      options: z
        .array(f.shortText(ProjectCustomFieldsService.limits.maxOptionLength))
        .max(ProjectCustomFieldsService.limits.maxOptions)
        .optional()
        .describe('The choices of a select field'),
    }),
    redact: 'config',
    examples: [
      {
        summary: 'Define a priority select field',
        args: { key: 'priority', name: 'Priority', type: 'select', options: ['Low', 'High'] },
      },
    ],
  }),
  det({
    id: 'projects.custom_fields.delete',
    title: 'Delete project custom fields',
    description: 'Delete project custom fields. Confirm-class: needs your approval before it runs.',
    input: pathOnly('fieldKey'),
    redact: 'config',
    examples: [{ summary: 'Delete project custom fields', args: { fieldKey: 'priority' } }],
  }),
  det({
    id: 'projects.custom_fields.list',
    title: 'List project custom fields',
    description: 'List project custom fields.',
    input: queryArgs(['projectId']),
    redact: 'config',
    examples: [{ summary: 'List project custom fields', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.custom_fields.list.get',
    title: 'Get project custom fields',
    description: 'Get project custom fields.',
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'Get project custom fields', args: {} }],
  }),
  det({
    id: 'projects.custom_fields.set',
    title: 'Set a project custom field value',
    description:
      "Set one custom field's value on a project. The value is always text (a number field takes e.g. '100').",
    input: bodyArgs(['projectId', 'fieldKey'], {
      value: z.string().max(ProjectCustomFieldsService.limits.maxValueLength),
    }),
    redact: 'config',
    examples: [
      {
        summary: 'Set the priority field',
        args: { projectId: 'proj_1', fieldKey: 'priority', value: 'High' },
      },
    ],
  }),
  det({
    id: 'projects.dependencies.create',
    title: 'Create project dependencies',
    description:
      'Record that this project blocks another project (blockedProjectId), with an optional note.',
    input: bodyArgs(['projectId'], {
      blockedProjectId: f.id(),
      note: z.string().max(5000).nullable().optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Create project dependencies',
        args: { projectId: 'proj_1', blockedProjectId: 'proj_2', note: 'Looks good' },
      },
    ],
  }),
  det({
    id: 'projects.dependencies.delete',
    title: 'Delete project dependencies',
    description: 'Delete project dependencies. Confirm-class: needs your approval before it runs.',
    input: pathOnly('projectId', 'blockedProjectId'),
    redact: 'standard',
    examples: [
      {
        summary: 'Delete project dependencies',
        args: { projectId: 'proj_1', blockedProjectId: 'proj_2' },
      },
    ],
  }),
  det({
    id: 'projects.dependencies.list',
    title: 'List project dependencies',
    description: 'List project dependencies.',
    input: listArgs(['projectId'], {}, { cursor: null }),
    redact: 'standard',
    examples: [{ summary: 'List project dependencies', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.favorite.delete',
    title: 'Delete project favorite',
    description: 'Delete project favorite. Confirm-class: needs your approval before it runs.',
    input: pathOnly('projectId'),
    redact: 'standard',
    examples: [{ summary: 'Delete project favorite', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.favorite.list',
    title: 'List project favorite',
    description: 'List project favorite.',
    input: queryArgs(['projectId']),
    redact: 'standard',
    examples: [{ summary: 'List project favorite', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.favorite.set',
    title: 'Set project favorite',
    description: 'Set project favorite.',
    input: bodyArgs(['projectId'], {}),
    redact: 'standard',
    examples: [{ summary: 'Set project favorite', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.favorites.list',
    title: 'List project favorites',
    description: 'List project favorites.',
    input: queryArgs(),
    redact: 'standard',
    examples: [{ summary: 'List project favorites', args: {} }],
  }),
  det({
    id: 'projects.folders.create',
    title: 'Create project folders',
    description: 'Create project folders.',
    input: bodyArgs(['projectId'], { name: f.shortText().optional() }),
    redact: 'standard',
    examples: [
      { summary: 'Create project folders', args: { projectId: 'proj_1', name: 'Design review' } },
    ],
  }),
  det({
    id: 'projects.folders.delete',
    title: 'Delete project folders',
    description: 'Delete project folders. Confirm-class: needs your approval before it runs.',
    input: pathOnly('projectId', 'folderId'),
    redact: 'standard',
    examples: [
      { summary: 'Delete project folders', args: { projectId: 'proj_1', folderId: 'fld_1' } },
    ],
  }),
  det({
    id: 'projects.files.list',
    title: 'List project files',
    description: 'The ready files of a project, newest first.',
    input: queryArgs(['projectId']),
    redact: 'standard',
    examples: [{ summary: 'List project files', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.folders.files.list',
    title: 'List project folders files',
    description: 'List project folders files. Confirm-class: needs your approval before it runs.',
    input: queryArgs(['projectId', 'folderId']),
    redact: 'standard',
    examples: [
      { summary: 'List project folders files', args: { projectId: 'proj_1', folderId: 'fld_1' } },
    ],
  }),
  det({
    id: 'projects.folders.list',
    title: 'List project folders',
    description: 'List project folders. Confirm-class: needs your approval before it runs.',
    input: queryArgs(['projectId']),
    redact: 'standard',
    examples: [{ summary: 'List project folders', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.get',
    title: 'Get project',
    description: 'Get project.',
    input: pathOnly('projectId'),
    redact: 'standard',
    examples: [{ summary: 'Get project', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.health',
    title: 'Health of project',
    description: 'Health of project.',
    input: pathOnly('projectId'),
    redact: 'standard',
    examples: [{ summary: 'Health of project', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.health.get',
    title: 'Get project health',
    description: 'Get project health.',
    input: listArgs([], {}, { cursor: null }),
    redact: 'standard',
    examples: [{ summary: 'Get project health', args: {} }],
  }),
  det({
    id: 'projects.list',
    title: 'List project',
    description: 'List project.',
    input: listArgs([], {}, { cursor: 'after' }),
    redact: 'standard',
    examples: [{ summary: 'List project', args: {} }],
  }),
  det({
    id: 'projects.members.create',
    title: 'Create project members',
    description: 'Create project members. Confirm-class: needs your approval before it runs.',
    input: bodyArgs(['projectId'], { userId: f.id().optional(), role: f.shortText().optional() }),
    redact: 'people',
    examples: [
      {
        summary: 'Create project members',
        args: { projectId: 'proj_1', userId: 'u_1', role: 'editor' },
      },
    ],
  }),
  det({
    id: 'projects.members.delete',
    title: 'Delete project members',
    description: 'Delete project members. Confirm-class: needs your approval before it runs.',
    input: pathOnly('projectId', 'projectMembershipId'),
    redact: 'people',
    examples: [
      {
        summary: 'Delete project members',
        args: { projectId: 'proj_1', projectMembershipId: 'pro_1' },
      },
    ],
  }),
  det({
    id: 'projects.members.list',
    title: 'List project members',
    description: 'List project members. Confirm-class: needs your approval before it runs.',
    input: queryArgs(['projectId']),
    redact: 'people',
    examples: [{ summary: 'List project members', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.members.update',
    title: 'Update project members',
    description: 'Update project members. Confirm-class: needs your approval before it runs.',
    input: bodyArgs(['projectId', 'projectMembershipId'], {
      role: f.shortText().optional(),
      expectedRole: f.shortText().optional(),
    }),
    redact: 'people',
    examples: [
      {
        summary: 'Update project members',
        args: { projectId: 'proj_1', projectMembershipId: 'pro_1', role: 'editor' },
      },
    ],
  }),
  det({
    id: 'projects.milestones.complete.create',
    title: 'Complete project milestones',
    description: 'Complete project milestones.',
    input: bodyArgs(['projectId', 'id'], {}),
    redact: 'standard',
    examples: [
      { summary: 'Complete project milestones', args: { projectId: 'proj_1', id: 'x_1' } },
    ],
  }),
  det({
    id: 'projects.milestones.create',
    title: 'Create project milestones',
    description: 'Create project milestones.',
    input: bodyArgs(['projectId'], {
      title: f.shortText(),
      dueOn: f.iso().nullish(),
      status: f.shortText(40).optional(),
      published: f.bool().optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Create project milestones',
        args: { projectId: 'proj_1', title: 'Design sign-off', dueOn: '2026-12-01' },
      },
    ],
  }),
  det({
    id: 'projects.milestones.links.create',
    title: 'Create project milestones links',
    description: 'Record that this milestone depends on another milestone (dependsOnMilestoneId).',
    input: bodyArgs(['milestoneId'], { dependsOnMilestoneId: f.id() }),
    redact: 'standard',
    examples: [
      {
        summary: 'Create project milestones links',
        args: { milestoneId: 'ms_1', dependsOnMilestoneId: 'ms_2' },
      },
    ],
  }),
  det({
    id: 'projects.milestones.links.delete',
    title: 'Delete project milestones links',
    description:
      'Delete project milestones links. Confirm-class: needs your approval before it runs.',
    input: pathOnly('milestoneId', 'dependsOnMilestoneId'),
    redact: 'standard',
    examples: [
      {
        summary: 'Delete project milestones links',
        args: { milestoneId: 'ms_1', dependsOnMilestoneId: 'ms_2' },
      },
    ],
  }),
  det({
    id: 'projects.milestones.links.list',
    title: 'List project milestones links',
    description: 'List project milestones links.',
    input: listArgs(['milestoneId'], {}, { cursor: null }),
    redact: 'standard',
    examples: [{ summary: 'List project milestones links', args: { milestoneId: 'ms_1' } }],
  }),
  det({
    id: 'projects.milestones.list',
    title: 'List project milestones',
    description: 'List project milestones.',
    input: queryArgs(['projectId']),
    redact: 'standard',
    examples: [{ summary: 'List project milestones', args: { projectId: 'proj_1' } }],
  }),
  // A9: the Milestones list read and "Delete milestone".
  det({
    id: 'projects.milestone_plan.list',
    title: 'List the project milestone plan',
    description: 'Every milestone of a project with what it delivers and its owner.',
    input: queryArgs(['projectId']),
    redact: 'standard',
    examples: [{ summary: 'List the project milestone plan', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.milestones.delete',
    title: 'Delete project milestones',
    description: 'Delete project milestones. Confirm-class: needs your approval before it runs.',
    input: pathOnly('projectId', 'id'),
    redact: 'standard',
    examples: [{ summary: 'Delete project milestones', args: { projectId: 'proj_1', id: 'x_1' } }],
  }),
  det({
    id: 'projects.milestones.update',
    title: 'Update project milestones',
    description:
      "Edit a milestone: give at least one field. Moving a published milestone's committedOn needs clientSafeReason (the client sees it); expectedVersion (from the milestone plan) guards against a concurrent edit.",
    input: atLeastOne(
      bodyArgs(['projectId', 'id'], {
        title: f.shortText(300).optional(),
        dueOn: dateOnly.nullable().optional(),
        published: f.bool().optional(),
        description: z.string().max(2000).nullable().optional(),
        ownerUserId: f.id(36).nullable().optional(),
        committedOn: dateOnly.nullable().optional(),
        forecastOn: dateOnly.nullable().optional(),
        timelineOrder: f.int(0, 1_000_000).nullable().optional(),
        clientTitle: z.string().max(300).nullable().optional(),
        expectedVersion: f.int(1, Number.MAX_SAFE_INTEGER).optional(),
        clientSafeReason: z.string().max(500).nullable().optional(),
      }),
      [
        'title',
        'dueOn',
        'published',
        'description',
        'ownerUserId',
        'committedOn',
        'forecastOn',
        'timelineOrder',
        'clientTitle',
        'clientSafeReason',
      ],
    ),
    redact: 'standard',
    examples: [
      {
        summary: 'Update project milestones',
        args: { projectId: 'proj_1', id: 'x_1', title: 'Design sign-off' },
      },
    ],
  }),
  det({
    id: 'projects.objectives.create',
    title: 'Create project objectives',
    description:
      'Add an objective to the project: a name, and optionally a description, a target (text) and a status.',
    input: bodyArgs(['projectId'], {
      name: f.shortText(300),
      description: f.text(20_000).optional(),
      target: f.shortText(300).optional().describe('What success looks like, e.g. "NPS 50"'),
      status: z.enum(PROJECT_OBJECTIVE_STATUSES).optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Create project objectives',
        args: {
          projectId: 'proj_1',
          name: 'Design review',
          description: 'Short summary',
          status: 'open',
        },
      },
    ],
  }),
  det({
    id: 'projects.objectives.list',
    title: 'List project objectives',
    description: 'List project objectives.',
    input: listArgs(['projectId'], {}, { cursor: null }),
    redact: 'standard',
    examples: [{ summary: 'List project objectives', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.objectives.update',
    title: 'Mark a project objective met or missed',
    description: 'Close an objective as met or missed (the only change the route allows).',
    // The route is `…/projects/:projectId/objectives/:objectiveId`: both ids bind the path (without
    // projectId the request could never be built; AI tamper review 2026-11-23).
    // = projects/project-objectives.controller.ts:TRANSITION_TARGETS
    input: bodyArgs(['projectId', 'objectiveId'], { status: z.enum(['met', 'missed']) }),
    redact: 'standard',
    examples: [
      {
        summary: 'Mark an objective met',
        args: { projectId: 'proj_1', objectiveId: 'obj_1', status: 'met' },
      },
    ],
  }),
  det({
    id: 'projects.phases.create',
    title: 'Create project phases',
    description: 'Add a named phase to the project, optionally at a position (0 first).',
    input: bodyArgs(['projectId'], {
      name: f.shortText(200),
      position: f.int(0, Number.MAX_SAFE_INTEGER).optional(),
    }),
    redact: 'standard',
    examples: [
      { summary: 'Create project phases', args: { projectId: 'proj_1', name: 'Design review' } },
    ],
  }),
  det({
    id: 'projects.phases.list',
    title: 'List project phases',
    description: 'List project phases.',
    input: queryArgs(['projectId']),
    redact: 'standard',
    examples: [{ summary: 'List project phases', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.portal_access_log.list',
    title: 'List project portal access log',
    description: 'List project portal access log.',
    input: listArgs(['projectId'], {}, { cursor: 'before' }),
    redact: 'standard',
    examples: [{ summary: 'List project portal access log', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.portal_settings.list',
    title: 'List project portal settings',
    description: 'List project portal settings.',
    input: queryArgs(['projectId']),
    redact: 'standard',
    examples: [{ summary: 'List project portal settings', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.portal_settings.set',
    title: 'Set project portal settings',
    description: 'Set project portal settings.',
    input: bodyArgs(['projectId'], {
      welcomeMessage: f.text(2000).nullish(),
      accentColor: f.shortText(40).optional(),
      showTeam: f.bool().optional(),
      showTimeline: f.bool().optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Set project portal settings',
        args: { projectId: 'proj_1', welcomeMessage: 'Welcome to the project portal' },
      },
    ],
  }),
  det({
    id: 'projects.portfolio.capacity.list',
    title: 'List project portfolio capacity',
    description: 'List project portfolio capacity.',
    input: queryArgs([], { week: f.shortText(200).optional() }),
    redact: 'standard',
    examples: [{ summary: 'List project portfolio capacity', args: {} }],
  }),
  det({
    id: 'projects.portfolio.list',
    title: 'List project portfolio',
    description: 'List every project with its health; include=burn adds the budget burn.',
    input: listArgs(
      [],
      {
        include: f.shortText(200).optional().describe('Comma-separated extras; supported: burn'),
      },
      { cursor: null },
    ),
    redact: 'standard',
    examples: [{ summary: 'List project portfolio', args: {} }],
  }),
  det({
    id: 'projects.retro_notes.create',
    title: 'Create project retro notes',
    description:
      'Add a retrospective note to the project: what went well, what to improve, or an action; optionally tied to a milestone.',
    input: bodyArgs(['projectId'], {
      category: z.enum(PROJECT_RETRO_NOTE_CATEGORIES),
      body: f.text(20_000),
      milestoneId: f.id().optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Add a went-well note',
        args: {
          projectId: 'proj_1',
          category: 'went_well',
          body: 'Client sign-off came a week early',
          milestoneId: 'ms_1',
        },
      },
    ],
  }),
  det({
    id: 'projects.retro_notes.delete',
    title: 'Delete project retro notes',
    description: 'Delete project retro notes. Confirm-class: needs your approval before it runs.',
    input: pathOnly('projectId', 'noteId'),
    redact: 'standard',
    examples: [
      { summary: 'Delete project retro notes', args: { projectId: 'proj_1', noteId: 'note_1' } },
    ],
  }),
  det({
    id: 'projects.retro_notes.list',
    title: 'List project retro notes',
    description: 'List project retro notes.',
    input: queryArgs(['projectId']),
    redact: 'standard',
    examples: [{ summary: 'List project retro notes', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.risk_register.create',
    title: 'Add an internal project risk',
    description:
      "Add a risk to the project's internal risk register: title, likelihood and impact (low, medium, high), optional mitigation and status.",
    input: bodyArgs(['projectId'], {
      title: f.shortText(300),
      likelihood: z.enum(PROJECT_INTERNAL_RISK_LIKELIHOODS),
      impact: z.enum(PROJECT_INTERNAL_RISK_IMPACTS),
      mitigation: f.text(20_000).optional(),
      status: z.enum(PROJECT_INTERNAL_RISK_STATUSES).optional().describe('Default open'),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Add a vendor-delay risk',
        args: {
          projectId: 'proj_1',
          title: 'Vendor may deliver late',
          likelihood: 'medium',
          impact: 'high',
          mitigation: 'Book a second supplier',
        },
      },
    ],
  }),
  det({
    id: 'projects.risk_register.list',
    title: 'List project risk register',
    description: 'List project risk register.',
    input: listArgs(['projectId'], {}, { cursor: null }),
    redact: 'standard',
    examples: [{ summary: 'List project risk register', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.risk_register.update',
    title: 'Update project risk register',
    description:
      'Change an internal risk: give at least one of title, likelihood, impact, mitigation (null clears it) or status.',
    input: atLeastOne(
      bodyArgs(['riskId'], {
        title: f.shortText(300).optional(),
        likelihood: z.enum(PROJECT_INTERNAL_RISK_LIKELIHOODS).optional(),
        impact: z.enum(PROJECT_INTERNAL_RISK_IMPACTS).optional(),
        mitigation: z.string().max(20_000).nullable().optional(),
        status: z.enum(PROJECT_INTERNAL_RISK_STATUSES).optional(),
      }),
      ['title', 'likelihood', 'impact', 'mitigation', 'status'],
    ),
    redact: 'standard',
    examples: [
      {
        summary: 'Raise a risk to high likelihood',
        args: { riskId: 'risk_1', likelihood: 'high' },
      },
    ],
  }),
  det({
    id: 'projects.risks.create',
    title: 'Create a client-facing project risk',
    description:
      'Record a risk for the client portal: an internal title, the clientSummary the client reads, optional severity, status and internal note. Published (shown to the client) unless published is false.',
    input: bodyArgs(['projectId'], {
      title: f.shortText(300),
      clientSummary: f.text(2000).describe('What the client sees'),
      internalNote: z
        .string()
        .max(5000)
        .nullable()
        .optional()
        .describe('Never shown to the client'),
      severity: z.enum(PROJECT_RISK_SEVERITIES).optional().describe('Default medium'),
      status: z.enum(PROJECT_RISK_STATUSES).optional().describe('Default open'),
      published: f.bool().optional().describe('Default true'),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Record a vendor-delay risk',
        args: {
          projectId: 'proj_1',
          title: 'Vendor delay',
          clientSummary: 'A supplier may deliver a week late; we are lining up a backup.',
        },
      },
    ],
  }),
  det({
    id: 'projects.risks.list',
    title: 'List project risks',
    description: 'List project risks.',
    input: queryArgs(['projectId']),
    redact: 'standard',
    examples: [{ summary: 'List project risks', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.status_updates.create',
    title: 'Create project status updates',
    description:
      'Post an internal status update: a status band (on track, at risk, off track) and the text. Notifies the people involved.',
    input: bodyArgs(['projectId'], {
      statusBand: z.enum(PROJECT_STATUS_BANDS),
      body: f.text(20_000),
    }),
    redact: 'standard',
    notifies: true,
    examples: [
      {
        summary: 'Post an at-risk update',
        args: {
          projectId: 'proj_1',
          statusBand: 'at_risk',
          body: 'Design sign-off slipped a week; launch date holds for now.',
        },
      },
    ],
  }),
  det({
    id: 'projects.status_updates.list',
    title: 'List project status updates',
    description: 'List project status updates.',
    input: listArgs(['projectId'], {}, { cursor: 'before' }),
    redact: 'standard',
    examples: [{ summary: 'List project status updates', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.tags.create',
    title: 'Create project tags',
    description: 'Create project tags.',
    input: bodyArgs([], { name: f.shortText().optional() }),
    redact: 'standard',
    examples: [{ summary: 'Create project tags', args: { name: 'Design review' } }],
  }),
  det({
    id: 'projects.tags.delete',
    title: 'Delete project tags',
    description: 'Delete project tags. Confirm-class: needs your approval before it runs.',
    input: pathOnly('projectId', 'tagId'),
    redact: 'standard',
    examples: [{ summary: 'Delete project tags', args: { projectId: 'proj_1', tagId: 'tag_1' } }],
  }),
  det({
    id: 'projects.tags.list',
    title: 'List project tags',
    description: 'List project tags.',
    input: queryArgs(['projectId']),
    redact: 'standard',
    examples: [{ summary: 'List project tags', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.tags.list.get',
    title: 'Get project tags',
    description: 'Get project tags.',
    input: queryArgs(),
    redact: 'standard',
    examples: [{ summary: 'Get project tags', args: {} }],
  }),
  det({
    id: 'projects.tags.set',
    title: 'Set project tags',
    description: 'Set project tags.',
    input: bodyArgs(['projectId', 'tagId'], {}),
    redact: 'standard',
    examples: [{ summary: 'Set project tags', args: { projectId: 'proj_1', tagId: 'tag_1' } }],
  }),
  det({
    id: 'projects.templates.create',
    title: 'Create project templates',
    description:
      'Save a reusable project template: a name, and optionally a description, default objectives, milestones and work items (each placed offsetDays after the start), client portal on, and a monthly repeat.',
    // Bounds = projects/templates.controller.ts (MAX_NAME_LENGTH, MAX_DEFAULT_OBJECTIVES, ...).
    input: bodyArgs([], {
      name: f.shortText(190),
      description: z.string().max(20_000).optional(),
      defaultObjectives: z.array(f.shortText(300)).max(50).optional(),
      milestones: z
        .array(
          z
            .object({
              title: f.shortText(300),
              offsetDays: f.int(0, 3650).describe('Days after the project start'),
              description: z.string().max(20_000).optional(),
              clientVisible: f.bool().optional(),
            })
            .strict(),
        )
        .max(100)
        .nullable()
        .optional(),
      workItems: z
        .array(
          z
            .object({
              title: f.shortText(300),
              offsetDays: f.int(0, 3650).optional(),
            })
            .strict(),
        )
        .max(200)
        .nullable()
        .optional(),
      clientPortalOn: f.bool().optional(),
      repeatInterval: z.enum(['monthly']).nullable().optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Create a website-build template',
        args: {
          name: 'Website build',
          description: 'Discovery to launch in six weeks',
          milestones: [{ title: 'Design sign-off', offsetDays: 14 }],
          workItems: [{ title: 'Kick-off call', offsetDays: 0 }],
        },
      },
    ],
  }),
  det({
    id: 'projects.templates.instantiate.create',
    title: 'Create a project from a template',
    description:
      "Start a new project from a template in a workspace (workspaceId); optionally a name (default the template's), a start date, a client company and a lead.",
    input: bodyArgs(['templateId'], {
      workspaceId: f.id(),
      name: f.shortText(190).optional(),
      startDate: dateOnly.nullable().optional(),
      clientOrganizationId: f.id(36).nullable().optional(),
      leadUserId: f.id(36).nullable().optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Start a project from a template',
        args: {
          templateId: 'tmpl_1',
          workspaceId: 'ws_1',
          name: 'Acme website',
          startDate: '2026-12-01',
        },
      },
    ],
  }),
  det({
    id: 'projects.journey_steps.list',
    title: 'List client journey steps',
    description: "A project's client journey steps (form, upload, sign, meeting), per client.",
    input: pathOnly('projectId'),
    redact: 'standard',
    examples: [{ summary: 'By project', args: { projectId: 'p_1' } }],
  }),
  det({
    id: 'projects.journey_steps.create',
    title: 'Add a client journey step',
    description:
      'Add a step to a client journey: kind form, upload, sign or meeting; refId links the form, signature request or meeting.',
    input: bodyArgs(['projectId'], {
      clientOrganizationId: f.id(36),
      kind: z.enum(['form', 'upload', 'sign', 'meeting']),
      title: f.shortText(200),
      refId: f.id(36).optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Add a sign step',
        args: { projectId: 'p_1', clientOrganizationId: 'c_1', kind: 'sign', title: 'Sign' },
      },
    ],
  }),
  det({
    id: 'projects.journey_steps.from_template.create',
    title: 'Start a client journey from a template',
    description: "Append an installed pack's journey template to a client's journey on a project.",
    input: bodyArgs(['projectId'], {
      clientOrganizationId: f.id(36),
      packKey: f.id(64),
      templateKey: f.id(64),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Onboarding',
        args: {
          projectId: 'p_1',
          clientOrganizationId: 'c_1',
          packKey: 'agency-client-launch',
          templateKey: 'new-client-onboarding',
        },
      },
    ],
  }),
  det({
    id: 'projects.journey_steps.update',
    title: 'Edit a client journey step',
    description:
      'Rename a client journey step or link it to its form, signature request or meeting.',
    input: bodyArgs(['projectId', 'stepId'], {
      title: f.shortText(200).optional(),
      refId: f.id(36).nullable().optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'Link', args: { projectId: 'p_1', stepId: 's_1', refId: 'm_1' } }],
  }),
  det({
    id: 'projects.journey_steps.delete',
    title: 'Remove a client journey step',
    description: "Remove a step from a client's journey. Confirm-class.",
    input: pathOnly('projectId', 'stepId'),
    redact: 'standard',
    examples: [{ summary: 'Remove', args: { projectId: 'p_1', stepId: 's_1' } }],
  }),
  det({
    id: 'projects.journey_templates.list',
    title: 'List client journey templates',
    description:
      'The client journey templates offered by the template packs this workspace installed.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'All', args: {} }],
  }),
  det({
    id: 'projects.templates.list',
    title: 'List project templates',
    description: 'List project templates.',
    input: listArgs([], {}, { cursor: null }),
    redact: 'standard',
    examples: [{ summary: 'List project templates', args: {} }],
  }),
  det({
    id: 'projects.templates.packs.install.create',
    title: 'Install a project template pack',
    description:
      'Install a built-in template pack: adds its project templates, skipping names already in use.',
    input: bodyArgs(['packKey'], {}),
    redact: 'standard',
    examples: [
      { summary: 'Install a project template pack', args: { packKey: 'monthly-retainer' } },
    ],
  }),
  det({
    id: 'projects.templates.packs.list',
    title: 'List project template packs',
    description:
      'List the built-in project template packs and whether each is installed, optionally only those for one role.',
    input: queryArgs([], { role: z.enum(PACK_ROLES).optional() }),
    redact: 'standard',
    examples: [{ summary: 'List project template packs', args: {} }],
  }),
  det({
    id: 'projects.updates.comments.create',
    title: 'Create project updates comments',
    description: 'Create project updates comments. Notifies the people involved.',
    input: bodyArgs(['projectId', 'updateId'], { body: f.text(MAX_UPDATE_COMMENT_BODY_LENGTH) }),
    redact: 'standard',
    notifies: true,
    examples: [
      {
        summary: 'Create project updates comments',
        args: { projectId: 'proj_1', updateId: 'upd_1', body: 'A note' },
      },
    ],
  }),
  det({
    id: 'projects.updates.comments.list',
    title: 'List project updates comments',
    description: 'List project updates comments.',
    input: queryArgs(['projectId', 'updateId']),
    redact: 'standard',
    examples: [
      {
        summary: 'List project updates comments',
        args: { projectId: 'proj_1', updateId: 'upd_1' },
      },
    ],
  }),
  // A10: the internal updates list.
  det({
    id: 'projects.updates.list',
    title: 'List project updates',
    description: 'List project updates, drafts included.',
    input: queryArgs(['projectId']),
    redact: 'standard',
    examples: [{ summary: 'List project updates', args: { projectId: 'proj_1' } }],
  }),
  det({
    id: 'projects.updates.create',
    title: 'Create project updates',
    description:
      'Post a client-facing project update with a title and body, optionally tied to a milestone. Published unless published is false. Notifies the people involved.',
    input: bodyArgs(['projectId'], {
      title: f.shortText(300),
      body: f.text(),
      published: f.bool().optional().describe('Default true'),
      milestoneId: f.id(36).nullable().optional(),
    }),
    redact: 'standard',
    notifies: true,
    examples: [
      {
        summary: 'Create project updates',
        args: { projectId: 'proj_1', title: 'Draft the Q4 brief', body: 'A note' },
      },
    ],
  }),
  det({
    id: 'projects.updates.unpublish.create',
    title: 'Unpublish project updates',
    description: 'Unpublish project updates.',
    input: bodyArgs(['projectId', 'id'], {}),
    redact: 'standard',
    examples: [{ summary: 'Unpublish project updates', args: { projectId: 'proj_1', id: 'x_1' } }],
  }),
  det({
    id: 'projects.updates.update',
    title: 'Update project updates',
    description:
      'Edit a project update: give at least one of title, body or milestoneId (null unlinks the milestone).',
    input: atLeastOne(
      bodyArgs(['projectId', 'id'], {
        title: f.shortText(300).optional(),
        body: f.text().optional(),
        milestoneId: f.id(36).nullable().optional(),
      }),
      ['title', 'body', 'milestoneId'],
    ),
    redact: 'standard',
    examples: [
      {
        summary: 'Update project updates',
        args: { projectId: 'proj_1', id: 'x_1', title: 'Draft the Q4 brief', body: 'A note' },
      },
    ],
  }),
  det({
    id: 'projects.suggest_due.get',
    title: 'Suggest a due date',
    description:
      'Suggest a due date for new work in a project, from its calendar and dated items. Returns only a date.',
    input: pathOnly('projectId'),
    redact: 'standard',
    examples: [{ summary: 'Suggest a due date', args: { projectId: 'proj_1' } }],
  }),
  // ONEPAGE (B01): the project page in one read. Blocks the caller may not read are absent; the
  // money block needs `finance.view` on the server, hence the `billing` profile.
  det({
    id: 'projects.summary.get',
    title: 'Get a project at a glance',
    description:
      'One project in one read: delivery, approvals waiting and on whom, latest files, time, ' +
      'money (with finance access), risks and milestones. A block you may not read is absent.',
    input: pathOnly('projectId'),
    redact: 'billing',
    examples: [{ summary: 'How is Acme going?', args: { projectId: 'prj_acme' } }],
  }),
];
