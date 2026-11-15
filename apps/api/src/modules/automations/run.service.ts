import { Injectable } from '@nestjs/common';
import { flowIssues, planAutomationFlow } from '@tmanage/domain';
import type { AutomationFlow, ConditionEvent } from '@tmanage/domain';
import type { WorkflowRunDetail } from '../../common/database/schema.js';

/**
 * Automations & integrations (module 17, x163). The pure, deterministic action executor behind a
 * workflow run.
 *
 * ## What executes here, and what does not
 *
 * A template pairs a trigger with an *action kind* (x162's allowlist). Running a template means
 * executing that action. In this slice only **in-app** action kinds run — the ones whose effect is a
 * record inside TManage, with no network egress. The executor is deterministic and self-contained: it
 * produces a `detail` object describing exactly what the action did, and a `succeeded`/`failed`
 * status. It performs no external I/O, so a run cannot email, call a webhook, or reach any third
 * party from here.
 *
 * ## External action kinds are refused, not attempted
 *
 * `send_email_digest` (and any future off-list kind) is an external side-effect. It is **not** run in
 * this slice — the executor records a `failed` run whose detail names the reason, rather than
 * attempting delivery. External delivery is x166 / Needs-Peter. This keeps the security boundary
 * explicit: the only egress a run can have is none.
 *
 * ## Manual runs here, triggered runs in the worker (CQ-12, AUT-01)
 *
 * This service decides "Run it now". A rule firing on its trigger — a request submitted, a work
 * item created or moved, a meeting scheduled, a document published — is run by the relay
 * (`apps/worker/src/consumers/automation-runs.ts`), which notifies the owner of the triggering
 * object and records the same `workflow_runs` row with the same outcome vocabulary.
 */

/** The in-app action kinds a template may name. Anything else records a failed run. */
export const IN_APP_ACTION_KINDS = ['notify_owner', 'create_work_item', 'post_message'] as const;
export type InAppActionKind = (typeof IN_APP_ACTION_KINDS)[number];

/**
 * CQ-12 (AUT-02): the in-app kinds that have a real effect today. `notify_owner` writes an inbox
 * notification. `create_work_item` and `post_message` have no executor yet, so a run of one is
 * recorded as **not run** — before CQ-12 it reported an effect ("Posted an in-app message…")
 * that never happened, which is worse than saying nothing was done.
 */
export const EXECUTABLE_ACTION_KINDS: readonly InAppActionKind[] = ['notify_owner'];

/** The closed set of run outcomes, mirrored by the `workflow_runs.status` allowlist. */
export type WorkflowRunStatus = 'succeeded' | 'failed';

export interface WorkflowRunOutcome {
  readonly status: WorkflowRunStatus;
  readonly detail: WorkflowRunDetail;
  /**
   * Whether the caller must carry out the effect — today only `notify_owner`, whose manual run
   * notifies the person who clicked "Run it now" (the controller writes that row, in the same
   * transaction as the run).
   */
  readonly notifiesRunner: boolean;
}

function isInAppActionKind(kind: string): kind is InAppActionKind {
  return (IN_APP_ACTION_KINDS as readonly string[]).includes(kind);
}

@Injectable()
export class WorkflowRunService {
  /**
   * Decide a manual run's outcome. Pure: no I/O, no randomness, no clock — the timestamps are the
   * database's, assigned when the row is written.
   *
   * A manual run has no triggering object, so there is no "owner" of anything to tell: the test
   * notification goes to the person who ran it, and the detail says so. A kind with no executor,
   * and an external kind, produce a `failed` outcome naming why nothing was done — the run is
   * still recorded, so the refusal is auditable.
   */
  execute(templateId: string, actionKind: string, triggerKind: string): WorkflowRunOutcome {
    const reason = notRunReason(actionKind);
    if (reason !== null) {
      return {
        status: 'failed',
        notifiesRunner: false,
        detail: { templateId, triggerKind, actionKind, outcome: 'not_run', reason },
      };
    }
    return {
      status: 'succeeded',
      notifiesRunner: true,
      detail: {
        templateId,
        triggerKind,
        actionKind,
        outcome: 'executed',
        effect: 'Sent you a test notification in your inbox.',
      },
    };
  }

  /**
   * 58-C1 — decide a manual run of a branching rule: walk the flow in force for `event` (each If
   * takes Yes or No), run each Then on the path with the same executor rules as a linear rule, and
   * log every step. The run succeeds only when every Then on the path ran. An unfinished flow is
   * not run at all.
   */
  executeFlow(
    templateId: string,
    triggerKind: string,
    flowVersion: number,
    flow: AutomationFlow | null,
    event: ConditionEvent,
  ): WorkflowRunOutcome {
    const base = { templateId, triggerKind, flowVersion };
    if (flow === null || flowIssues(flow).length > 0) {
      return {
        status: 'failed',
        notifiesRunner: false,
        detail: { ...base, outcome: 'not_run', reason: 'flow_incomplete', steps: [] },
      };
    }
    const steps = planAutomationFlow(flow, event).map((step) => {
      if (step.type === 'condition') return step;
      const reason = notRunReason(step.actionKind);
      return reason === null
        ? { ...step, outcome: 'executed' as const }
        : { ...step, outcome: 'not_run' as const, reason };
    });
    const actions = steps.flatMap((step) => (step.type === 'action' ? [step] : []));
    const ran = actions.filter((step) => step.outcome === 'executed').length;
    const allRan = actions.length > 0 && ran === actions.length;
    return {
      status: allRan ? 'succeeded' : 'failed',
      notifiesRunner: ran > 0,
      detail: {
        ...base,
        outcome: ran > 0 ? 'executed' : 'not_run',
        ...(ran > 0
          ? { effect: 'Sent you a test notification in your inbox.' }
          : { reason: actions.length === 0 ? 'no_step_on_path' : 'action_not_available_yet' }),
        steps,
      },
    };
  }
}

/** Why an action kind is not run in-app, or `null` when it has an executor. */
function notRunReason(actionKind: string): string | null {
  if (!isInAppActionKind(actionKind)) return 'external_action_not_supported_in_app';
  if (!EXECUTABLE_ACTION_KINDS.includes(actionKind)) return 'action_not_available_yet';
  return null;
}
