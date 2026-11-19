import {
  UNUSUAL_EXPENSE_BASELINE_DAYS,
  capacityMinutesUntil,
  evaluateApprovalWaitingOnClient,
  evaluateApprovedTimeNotInvoiced,
  evaluateDeadlineAtRisk,
  evaluateOverdueInvoice,
  evaluateOverloadedPerson,
  evaluateProjectOverBudget,
  evaluateStaleTask,
  evaluateUnusualExpense,
  isOpenWorkState,
  mayRaiseSignal,
  plannedMinutesThisWeek,
  queuedMinutesByItem,
  resolveSignalSettings,
  utcDate,
  wholeDaysBetween,
} from '@tmanage/domain';
import type {
  ApprovalWaitFacts,
  OverdueInvoiceFacts,
  ProjectBudgetFacts,
  SignalFinding,
  SignalRuleKey,
  SignalRuleSetting,
  StoredSignalSetting,
  UninvoicedTimeFacts,
} from '@tmanage/domain';
import type { SweepLock } from '../common/database/sweep-lock.js';
import type { WorkerFlag } from '../common/database/feature-flag-store.js';

/**
 * 62-27 + 62-A1a (B05) — the signals sweep, once an hour.
 *
 * For each live organization whose `business_briefing` flag resolves on, the store reads the facts
 * the eight rules need (bounded, bound SQL), this module runs the rules — pure, in
 * `packages/domain/src/signals/`, no model call anywhere — and the store files each finding in
 * `work_signals`, at most one per subject per 24 hours. A finding whose rule is on also writes one
 * `work_signal.raised.v1` outbox event in the same transaction; the notice consumer
 * (`consumers/work-signal-notice.ts`) tells the people the owner chose, resolved at delivery. A
 * rule that is off still files its signal (the Home briefing shows it) and sends nothing.
 *
 * Every time is the `now` the run is given; nothing reads the database clock.
 * The SQL lives in `common/database/signals-store.ts`.
 */

export const SIGNALS_SWEEP_INTERVAL_MS = 60 * 60_000;
export const SIGNALS_ORGANIZATIONS_PER_RUN = 500;
export const SIGNALS_SWEEP_LOCK = 'signals-sweeper';
export const BUSINESS_BRIEFING_FLAG: WorkerFlag = { key: 'business_briefing', codeDefault: false };
export const WORK_SIGNAL_RAISED_EVENT = 'work_signal.raised.v1';

/** An open work item as the deadline, overload and stale rules read it. */
export interface WorkItemSignalFacts {
  readonly workItemId: string;
  readonly projectId: string;
  readonly state: string;
  readonly dueAt: Date | null;
  readonly updatedAt: Date;
  readonly ownerUserId: string | null;
  readonly estimateMinutes: number | null;
  readonly loggedMinutes: number;
}

export interface CapacitySignalFacts {
  readonly membershipId: string;
  readonly userId: string;
  readonly weeklyMinutes: number;
}

export interface ExpenseSignalFacts {
  readonly expenseId: string;
  readonly projectId: string | null;
  readonly state: string;
  readonly spentOn: string;
  readonly category: string;
  readonly amountBaseMinor: number;
}

/** Everything one organization's rules read, as the store gathered it at `now`. */
export interface OrganizationSignalFacts {
  readonly workItems: readonly WorkItemSignalFacts[];
  readonly capacities: readonly CapacitySignalFacts[];
  readonly invoices: readonly OverdueInvoiceFacts[];
  readonly budgets: readonly ProjectBudgetFacts[];
  readonly expenses: readonly ExpenseSignalFacts[];
  readonly approvals: readonly ApprovalWaitFacts[];
  readonly uninvoicedTime: readonly UninvoicedTimeFacts[];
}

/** One finding to file, with whether its rule sends a notice. */
export interface SignalToFile extends SignalFinding {
  readonly notify: boolean;
}

