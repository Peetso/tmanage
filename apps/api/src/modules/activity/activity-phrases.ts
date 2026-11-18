import type { ActivityAction } from '@tmanage/domain';

/**
 * 62-A2 (B02) — the words an activity entry is shown with, built from its action alone.
 *
 * An entry never carries content: no title, no comment body, no amount. The phrase says what was
 * done to which kind of thing ("Approved a version"); the screen puts the person's name in front
 * and links to the record. `phraseKey` is the web catalogue key (`activity.phrase.*`, English and
 * Arabic written from the meaning); `summary` is the English text, the same style as the
 * work-item feed's phrases. `satisfies` makes a newly catalogued action a compile error here until
 * it has words.
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

export interface ActivityPhrase {
  readonly phraseKey: `activity.phrase.${ActivityAction}`;
  readonly summary: string;
}

export function activityPhrase(action: ActivityAction): ActivityPhrase {
  return { phraseKey: `activity.phrase.${action}`, summary: PHRASES[action] };
}
