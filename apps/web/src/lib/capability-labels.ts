import { CAPABILITIES, MATRIX, MATRIX_ACTIONS, MATRIX_AREAS } from '@tmanage/domain';
import type { Capability, MatrixAction, MatrixArea, MatrixRow } from '@tmanage/domain';

/**
 * Plain names for the fixed capability list (ADM-09).
 *
 * The Roles and Policy simulation screens listed the capability codes (56 since platform-admin v2 · PA-01) as they are written in
 * `packages/domain` (`org.manage`, `client_projection.read`, `member.offboard`). A person choosing
 * what a role may do reads a sentence, not a code. The code is still what is sent to the API.
 *
 * Keyed by the domain's own `Capability` type, so a capability added there and not named here is
 * a type error rather than a raw code on screen. The area orders the list so related permissions
 * sit next to each other; it is not drawn as a heading.
 */

export type CapabilityArea =
  | 'Organization'
  | 'Projects'
  | 'Chat'
  | 'Work'
  | 'Meetings and docs'
  | 'Clients'
  | 'Deliverables and approvals'
  | 'Files and search'
  | 'Audit'
  | 'Decisions'
  | 'People and roles'
  | 'Billing and settings'
  | 'AI and reports';

interface CapabilityLabel {
  readonly area: CapabilityArea;
  readonly label: string;
}

const LABELS: Readonly<Record<Capability, CapabilityLabel>> = {
  'org.manage': { area: 'Organization', label: 'Manage the organization, billing and automations' },
  'org.security.manage': { area: 'Organization', label: 'Manage security and sign-in rules' },
  'workspace.manage': { area: 'Organization', label: 'Manage workspaces' },
  'member.offboard': { area: 'Organization', label: 'Offboard people' },
  'project.create': { area: 'Projects', label: 'Create projects' },
  'project.manage': { area: 'Projects', label: 'Manage project settings' },
  'project.member.manage': { area: 'Projects', label: 'Add and remove people on projects' },
  'conversation.read': { area: 'Chat', label: 'Read chat' },
  'conversation.write': { area: 'Chat', label: 'Post in chat' },
  'conversation.moderate': { area: 'Chat', label: 'Moderate other people’s messages' },
  'work.read': { area: 'Work', label: 'See work items' },
  'work.create': { area: 'Work', label: 'Create work items' },
  'work.update': { area: 'Work', label: 'Edit work items' },
  'work.transition': { area: 'Work', label: 'Move work items between states' },
  'meeting.read': { area: 'Meetings and docs', label: 'See meetings' },
  'meeting.write': { area: 'Meetings and docs', label: 'Schedule and edit meetings' },
  'doc.read': { area: 'Meetings and docs', label: 'Read docs' },
  'doc.write': { area: 'Meetings and docs', label: 'Write and edit docs' },
  'client_projection.read': { area: 'Clients', label: 'See what clients see' },
  'client_request.submit': { area: 'Clients', label: 'Send requests as a client' },
  'client_request.triage': { area: 'Clients', label: 'Triage client requests' },
  'client_member.manage': { area: 'Clients', label: 'Invite and manage client people' },
  'deliverable.create': { area: 'Deliverables and approvals', label: 'Create deliverables' },
  'deliverable.review': { area: 'Deliverables and approvals', label: 'Review deliverables' },
  'deliverable.publish': {
    area: 'Deliverables and approvals',
    label: 'Publish deliverables to clients',
  },
  'approval.read': { area: 'Deliverables and approvals', label: 'See approvals' },
  'approval.decide': {
    area: 'Deliverables and approvals',
    label: 'Approve or reject, when asked to review',
  },
  'file.upload': { area: 'Files and search', label: 'Upload files' },
  'file.download': { area: 'Files and search', label: 'Download files' },
  'search.use': { area: 'Files and search', label: 'Search the workspace' },
  'audit.read': { area: 'Audit', label: 'Read the audit log' },
  'audit.export': { area: 'Audit', label: 'Export the audit log and organization data' },
  // ---- platform-admin v2 · PA-01 ----
  'project.delete': { area: 'Projects', label: 'Delete projects' },
  'work.delete': { area: 'Work', label: 'Delete work items' },
  'work.export': { area: 'Work', label: 'Export work items' },
  'conversation.delete': { area: 'Chat', label: 'Delete chat messages' },
  'conversation.export': { area: 'Chat', label: 'Export chat history' },
  'doc.delete': { area: 'Meetings and docs', label: 'Delete docs' },
  'doc.export': { area: 'Meetings and docs', label: 'Export docs' },
  'decision.read': { area: 'Decisions', label: 'See decisions' },
  'decision.write': { area: 'Decisions', label: 'Record and edit decisions' },
  'decision.delete': { area: 'Decisions', label: 'Delete decisions' },
  'meeting.delete': { area: 'Meetings and docs', label: 'Delete meetings' },
  'file.delete': { area: 'Files and search', label: 'Delete files and folders' },
  'storage.manage': { area: 'Files and search', label: 'Manage storage and connected drives' },
  'people.view': { area: 'People and roles', label: 'See the people directory' },
  'people.invite': { area: 'People and roles', label: 'Invite people' },
  'people.edit': { area: 'People and roles', label: 'Edit people’s details' },
  'roles.assign': { area: 'People and roles', label: 'Give roles and permissions' },
  'billing.view': { area: 'Billing and settings', label: 'See billing and invoices' },
  'billing.manage': { area: 'Billing and settings', label: 'Manage billing and the plan' },
  'settings.view': { area: 'Billing and settings', label: 'See organization settings' },
  'ai.use': { area: 'AI and reports', label: 'Use AI features' },
  'ai.manage': { area: 'AI and reports', label: 'Manage AI connections and access' },
  'report.view': { area: 'AI and reports', label: 'See reports and insights' },
  'report.export': { area: 'AI and reports', label: 'Export reports' },
};

const AREA_ORDER: readonly CapabilityArea[] = [
  'Organization',
  'Projects',
  'Chat',
  'Work',
  'Meetings and docs',
  'Clients',
  'Deliverables and approvals',
  'Files and search',
  'Audit',
  'Decisions',
  'People and roles',
  'Billing and settings',
  'AI and reports',
];

/** The plain name for a capability code; an unknown string (an old stored value) is shown as is. */
export function capabilityLabel(capability: string): string {
  return (LABELS as Readonly<Record<string, CapabilityLabel>>)[capability]?.label ?? capability;
}

/** Every capability, ordered by area and then as the domain lists them. */
export const CAPABILITIES_BY_AREA: readonly Capability[] = [...CAPABILITIES].sort(
  (a, b) => AREA_ORDER.indexOf(LABELS[a].area) - AREA_ORDER.indexOf(LABELS[b].area),
);

// ---- platform-admin v2 · PA-01 ----
/** The area × action layout the permission matrix draws (SPEC §3.3), re-exported for the screens. */
export { MATRIX, MATRIX_ACTIONS, MATRIX_AREAS };
export type { MatrixAction, MatrixArea, MatrixRow };