export interface SignalsSweepStore {
  /** Live organizations with the flag on, at most `limit`. */
  organizations(limit: number): Promise<readonly string[]>;
  settings(organizationId: string): Promise<readonly StoredSignalSetting[]>;
  facts(organizationId: string, now: Date): Promise<OrganizationSignalFacts>;
  /** When each `(rule, subject)` was last raised within the dedupe window before `now`. */
  lastRaised(organizationId: string, now: Date): Promise<ReadonlyMap<string, Date>>;
  /** File the signals (and the outbox events of those that notify) in one transaction. */
  file(organizationId: string, signals: readonly SignalToFile[], now: Date): Promise<number>;
}

const remainingOf = (item: WorkItemSignalFacts): number =>
  item.estimateMinutes === null ? 0 : Math.max(0, item.estimateMinutes - item.loggedMinutes);

/** Pure: every rule over one organization's facts with its settings. Catalogue order. */
export function evaluateOrganization(
  facts: OrganizationSignalFacts,
  settings: Readonly<Record<SignalRuleKey, SignalRuleSetting>>,
  now: Date,
): readonly SignalFinding[] {
  const findings: (SignalFinding | null)[] = [];
  const open = facts.workItems.filter((item) => isOpenWorkState(item.state));
  const weeklyByUser = new Map(facts.capacities.map((c) => [c.userId, c.weeklyMinutes]));

  // 1 — deadline at risk: each owner's queue in due order against their capacity.
  const dated = open.filter(
    (item): item is WorkItemSignalFacts & { dueAt: Date } => item.dueAt !== null,
  );
  const queues = new Map<string, ReturnType<typeof queuedMinutesByItem>>();
  for (const owner of new Set(dated.map((item) => item.ownerUserId ?? ''))) {
    const mine = dated.filter((item) => (item.ownerUserId ?? '') === owner);
    queues.set(
      owner,
      queuedMinutesByItem(mine.map((item) => ({ ...item, remainingMinutes: remainingOf(item) }))),
    );
  }
  for (const item of dated) {
    const owner = item.ownerUserId;
    const weekly = owner === null ? undefined : weeklyByUser.get(owner);
    findings.push(
      evaluateDeadlineAtRisk(
        {
          workItemId: item.workItemId,
          projectId: item.projectId,
          state: item.state,
          dueAt: item.dueAt,
          remainingMinutes: remainingOf(item),
          queuedMinutes:
            owner === null ? remainingOf(item) : (queues.get(owner)?.get(item.workItemId) ?? 0),
          capacityMinutesUntilDue:
            owner === null ? null : capacityMinutesUntil(weekly ?? 0, now, item.dueAt),
        },
        settings.deadline_at_risk.threshold,
        now,
      ),
    );
  }

  // 2 — overloaded person.
  for (const capacity of facts.capacities) {
    const theirs = open
      .filter((item) => item.ownerUserId === capacity.userId)
      .map((item) => ({
        state: item.state,
        dueAt: item.dueAt,
        remainingMinutes: remainingOf(item),
      }));
    findings.push(
      evaluateOverloadedPerson(
        {
          membershipId: capacity.membershipId,
          weeklyCapacityMinutes: capacity.weeklyMinutes,
          plannedMinutes: plannedMinutesThisWeek(theirs, now),
        },
        settings.overloaded_person.threshold,
      ),
    );
  }

  // 3, 4 — overdue invoice, project over budget.
  for (const invoice of facts.invoices) {
    findings.push(evaluateOverdueInvoice(invoice, settings.overdue_invoice.threshold, now));
  }
  for (const budget of facts.budgets) {
    findings.push(evaluateProjectOverBudget(budget, settings.project_over_budget.threshold));
  }

  // 5 — stale task.
  for (const item of open) {
    findings.push(evaluateStaleTask(item, settings.stale_task.threshold, now));
  }

  // 6 — unusual expense: against the same category's other spends in the 90 days before it.
  const byCategory = new Map<string, ExpenseSignalFacts[]>();
  for (const expense of facts.expenses) {
    byCategory.set(expense.category, [...(byCategory.get(expense.category) ?? []), expense]);
  }
  for (const expense of facts.expenses) {
    const spent = utcDate(expense.spentOn);
    if (spent === null) continue;
    const baseline = (byCategory.get(expense.category) ?? [])
      .filter((other) => other.expenseId !== expense.expenseId)
      .filter((other) => {
        const day = utcDate(other.spentOn);
        if (day === null) return false;
        const before = wholeDaysBetween(day, spent);
        return before >= 0 && before <= UNUSUAL_EXPENSE_BASELINE_DAYS;
      })
      .map((other) => other.amountBaseMinor);
    findings.push(
      evaluateUnusualExpense(
        { ...expense, baselineAmountsBaseMinor: baseline },
        settings.unusual_expense.threshold,
        now,
      ),
    );
  }

  // 7, 8 — approval waiting on the client, approved time not invoiced.
  for (const approval of facts.approvals) {
    findings.push(
      evaluateApprovalWaitingOnClient(approval, settings.approval_waiting_on_client.threshold, now),
    );
  }
  for (const time of facts.uninvoicedTime) {
    findings.push(
      evaluateApprovedTimeNotInvoiced(time, settings.approved_time_not_invoiced.threshold, now),
    );
  }

  return findings.filter((finding): finding is SignalFinding => finding !== null);
}

