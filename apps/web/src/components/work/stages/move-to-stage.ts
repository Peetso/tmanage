import type { WorkItemState } from '@tmanage/domain';
import type { ApiClient } from '../../../lib/api/client';
import { transitionWorkItem, type WorkItemSummary } from '../../../lib/api/work-items';
import { moveWorkToStage, type StageView } from '../../../lib/api/work-stages';
import { autoFacts, movesTo } from './stage-model';

/**
 * Move one work to a stage through the ordinary state moves, so the supervisor rule and the audit
 * trail hold: the moves that need no facts run first, then the stage move carries the facts the
 * last move needs (the ones the screen fills itself, plus `extra` the person typed). `null` when
 * no run of moves reaches the stage's state (a blocked or archived work).
 *
 * One rule for the stage menu on the work page and for a stage chosen in create (W-WEB-3).
 */
export async function moveToStage(
  api: ApiClient,
  organizationSlug: string,
  item: WorkItemSummary,
  stage: StageView,
  extra: Readonly<Record<string, string>> = {},
  now: Date = new Date(),
): Promise<WorkItemSummary | null> {
  const run = movesTo(item.state, stage.stateKey as WorkItemState);
  if (run === null) return null;
  let at = item;
  for (const to of run.before) {
    at = await transitionWorkItem(api, organizationSlug, item.id, { version: at.version, to });
  }
  const { facts } = autoFacts(run.needs, at.ownerUserId, now);
  return moveWorkToStage(api, organizationSlug, item.id, {
    stageId: stage.id,
    version: at.version,
    facts: { ...facts, ...extra },
  });
}
