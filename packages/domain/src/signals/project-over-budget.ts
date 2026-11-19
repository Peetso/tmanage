import { burnOf, isBudgetType } from '../money/burn.js';
import type { SignalFinding } from './signal-finding.js';

/**
 * Rule 4 — **Project over budget** (money): the project's burn (`burnOf`, the same figure the
 * budget screen and the 52-05 burn sweep show) is at least the threshold per cent of its budget.
 * The used figures are the burn sweep's caches, refreshed every 15 minutes.
 */

export interface ProjectBudgetFacts {
  readonly projectId: string;
  readonly budgetType: string;
  readonly budgetMinutes: number | null;
  readonly budgetAmountMinor: number | null;
  readonly usedMinutes: number;
  readonly usedAmountMinor: number;
}

export function evaluateProjectOverBudget(
  facts: ProjectBudgetFacts,
  thresholdPercent: number,
): SignalFinding | null {
  if (!isBudgetType(facts.budgetType)) return null;
  const burn = burnOf({
    type: facts.budgetType,
    budgetMinutes: facts.budgetMinutes,
    budgetAmountMinor: facts.budgetAmountMinor,
    usedMinutes: facts.usedMinutes,
    usedAmountMinor: facts.usedAmountMinor,
  });
  if (burn.percentBp < thresholdPercent * 100) return null;
  return {
    rule: 'project_over_budget',
    subjectType: 'project',
    subjectId: facts.projectId,
    projectId: facts.projectId,
    measure: Math.floor(burn.percentBp / 100),
    threshold: thresholdPercent,
  };
}
