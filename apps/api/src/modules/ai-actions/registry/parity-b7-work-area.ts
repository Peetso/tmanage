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
 */
import type { Capability } from '@tmanage/domain';
import type { AiActionOp, AiScope, HttpMethod, Sensitivity } from './types.js';
import { bodyArgs, det, f, type AiActionDetail } from './detail.js';

const ORG = '/v1/organizations/:orgSlug';

function op(
  id: string,
  method: HttpMethod,
  path: string,
  capability: Capability,
  scope: AiScope,
): AiActionOp {
  const risk = method === 'GET' ? 'read' : 'confirm';
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

export const workAreaOps: readonly AiActionOp[] = [
  op('people.teams.update', 'PATCH', '/people/teams/:id', 'org.manage', M),
];

/** Non-read ops only. */
export const workAreaSensitivity: Readonly<Record<string, Sensitivity>> = {
  'people.teams.update': 'none',
};

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
];
