import type { AuditAction } from '../policies/audit.js';

/**
 * 62-A2 — the activity catalogue: which audit actions become an entry on a project's and a
 * client's Activity tab, under which kind, and which source row decides who may read it.
 *
 * One list for both apps. The worker's `activity-projector` files an `audit_events` row only when
 * its action is here; the API's activity read re-checks each entry through the read rule of its
 * `source` and, when `finance` is set, asks for the finance capability as well. An action that is
 * not here never reaches the table, so noise (downloads, previews, scans, exports) and anything
 * security-related stay out by construction.
 *
 * `source` is always the action's audit object type (`auditObjectTypeFor`); the unit test pins
 * that, so the entry's `object_id` is always a row of the source table. Deletions are not listed:
 * a deleted source drops its entries at read, so a "deleted" entry could never be shown.
 */

export const ACTIVITY_KINDS = [
  'project',
  'people',
  'work',
  'time',
  'files',
  'approvals',
  'milestones',
  'requests',
  'money',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** The source tables an entry can point at; each has exactly one read rule in the API. */
export const ACTIVITY_SOURCES = [
  'project',
  'project_membership',
  'work_item',
  'time_log',
  'file_asset',
  'deliverable',
  'approval',
  'project_milestone',
  'client_request',
  'client_invoice',
  'quote',
  'expense',
] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

/**
 * Who an entry is about, stored with it: `finance` entries need the finance capability,
 * `client_visible` ones describe something the client can also see, the rest are internal.
 * The read rule of the source still decides on every read; the class is for filtering.
 */
export const ACTIVITY_AUDIENCE_CLASSES = ['internal', 'client_visible', 'finance'] as const;
export type ActivityAudienceClass = (typeof ACTIVITY_AUDIENCE_CLASSES)[number];

export interface ActivityActionDefinition {
  readonly kind: ActivityKind;
  readonly source: ActivitySource;
  /** Money figures: the entry is shown only to a holder of `finance.view`. */
  readonly finance: boolean;
}

const entry = (
  kind: ActivityKind,
  source: ActivitySource,
  finance = false,
): ActivityActionDefinition => ({ kind, source, finance });

export const ACTIVITY_ACTION_CATALOG = {
  'project.created': entry('project', 'project'),
  'budget.updated': entry('money', 'project', true),

  'project_membership.granted': entry('people', 'project_membership'),
  'project_membership.role_changed': entry('people', 'project_membership'),
  'project_membership.revoked': entry('people', 'project_membership'),

  'work_item.created': entry('work', 'work_item'),
  'work_item.transitioned': entry('work', 'work_item'),
  'work_item.updated': entry('work', 'work_item'),
  'work_item.rescheduled': entry('work', 'work_item'),
  'work_item.commented': entry('work', 'work_item'),
  'work_item.restored': entry('work', 'work_item'),

  'time_log.created': entry('time', 'time_log'),

  'file_asset.uploaded': entry('files', 'file_asset'),
  'file_asset.version_added': entry('files', 'file_asset'),
  'file_asset.restored': entry('files', 'file_asset'),

  'deliverable.created': entry('files', 'deliverable'),
  'deliverable.version_added': entry('files', 'deliverable'),
  'deliverable.shared_with_client': entry('files', 'deliverable'),
  'deliverable.sent_for_approval': entry('approvals', 'deliverable'),
  'deliverable.restored': entry('files', 'deliverable'),

  'approval.approved': entry('approvals', 'approval'),
  'approval.changes_requested': entry('approvals', 'approval'),

  'milestone.date_changed': entry('milestones', 'project_milestone'),
  'milestone.published': entry('milestones', 'project_milestone'),
  'milestone.unpublished': entry('milestones', 'project_milestone'),

  'client_request.submitted': entry('requests', 'client_request'),
  'client_request.transitioned': entry('requests', 'client_request'),

  'client_invoice.created': entry('money', 'client_invoice', true),
  'client_invoice.sent': entry('money', 'client_invoice', true),
  'client_invoice.payment_recorded': entry('money', 'client_invoice', true),
  'client_invoice.voided': entry('money', 'client_invoice', true),
  'client_invoice.credited': entry('money', 'client_invoice', true),

  'quote.created': entry('money', 'quote', true),
  'quote.sent': entry('money', 'quote', true),
  'quote.accepted': entry('money', 'quote', true),
  'quote.declined': entry('money', 'quote', true),
  'quote.converted': entry('money', 'quote', true),

  'expense.created': entry('money', 'expense', true),
  'expense.submitted': entry('money', 'expense', true),
  'expense.approved': entry('money', 'expense', true),
  'expense.rejected': entry('money', 'expense', true),
} as const satisfies Partial<Record<AuditAction, ActivityActionDefinition>>;

export type ActivityAction = keyof typeof ACTIVITY_ACTION_CATALOG;

export const ACTIVITY_ACTIONS = Object.keys(ACTIVITY_ACTION_CATALOG) as readonly ActivityAction[];

export function isActivityAction(action: string): action is ActivityAction {
  return Object.hasOwn(ACTIVITY_ACTION_CATALOG, action);
}

/** The definition of a catalogued action, or `null` for every other action. */
export function activityDefinitionFor(action: string): ActivityActionDefinition | null {
  return isActivityAction(action) ? ACTIVITY_ACTION_CATALOG[action] : null;
}

export function isActivityKind(value: string): value is ActivityKind {
  return (ACTIVITY_KINDS as readonly string[]).includes(value);
}

/** The catalogued actions of one kind, for the read filter. */
export function activityActionsOfKind(kind: ActivityKind): readonly ActivityAction[] {
  return ACTIVITY_ACTIONS.filter((action) => ACTIVITY_ACTION_CATALOG[action].kind === kind);
}
