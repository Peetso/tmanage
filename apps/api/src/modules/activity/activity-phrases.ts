import type { ActivityAction } from '@tmanage/domain';

/**
 * 62-A2 (B02), D2 — the words an activity entry is shown with.
 *
 * Each action has a generic phrase ("Changed the status of a task") and, where its source row has a
 * name, a phrase that names it ("Changed the status of “{subject}”"). The service picks the named
 * one when the entry's row still has a name the viewer may read (`activity.service.ts`), else the
 * generic one: an expense has no name, an unnumbered draft invoice neither. `phraseKey` is the web
 * catalogue key (`activity.phrase.*` / `activity.subject.*`, whose sentences put `{actor}` in front);
 * `summary` is the English predicate without the person, `{subject}` filled. `satisfies` makes a
 * newly catalogued action a compile error here until it has words.
 */
const PHRASES = {
  'project.created': 'Created the project',
  'budget.updated': 'Changed the budget',
  'project_membership.granted': 'Added someone to the project',
  'project_membership.role_changed': "Changed someone's project role",
  'project_membership.revoked': 'Removed someone from the project',
  'work_item.created': 'Created a task',
  'work_item.transitioned': 'Changed the status of a task',
  'work_item.updated': 'Updated a task',
  'work_item.rescheduled': 'Moved the dates of a task',
  'work_item.commented': 'Commented on a task',
  'work_item.restored': 'Restored a task',
  'time_log.created': 'Logged time',
  'file_asset.uploaded': 'Uploaded a file',
  'file_asset.version_added': 'Added a new version of a file',
  'file_asset.restored': 'Restored a file',
  'deliverable.created': 'Created a deliverable',
  'deliverable.version_added': 'Added a new version of a deliverable',
  'deliverable.shared_with_client': 'Shared a deliverable with the client',
  'deliverable.sent_for_approval': 'Sent a deliverable for approval',
  'deliverable.restored': 'Restored a deliverable',
  'approval.approved': 'Approved a version',
  'approval.changes_requested': 'Asked for changes',
  'milestone.date_changed': 'Changed the date of a milestone',
  'milestone.published': 'Showed a milestone to the client',
  'milestone.unpublished': 'Hid a milestone from the client',
  'client_request.submitted': 'Sent a request',
  'client_request.transitioned': 'Changed the status of a request',
  'client_invoice.created': 'Created an invoice',
  'client_invoice.sent': 'Sent an invoice',
  'client_invoice.payment_recorded': 'Recorded a payment',
  'client_invoice.voided': 'Voided an invoice',
  'client_invoice.credited': 'Credited an invoice',
  'quote.created': 'Created a quote',
  'quote.sent': 'Sent a quote',
  'quote.accepted': 'Accepted a quote',
  'quote.declined': 'Declined a quote',
  'quote.converted': 'Turned a quote into a project',
  'expense.created': 'Added an expense',
  'expense.submitted': 'Submitted an expense',
  'expense.approved': 'Approved an expense',
  'expense.rejected': 'Rejected an expense',
} as const satisfies Record<ActivityAction, string>;

/** The actions whose source row has no name to show (an expense is a category and an amount). */
type UnnamedAction = Extract<ActivityAction, `expense.${string}`>;
type NamedAction = Exclude<ActivityAction, UnnamedAction>;

const SUBJECT_PHRASES = {
  'project.created': 'Created the project “{subject}”',
  'budget.updated': 'Changed the budget of “{subject}”',
  'project_membership.granted': 'Added someone to “{subject}”',
  'project_membership.role_changed': "Changed someone's role on “{subject}”",
  'project_membership.revoked': 'Removed someone from “{subject}”',
  'work_item.created': 'Created “{subject}”',
  'work_item.transitioned': 'Changed the status of “{subject}”',
  'work_item.updated': 'Updated “{subject}”',
  'work_item.rescheduled': 'Moved the dates of “{subject}”',
  'work_item.commented': 'Commented on “{subject}”',
  'work_item.restored': 'Restored “{subject}”',
  'time_log.created': 'Logged time on “{subject}”',
  'file_asset.uploaded': 'Uploaded “{subject}”',
  'file_asset.version_added': 'Added a new version of “{subject}”',
  'file_asset.restored': 'Restored “{subject}”',
  'deliverable.created': 'Created the deliverable “{subject}”',
  'deliverable.version_added': 'Added a new version of “{subject}”',
  'deliverable.shared_with_client': 'Shared “{subject}” with the client',
  'deliverable.sent_for_approval': 'Sent “{subject}” for approval',
  'deliverable.restored': 'Restored the deliverable “{subject}”',
  'approval.approved': 'Approved a version of “{subject}”',
  'approval.changes_requested': 'Asked for changes to “{subject}”',
  'milestone.date_changed': 'Changed the date of “{subject}”',
  'milestone.published': 'Showed “{subject}” to the client',
  'milestone.unpublished': 'Hid “{subject}” from the client',
  'client_request.submitted': 'Sent the request “{subject}”',
  'client_request.transitioned': 'Changed the status of the request “{subject}”',
  'client_invoice.created': 'Created invoice {subject}',
  'client_invoice.sent': 'Sent invoice {subject}',
  'client_invoice.payment_recorded': 'Recorded a payment on invoice {subject}',
  'client_invoice.voided': 'Voided invoice {subject}',
  'client_invoice.credited': 'Credited invoice {subject}',
  'quote.created': 'Created quote {subject}',
  'quote.sent': 'Sent quote {subject}',
  'quote.accepted': 'Accepted quote {subject}',
  'quote.declined': 'Declined quote {subject}',
  'quote.converted': 'Turned quote {subject} into a project',
} as const satisfies Record<NamedAction, string>;

export interface ActivityPhrase {
  readonly phraseKey: `activity.phrase.${ActivityAction}` | `activity.subject.${NamedAction}`;
  readonly summary: string;
  /** The name the phrase shows; `null` with the generic phrase, so a name never travels alone. */
  readonly subject: string | null;
}

function isNamed(action: ActivityAction): action is NamedAction {
  return Object.prototype.hasOwnProperty.call(SUBJECT_PHRASES, action);
}

/** The named phrase when the row has a `subject` and the action names one; else the generic one. */
export function activityPhrase(
  action: ActivityAction,
  subject: string | null = null,
): ActivityPhrase {
  if (subject !== null && subject !== '' && isNamed(action)) {
    return {
      phraseKey: `activity.subject.${action}`,
      // A function, so a `$&` in a name is never read as a replacement pattern.
      summary: SUBJECT_PHRASES[action].replace('{subject}', () => subject),
      subject,
    };
  }
  return { phraseKey: `activity.phrase.${action}`, summary: PHRASES[action], subject: null };
}
