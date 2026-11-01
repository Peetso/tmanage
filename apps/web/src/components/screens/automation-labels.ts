import type { WorkflowActionKind, WorkflowTriggerKind } from '../../lib/api/automations';

type TOr = (key: string, english: string) => string;

/**
 * The words a person reads for each trigger and action kind, shared by the rule settings page and the
 * library's New automation form, so both say the same thing (2026-10-31 live test: the form said
 * "Work item created" where the rule said "A work item is created").
 */

/** The trigger chip's wording and the clause the page title ends with, per trigger kind. */
export const TRIGGERS: Readonly<
  Record<WorkflowTriggerKind, { readonly label: string; readonly clause: string }>
> = {
  work_item_created: {
    label: 'A work item is created',
    clause: 'when a work item is created',
  },
  work_item_transitioned: {
    label: 'A work item changes status',
    clause: 'when a work item changes status',
  },
  request_submitted: {
    label: 'A client sends a request',
    clause: 'when a client sends a request',
  },
  meeting_scheduled: {
    label: 'A meeting is scheduled',
    clause: 'when a meeting is scheduled',
  },
  document_published: {
    label: 'A document is published',
    clause: 'when a document is published',
  },
  work_item_due_soon: {
    label: 'A work item is due in 2 days',
    clause: 'when a work item is due in 2 days',
  },
};

export const ACTIONS: Readonly<Record<WorkflowActionKind, string>> = {
  notify_owner: 'Remind the owner',
  create_work_item: 'Create a work item',
  post_message: 'Post a message',
  send_email_digest: 'Send an email digest',
};

/** The trigger's wording, shared with the library's New automation form so both say the same. */
export function triggerLabel(tOr: TOr, kind: string): string {
  const entry = TRIGGERS[kind as WorkflowTriggerKind];
  return entry ? tOr(`AutomationRule.trigger.${kind}`, entry.label) : kind;
}

/** The action's wording, shared with the library's New automation form so both say the same. */
export function actionLabel(tOr: TOr, kind: string): string {
  const english = ACTIONS[kind as WorkflowActionKind];
  return english ? tOr(`AutomationRule.action.${kind}`, english) : kind;
}
