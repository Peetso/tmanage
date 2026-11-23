/**
 * AI action registry — batch 7, lane WA "work area" (owner, 2026-11-23: a supervisor on a work,
 * several workers, steps inside a work, a client tag from the start, renamable stages and own
 * stage sets, teams you can create, rename and delete; ADR-0015 part 1 rule 4: what a member can
 * do by hand, the AI can do).
 *
 * The create / update / list changes of `work_items.*` (doers, supervisors, watchers, client
 * companies and first steps at create; `teamId` on the list) are fields of existing ops, so they
 * live in those ops' details in `work.ts`. This file holds the ops for the routes that are new:
 *
 * - Teams: rename (`people.teams.update`), manage scope like the other team writes.
 * - Stage sets (D1, 0413): list / get / create / update / delete a set, add / change / delete /
 *   reorder its stages, read and set a project's set, give one work its own set, and move a work
 *   to a stage (`work_items.stage.set`, write scope like a transition, with the same confirm
 *   card when the work is visible to a client).
 *
 * Risk follows the registry's convention: reads run at once, everyday edits are `write`, deletes
 * are `confirm` and `destructive`.
 */
import { z } from 'zod';
import type { Capability } from '@tmanage/domain';
import type { AiActionOp, AiScope, HttpMethod, Sensitivity } from './types.js';
import {
  atLeastOne,
  bodyArgs,
  det,
  f,
  pathOnly,
  queryArgs,
  type AiActionDetail,
} from './detail.js';

const ORG = '/v1/organizations/:orgSlug';

function op(
  id: string,
  method: HttpMethod,
  path: string,
  capability: Capability,
  scope: AiScope,
): AiActionOp {
  const risk = method === 'GET' ? 'read' : method === 'DELETE' ? 'confirm' : 'write';
  return {
    id,
    method,
    path: `${ORG}${path}`,
    capability,
    risk,
    scope: risk === 'read' ? 'read' : scope,
  };
}

const M = 'manage' as const;
const W = 'write' as const;
const SETS = '/work/stage-sets';

export const workAreaOps: readonly AiActionOp[] = [
  op('people.teams.update', 'PATCH', '/people/teams/:id', 'org.manage', M),
  op('work.stage_sets.list', 'GET', SETS, 'work.read', M),
  op('work.stage_sets.get', 'GET', `${SETS}/:stageSetId`, 'work.read', M),
  op('work.stage_sets.create', 'POST', SETS, 'project.manage', M),
  op('work.stage_sets.update', 'PATCH', `${SETS}/:stageSetId`, 'project.manage', M),
  op('work.stage_sets.delete', 'DELETE', `${SETS}/:stageSetId`, 'project.manage', M),
  op('work.stages.create', 'POST', `${SETS}/:stageSetId/stages`, 'project.manage', M),
  op('work.stages.update', 'PATCH', `${SETS}/:stageSetId/stages/:stageId`, 'project.manage', M),
  op('work.stages.delete', 'DELETE', `${SETS}/:stageSetId/stages/:stageId`, 'project.manage', M),
  op('work.stages.reorder', 'PUT', `${SETS}/:stageSetId/stages/order`, 'project.manage', M),
  op('projects.stage_set.get', 'GET', '/projects/:projectId/stage-set', 'work.read', M),
  op('projects.stage_set.set', 'PUT', '/projects/:projectId/stage-set', 'project.manage', M),
  op('work_items.stage_set.set', 'PUT', '/work-items/:workItemId/stage-set', 'work.update', W),
  {
    ...op('work_items.stage.set', 'PUT', '/work-items/:workItemId/stage', 'work.update', W),
    // Like work_items.transitions.create: the client sees the work's progress.
    confirmWhenStored: {
      resource: 'work_item',
      param: 'workItemId',
      field: 'audience',
      notIn: ['internal'],
    },
  },
];

/** Non-read ops only. */
export const workAreaSensitivity: Readonly<Record<string, Sensitivity>> = {
  'people.teams.update': 'none',
  'work.stage_sets.create': 'none',
  'work.stage_sets.update': 'none',
  'work.stage_sets.delete': 'destructive',
  'work.stages.create': 'none',
  'work.stages.update': 'none',
  'work.stages.delete': 'destructive',
  'work.stages.reorder': 'none',
  'projects.stage_set.set': 'none',
  'work_items.stage_set.set': 'none',
  'work_items.stage.set': 'none',
};

