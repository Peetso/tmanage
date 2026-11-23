/**
 * AI action details — parity pass, owner 2026-11-23: "both [the external MCP and the in-app AI]
 * should do whatever the account has the right to do".
 *
 * Routes that were withheld in `NEVER` without a reason the exclusion rule accepts (sign-in,
 * sessions and token issuance; the AI approving its own actions; raw secrets; routes that are no
 * account's action) become ops here, batch by batch. The route-by-route table and the batches
 * still to convert are in `work/pass-2026-11-23/AI-MCP-PARITY-AUDIT.md`. What a member can reach
 * is still decided by their own capabilities and the grant's scopes, and every change goes
 * through the confirm card (manage and confirm-class ops always).
 *
 * Batch 1 — `work_planning` (53-21 iteration writes). Inputs mirror `iterations.validate.ts`.
 */
import { z } from 'zod';
import {
  MAX_ITERATION_GOAL_LENGTH,
  MAX_ITERATION_ITEMS_PER_CALL,
  MAX_ITERATION_NAME_LENGTH,
} from '@tmanage/domain';
import { bodyArgs, det, f, type AiActionDetail } from './detail.js';
import { securityDetails } from './parity-b2-security.js';
import { filesDetails } from './parity-b2-files.js';
import { workDetails } from './parity-b2-work.js';
import { lifecycleDetails } from './parity-b4-lifecycle.js';
import { timeTrustDetails } from './parity-b5-time-trust.js';
import { profilePhotoDetails } from './parity-b6-profile-photo.js';
import { workAreaDetails } from './parity-b7-work-area.js';

const day = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const itemIds = () => z.array(f.id()).max(MAX_ITERATION_ITEMS_PER_CALL).optional();

export const parityDetails: readonly AiActionDetail[] = [
  det({
    id: 'iterations.create',
    title: 'Create an iteration',
    description:
      'Add a sprint (iteration) to a project: a name, an optional goal, and both dates ' +
      '(YYYY-MM-DD) or neither.',
    input: bodyArgs(['projectId'], {
      name: f.shortText(MAX_ITERATION_NAME_LENGTH),
      goal: z.string().max(MAX_ITERATION_GOAL_LENGTH).nullish(),
      startsOn: day().optional(),
      endsOn: day().optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Two-week sprint',
        args: { projectId: 'pr_1', name: 'Sprint 4', startsOn: '2026-12-01', endsOn: '2026-12-14' },
      },
    ],
  }),
  det({
    id: 'iterations.settings.set',
    title: 'Switch story points for a project',
    description: 'Turn story points on or off for one project.',
    input: bodyArgs(['projectId'], { pointsEnabled: f.bool() }),
    redact: 'standard',
    examples: [{ summary: 'Points on', args: { projectId: 'pr_1', pointsEnabled: true } }],
  }),
  det({
    id: 'iterations.update',
    title: 'Edit an iteration',
    description:
      'Rename a sprint, change its goal or dates. expectedVersion is the version last read ' +
      '(iterations.get); a stale version is refused.',
    input: bodyArgs(['iterationId'], {
      name: f.shortText(MAX_ITERATION_NAME_LENGTH),
      goal: z.string().max(MAX_ITERATION_GOAL_LENGTH).nullish(),
      startsOn: day(),
      endsOn: day(),
      expectedVersion: f.int(1),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Move the end date',
        args: {
          iterationId: 'it_1',
          name: 'Sprint 4',
          startsOn: '2026-12-01',
          endsOn: '2026-12-16',
          expectedVersion: 2,
        },
      },
    ],
  }),
  det({
    id: 'iterations.items.move',
    title: 'Move work items into or out of an iteration',
    description: 'Add work items to a sprint and/or take them out (ids in add and remove).',
    input: bodyArgs(['iterationId'], { add: itemIds(), remove: itemIds() }),
    redact: 'standard',
    examples: [{ summary: 'Add two', args: { iterationId: 'it_1', add: ['wi_1', 'wi_2'] } }],
  }),
  det({
    id: 'iterations.complete',
    title: 'Complete an iteration',
    description:
      'Close a sprint. Unfinished items move to moveUnfinishedTo (another iteration id) or ' +
      'stay unplanned when it is null. Confirm-class: it re-plans many items at once.',
    input: bodyArgs(['iterationId'], { moveUnfinishedTo: f.id().nullish() }),
    redact: 'standard',
    examples: [{ summary: 'Roll over', args: { iterationId: 'it_1', moveUnfinishedTo: 'it_2' } }],
  }),
];

/**
 * Every op id whose detail lives in a parity batch file. The wave A/B/C slice tests key off op-id
 * prefixes and leave these to `parity-2026-11-23.test.ts` and `parity-b2.test.ts`.
 */
export const PARITY_DETAIL_IDS: ReadonlySet<string> = new Set(
  [
    ...parityDetails,
    ...securityDetails,
    ...filesDetails,
    ...workDetails,
    // Batch 4 (fix lane C): lifecycle removals, the workspace file list, inline files, AI settings.
    ...lifecycleDetails,
    // Batch 5 (lane T): time you can trust.
    ...timeTrustDetails,
    ...profilePhotoDetails,
    // Batch 7 (lane WA): the work area.
    ...workAreaDetails,
  ].map((d) => d.id),
);
