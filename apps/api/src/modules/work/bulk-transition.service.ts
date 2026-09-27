import type { Principal, WorkItemState } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { WorkItemsService } from './work-items.service.js';

/**
 * x206 — Work bulk status transition (module 7).
 *
 * The largest batch this route accepts in one call. A cap exists so a single request cannot
 * fan out into an unbounded number of reads and transactions — the controller rejects a
 * larger `ids` array with 400 before this service runs, so nothing is read or written for an
 * over-cap request.
 */
export const MAX_BULK_TRANSITION = 100;

/**
 * What became of one id in the batch.
 *
 * - `applied` — the transition ran and the row moved.
 * - `not_found` — the id is not a readable work item in *this* tenant. A foreign-tenant id, a
 *   deleted one, and one the caller may not read all collapse to this, exactly as the
 *   single-item read does, so the batch never discloses that a row exists elsewhere.
 * - `forbidden` — the caller may read the row but not transition it (the row is not active,
 *   for instance). The single-transition guard's 403, per id.
 * - `skipped_invalid` — the move is not one the state machine allows from the row's current
 *   state, or it needs facts this bulk call does not carry (a blocker reason, a completion
 *   time). The single-transition validator's 422, per id.
 * - `conflict` — the row changed under us between the read and the write. The single
 *   transition's optimistic-concurrency 409, per id.
 *
 * Not `View`-suffixed on purpose: only `*View` interfaces are enumerated by the contracts
 * check, and this type is compared structurally through {@link BulkTransitionView}.
 */
export type BulkTransitionOutcome =
  'applied' | 'not_found' | 'forbidden' | 'skipped_invalid' | 'conflict';

/** One id's result. Structurally paired inside {@link BulkTransitionView}; see the note above. */
export interface BulkTransitionItemResult {
  readonly id: string;
  readonly outcome: BulkTransitionOutcome;
  /** A human-readable reason for a non-applied outcome; `null` when applied. */
  readonly reason: string | null;
}

/**
 * The batch's answer: the target every id was asked to reach, a per-id outcome for each, and
 * how many actually moved. Deliberately *not* all-or-nothing — a mixed batch reports each id's
 * fate rather than failing the whole call, which is what a multi-select "mark done" needs.
 */
export interface BulkTransitionView {
  readonly targetStatus: WorkItemState;
  readonly results: readonly BulkTransitionItemResult[];
  readonly appliedCount: number;
}

/**
 * The bulk transition, built on the single-item path rather than beside it.
 *
 * The one rule this slice must not break: every id is tenant-scoped and validated by the
 * *same* machine the single route uses. It gets that for free by calling
 * {@link WorkItemsService.transition} per id — the method that reads the row inside the tenant
 * (a foreign id reads as absent → 404 → `not_found`, never a 500), authorizes `work.transition`
 * against the row, and asks the state machine whether the move is legal. There is no divergent
 * bulk path that could skip a guard, because there is no bulk path: this composes the one that
 * already exists.
 */
export class BulkTransitionService {
  constructor(private readonly workItems: WorkItemsService) {}

  async apply(
    context: TenantContext,
    principal: Principal,
    ids: readonly string[],
    targetStatus: WorkItemState,
  ): Promise<BulkTransitionView> {
    const results: BulkTransitionItemResult[] = [];
    let appliedCount = 0;

    for (const id of ids) {
      try {
        // Read the row inside the tenant to learn the version the transition must present.
        // A foreign, deleted, or unreadable id throws 404 here and is reported `not_found`
        // *before* any write is attempted for it.
        const current = await this.workItems.get(context, principal, id);
        // No facts: a bulk status change carries no blocker reason or completion time, so a
        // move that requires them is refused by the machine (422 → `skipped_invalid`) rather
        // than guessed at here.
        await this.workItems.transition(context, principal, id, current.version, targetStatus, {});
        results.push({ id, outcome: 'applied', reason: null });
        appliedCount += 1;
      } catch (error) {
        if (error instanceof ApiError) {
          const outcome = outcomeForStatus(error.status);
          if (outcome) {
            results.push({ id, outcome, reason: error.message });
            continue;
          }
        }
        // Anything the single path did not raise as one of its known refusals is a genuine
        // fault, not a per-id outcome — let it surface rather than swallow it into the batch.
        throw error;
      }
    }

    return { targetStatus, results, appliedCount };
  }
}

function outcomeForStatus(status: number): Exclude<BulkTransitionOutcome, 'applied'> | undefined {
  switch (status) {
    case 404:
      return 'not_found';
    case 403:
      return 'forbidden';
    case 409:
      return 'conflict';
    case 422:
      return 'skipped_invalid';
    default:
      return undefined;
  }
}