const STATE = z.enum(['backlog', 'ready', 'in_progress', 'internal_review', 'done']);
const COLOR = z.enum([
  'neutral',
  'blue',
  'teal',
  'green',
  'amber',
  'orange',
  'red',
  'purple',
  'pink',
]);
const STAGE = z
  .object({ name: f.shortText(120), stateKey: STATE, colorKey: COLOR.nullable().optional() })
  .strict();

const SET_RULES =
  'A set needs at least one "Not started" stage (backlog or ready), at least one "In progress" ' +
  'stage and exactly one "Done" stage; "In review" (internal_review) is optional.';

export const workAreaDetails: readonly AiActionDetail[] = [
  det({
    id: 'people.teams.update',
    title: 'Rename a team',
    description:
      'Give a team (the id people.teams.list gives) a new name, unique in the workspace. ' +
      'Owners/admins only.',
    input: bodyArgs(['id'], { name: f.shortText(120) }),
    redact: 'people',
    examples: [{ summary: 'Rename', args: { id: 'team_1', name: 'Brand design' } }],
  }),
  det({
    id: 'work.stage_sets.list',
    title: 'List stage sets',
    description:
      'The workspace’s stage sets with their stages in order. Each stage has a name and the ' +
      'state it sits in (stateKey) and its group (not_started, in_progress, in_review, done). ' +
      'A workspace with no sets uses built-in stages (see projects.stage_set.get).',
    input: queryArgs(),
    redact: 'standard',
    examples: [{ summary: 'List', args: {} }],
  }),
  det({
    id: 'work.stage_sets.get',
    title: 'Get a stage set',
    description: 'One stage set with its stages in order.',
    input: pathOnly('stageSetId'),
    redact: 'standard',
    examples: [{ summary: 'Get', args: { stageSetId: 'set_1' } }],
  }),
  det({
    id: 'work.stage_sets.create',
    title: 'Create a stage set',
    description:
      'Make a set of named stages. Without projectId it is a workspace set (owners/admins); with ' +
      'projectId it is that project’s own set and the project starts using it (its managers). ' +
      'isDefault makes a workspace set the default for every project without its own. stages in ' +
      `order; omitted = a copy of the built-in stages. ${SET_RULES}`,
    input: bodyArgs([], {
      name: f.shortText(120),
      projectId: f.id().optional(),
      isDefault: f.bool().optional(),
      stages: z.array(STAGE).min(1).max(30).optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Design thinking stages for one project',
        args: {
          name: 'Design thinking',
          projectId: 'prj_1',
          stages: [
            { name: 'Brief', stateKey: 'ready' },
            { name: 'Concept', stateKey: 'in_progress' },
            { name: 'Design', stateKey: 'in_progress' },
            { name: 'Client review', stateKey: 'internal_review' },
            { name: 'Delivered', stateKey: 'done' },
          ],
        },
      },
    ],
  }),
  det({
    id: 'work.stage_sets.update',
    title: 'Rename a stage set or make it the default',
    description:
      'Rename a set, or make a workspace set the default (isDefault true) or stop it being the ' +
      'default (false). version is the set’s version from work.stage_sets.get.',
    input: bodyArgs(['stageSetId'], {
      version: f.int(),
      name: f.shortText(120).optional(),
      isDefault: f.bool().optional(),
    }),
    redact: 'standard',
    examples: [
      { summary: 'Rename', args: { stageSetId: 'set_1', version: 3, name: 'Agency flow' } },
    ],
  }),
  det({
    id: 'work.stage_sets.delete',
    title: 'Delete a stage set',
    description:
      'Delete a set no other project and no work uses (refused otherwise). Works on its stages ' +
      'fall back to the stages that take over.',
    input: pathOnly('stageSetId'),
    redact: 'standard',
    examples: [{ summary: 'Delete', args: { stageSetId: 'set_1' } }],
  }),
  det({
    id: 'work.stages.create',
    title: 'Add a stage',
    description: `Add a stage to a set, at position (0 = first) or at the end. ${SET_RULES}`,
    input: bodyArgs(['stageSetId'], {
      name: f.shortText(120),
      stateKey: STATE,
      colorKey: COLOR.nullable().optional(),
      position: f.int(0, 30).optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Add Client review',
        args: { stageSetId: 'set_1', name: 'Client review', stateKey: 'internal_review' },
      },
    ],
  }),
  det({
    id: 'work.stages.update',
    title: 'Rename or change a stage',
    description:
      'Rename a stage, change its colour, or move it to another state group (refused while works ' +
      `are on it). ${SET_RULES}`,
    input: atLeastOne(
      bodyArgs(['stageSetId', 'stageId'], {
        name: f.shortText(120).optional(),
        stateKey: STATE.optional(),
        colorKey: COLOR.nullable().optional(),
      }),
      ['name', 'stateKey', 'colorKey'],
    ),
    redact: 'standard',
    examples: [
      { summary: 'Rename', args: { stageSetId: 'set_1', stageId: 'stg_1', name: 'Concept' } },
    ],
  }),
  det({
    id: 'work.stages.delete',
    title: 'Delete a stage',
    description:
      'Delete a stage. Works on it move to moveToStageId (a stage of the same set with the same ' +
      `state) or to the first stage of their state. ${SET_RULES}`,
    input: queryArgs(['stageSetId', 'stageId'], { moveToStageId: f.id().optional() }),
    redact: 'standard',
    examples: [{ summary: 'Delete', args: { stageSetId: 'set_1', stageId: 'stg_2' } }],
  }),
  det({
    id: 'work.stages.reorder',
    title: 'Reorder stages',
    description: 'Put a set’s stages in a new order. stageIds lists every stage of the set once.',
    input: bodyArgs(['stageSetId'], { stageIds: z.array(f.id()).min(1).max(30) }),
    redact: 'standard',
    examples: [
      { summary: 'Reorder', args: { stageSetId: 'set_1', stageIds: ['stg_2', 'stg_1', 'stg_3'] } },
    ],
  }),
  det({
    id: 'projects.stage_set.get',
    title: 'Get the stages a project uses',
    description:
      'The stage set a project uses and where it comes from (project, workspace or builtin). ' +
      'These are the board columns of the project.',
    input: pathOnly('projectId'),
    redact: 'standard',
    examples: [{ summary: 'Get', args: { projectId: 'prj_1' } }],
  }),
  det({
    id: 'projects.stage_set.set',
    title: 'Choose the stages a project uses',
    description:
      'Point a project at a stage set (a workspace set or its own), or null for the workspace’s ' +
      'stages. Refused when works in review would have no "In review" stage.',
    input: bodyArgs(['projectId'], { stageSetId: f.id().nullable() }),
    redact: 'standard',
    examples: [{ summary: 'Use a set', args: { projectId: 'prj_1', stageSetId: 'set_1' } }],
  }),
  det({
    id: 'work_items.stage_set.set',
    title: 'Use different stages for one work',
    description:
      'Give one work item its own stage set, or null for its project’s. version is the item’s ' +
      'version from work_items.get.',
    input: bodyArgs(['workItemId'], { stageSetId: f.id().nullable(), version: f.int() }),
    redact: 'standard',
    examples: [
      { summary: 'Own set', args: { workItemId: 'wi_1', stageSetId: 'set_2', version: 4 } },
    ],
  }),
  det({
    id: 'work_items.stage.set',
    title: 'Move a work item to a stage',
    description:
      'Move a work item to a stage of the set it uses (stage ids from projects.stage_set.get). ' +
      'A stage in another state runs the same move as work_items.transitions.create, so the same ' +
      'facts apply (e.g. done needs ownerId and completedAt, and a supervised work is completed ' +
      'by its supervisor). version is the item’s version from work_items.get.',
    input: bodyArgs(['workItemId'], {
      stageId: f.id(),
      version: f.int(),
      facts: f.config().optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'Move', args: { workItemId: 'wi_1', stageId: 'stg_3', version: 4 } }],
  }),
];
