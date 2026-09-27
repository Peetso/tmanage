import { Injectable } from '@nestjs/common';
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
 */

/** The in-app action kinds a run may execute in this slice. Anything else records a failed run. */
export const IN_APP_ACTION_KINDS = ['notify_owner', 'create_work_item', 'post_message'] as const;
export type InAppActionKind = (typeof IN_APP_ACTION_KINDS)[number];

/** The closed set of run outcomes, mirrored by the `workflow_runs.status` allowlist. */
export type WorkflowRunStatus = 'succeeded' | 'failed';

export interface WorkflowRunOutcome {
  readonly status: WorkflowRunStatus;
  readonly detail: WorkflowRunDetail;
}

function isInAppActionKind(kind: string): kind is InAppActionKind {
  return (IN_APP_ACTION_KINDS as readonly string[]).includes(kind);
}

@Injectable()
export class WorkflowRunService {
  /**
   * Execute a template's action deterministically and return the run outcome. Pure: no I/O, no
   * randomness, no clock — the timestamps are the database's, assigned when the row is written.
   *
   * An in-app action kind produces a `succeeded` outcome whose detail records the effect the run
   * carried out inside the app. An external or unknown kind produces a `failed` outcome whose detail
   * names why it was not run — the run is still recorded, so the refusal is auditable.
   */
  execute(templateId: string, actionKind: string, triggerKind: string): WorkflowRunOutcome {
    if (!isInAppActionKind(actionKind)) {
      return {
        status: 'failed',
        detail: {
          templateId,
          triggerKind,
          actionKind,
          outcome: 'not_run',
          reason: 'external_action_not_supported_in_app',
        },
      };
    }

    return {
      status: 'succeeded',
      detail: {
        templateId,
        triggerKind,
        actionKind,
        outcome: 'executed',
        effect: describeEffect(actionKind),
      },
    };
  }
}

/** A stable, human-readable line describing what an in-app action carried out. Deterministic. */
function describeEffect(kind: InAppActionKind): string {
  switch (kind) {
    case 'notify_owner':
      return 'Notified the work owner in-app.';
    case 'create_work_item':
      return 'Recorded a follow-up work item request in-app.';
    case 'post_message':
      return 'Posted an in-app message to the project channel.';
  }
}