/** The `lastRaised` map key of one subject under one rule. */
export function subjectKey(rule: string, subjectId: string): string {
  return `${rule}:${subjectId}`;
}

/**
 * Pure: which findings to file now — each subject at most once per rule, and only when its last
 * signal is at least 24 hours old — each marked with whether its rule sends notices.
 */
export function signalsToFile(
  findings: readonly SignalFinding[],
  settings: Readonly<Record<SignalRuleKey, SignalRuleSetting>>,
  lastRaised: ReadonlyMap<string, Date>,
  now: Date,
): readonly SignalToFile[] {
  const seen = new Set<string>();
  const out: SignalToFile[] = [];
  for (const finding of findings) {
    const key = subjectKey(finding.rule, finding.subjectId);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!mayRaiseSignal(lastRaised.get(key) ?? null, now)) continue;
    out.push({ ...finding, notify: settings[finding.rule].enabled });
  }
  return out;
}

export interface SignalsSweepResult {
  readonly organizations: number;
  readonly filed: number;
  readonly failed: number;
}

/** One run. One organization's failure is counted and does not stop the others. */
export async function runSignalsSweep(deps: {
  readonly store: SignalsSweepStore;
  readonly now: Date;
  readonly onError?: (error: unknown) => void;
}): Promise<SignalsSweepResult> {
  const { store, now } = deps;
  let filed = 0;
  let failed = 0;
  const organizations = await store.organizations(SIGNALS_ORGANIZATIONS_PER_RUN);
  for (const organizationId of organizations) {
    try {
      const settings = resolveSignalSettings(await store.settings(organizationId));
      const findings = evaluateOrganization(await store.facts(organizationId, now), settings, now);
      const toFile = signalsToFile(
        findings,
        settings,
        await store.lastRaised(organizationId, now),
        now,
      );
      filed += toFile.length === 0 ? 0 : await store.file(organizationId, toFile, now);
    } catch (error) {
      failed += 1;
      deps.onError?.(error);
    }
  }
  return { organizations: organizations.length, filed, failed };
}

/**
 * Loop mode: one run every {@link SIGNALS_SWEEP_INTERVAL_MS}; stops on `signal`. With a `lock`
 * each run takes the {@link SIGNALS_SWEEP_LOCK} named lock, and a run another process holds is
 * skipped silently (the activity-projector and audit-anchor shape).
 */
export async function runSignalsSweepLoop(
  deps: { readonly store: SignalsSweepStore; readonly lock?: Pick<SweepLock, 'run'> },
  signal: AbortSignal,
  onError: (error: unknown) => void = (error) =>
    console.error('[worker] signals sweep failed', error),
): Promise<void> {
  const pass = () => runSignalsSweep({ store: deps.store, now: new Date(), onError });
  while (!signal.aborted) {
    try {
      if (deps.lock) await deps.lock.run(SIGNALS_SWEEP_LOCK, pass);
      else await pass();
    } catch (error) {
      onError(error);
    }
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SIGNALS_SWEEP_INTERVAL_MS);
      signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
    });
  }
}
