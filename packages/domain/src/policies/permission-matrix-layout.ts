import { CAPABILITIES, type Capability } from './capabilities.js';

/**
 * platform-admin v2 · PA-01 — the permission matrix as people see it (SPEC §3.3).
 *
 * The role editor (D7), the member overrides screen (D8), the "what can this person do" drawer
 * (B4) and the platform admin team screens all draw the same grid: rows are areas of the product,
 * columns are seven actions, and each cell is exactly one capability from `CAPABILITIES` — or
 * `null` where the action has no meaning for the area (drawn as "—"). The grid is a *view* of the
 * flat capability list, not a second permission model: ticking a cell adds its capability to a
 * custom role's `capabilities_json` or to a member's overrides, and `authorize()` decides as it
 * always has.
 *
 * Footnotes from the SPEC table, kept here so the screen and the tests read the same facts:
 * 1. Projects · view rides `work.read` (there is no separate project-read capability).
 * 2. The "approve" column reads "move between states" for work items (`work.transition`).
 * 3. Create and edit share one capability for docs, decisions and meetings; the edit cell is
 *    drawn merged ("= create") — see {@link MATRIX_MERGED_CELLS}.
 * 4. People · manage is `roles.assign`, which replaced the hard-coded owner/org-admin list.
 * 5. Finance (52-23 §10) is not a SPEC §3.3 row; it was added with `finance.view` / `finance.manage`
 *    so every capability keeps exactly one primary cell. Time (team time view) likewise.
 */

export const MATRIX_ACTIONS = [
  'view',
  'create',
  'edit',
  'delete',
  'approve',
  'export',
  'manage',
] as const;

export type MatrixAction = (typeof MATRIX_ACTIONS)[number];

export const MATRIX_AREAS = [
  'projects',
  'work_items',
  'approvals',
  'client_portal',
  'chat',
  'docs',
  'decisions',
  'meetings',
  'files',
  'people',
  'billing',
  // 52-23 §10: Settings → Finance (profile, tax rates, exchange rates).
  'finance',
  // FIX-2026-11-10: Finance → Team time (everyone's tracked time).
  'time',
  'settings',
  'workspaces',
  'ai',
  'reports',
  'audit',
  'search',
] as const;

export type MatrixArea = (typeof MATRIX_AREAS)[number];

export type MatrixRow = Readonly<Record<MatrixAction, Capability | null>>;

function row(cells: Partial<Record<MatrixAction, Capability>>): MatrixRow {
  return Object.freeze({
    view: cells.view ?? null,
    create: cells.create ?? null,
    edit: cells.edit ?? null,
    delete: cells.delete ?? null,
    approve: cells.approve ?? null,
    export: cells.export ?? null,
    manage: cells.manage ?? null,
  });
}

/** Area × action → capability, exactly as the SPEC §3.3 table. */
export const MATRIX: Readonly<Record<MatrixArea, MatrixRow>> = Object.freeze({
  projects: row({
    view: 'work.read',
    create: 'project.create',
    edit: 'project.manage',
    delete: 'project.delete',
    manage: 'project.member.manage',
  }),
  work_items: row({
    view: 'work.read',
    create: 'work.create',
    edit: 'work.update',
    delete: 'work.delete',
    approve: 'work.transition',
    export: 'work.export',
  }),
  approvals: row({
    view: 'approval.read',
    create: 'deliverable.create',
    edit: 'deliverable.review',
    approve: 'approval.decide',
    manage: 'deliverable.publish',
  }),
  client_portal: row({
    view: 'client_projection.read',
    create: 'client_request.submit',
    edit: 'client_request.triage',
    manage: 'client_member.manage',
  }),
  chat: row({
    view: 'conversation.read',
    create: 'conversation.write',
    delete: 'conversation.delete',
    export: 'conversation.export',
    manage: 'conversation.moderate',
  }),
  docs: row({
    view: 'doc.read',
    create: 'doc.write',
    edit: 'doc.write',
    delete: 'doc.delete',
    export: 'doc.export',
  }),
  decisions: row({
    view: 'decision.read',
    create: 'decision.write',
    edit: 'decision.write',
    delete: 'decision.delete',
  }),
  meetings: row({
    view: 'meeting.read',
    create: 'meeting.write',
    edit: 'meeting.write',
    delete: 'meeting.delete',
  }),
  files: row({
    view: 'file.download',
    create: 'file.upload',
    delete: 'file.delete',
    manage: 'storage.manage',
  }),
  people: row({
    view: 'people.view',
    create: 'people.invite',
    edit: 'people.edit',
    delete: 'member.offboard',
    manage: 'roles.assign',
  }),
  billing: row({ view: 'billing.view', manage: 'billing.manage' }),
  finance: row({ view: 'finance.view', manage: 'finance.manage' }),
  time: row({ view: 'time.view_team' }),
  settings: row({ view: 'settings.view', edit: 'org.manage', manage: 'org.security.manage' }),
  workspaces: row({ manage: 'workspace.manage' }),
  ai: row({ view: 'ai.use', manage: 'ai.manage' }),
  reports: row({ view: 'report.view', export: 'report.export' }),
  audit: row({ view: 'audit.read', export: 'audit.export' }),
  search: row({ view: 'search.use' }),
});

/** Footnote 3: edit cells that share the create cell's capability, drawn as "= create". */
export const MATRIX_MERGED_CELLS: readonly `${MatrixArea}.${MatrixAction}`[] = [
  'docs.edit',
  'decisions.edit',
  'meetings.edit',
];

/**
 * R7 footnote: chat cells that are member-gated rather than project-gated. A group or a direct
 * conversation belongs to no project; its members reach it, and a client member of a GROUP may
 * view it (and post, except client_viewer) although no client role holds the capability.
 */
export const MATRIX_MEMBER_GATED_CELLS: readonly `${MatrixArea}.${MatrixAction}`[] = [
  'chat.view',
  'chat.create',
];

/** Footnote 1: a cell that mirrors another area's capability (projects · view = work.read). */
export const MATRIX_MIRRORED_CELLS: readonly `${MatrixArea}.${MatrixAction}`[] = ['projects.view'];

export interface MatrixCell {
  readonly area: MatrixArea;
  readonly action: MatrixAction;
}

function isSecondary(area: MatrixArea, action: MatrixAction): boolean {
  const key = `${area}.${action}` as const;
  return MATRIX_MERGED_CELLS.includes(key) || MATRIX_MIRRORED_CELLS.includes(key);
}

const PRIMARY_CELL: ReadonlyMap<Capability, MatrixCell> = (() => {
  const out = new Map<Capability, MatrixCell>();
  for (const area of MATRIX_AREAS) {
    for (const action of MATRIX_ACTIONS) {
      const capability = MATRIX[area][action];
      if (capability === null || isSecondary(area, action) || out.has(capability)) continue;
      out.set(capability, Object.freeze({ area, action }));
    }
  }
  return out;
})();

/** The one cell a capability is drawn in (its primary cell), or null if the grid lacks it. */
export function capabilityCell(capability: Capability): MatrixCell | null {
  return PRIMARY_CELL.get(capability) ?? null;
}

/** Every cell that shows `capability` (the primary plus any merged/mirrored cell). */
export function cellsOfCapability(capability: Capability): readonly MatrixCell[] {
  const out: MatrixCell[] = [];
  for (const area of MATRIX_AREAS) {
    for (const action of MATRIX_ACTIONS) {
      if (MATRIX[area][action] === capability) out.push({ area, action });
    }
  }
  return out;
}

/** The distinct capabilities one area row carries, in column order (for the row "all" toggle). */
export function areaCapabilities(area: MatrixArea): readonly Capability[] {
  const out: Capability[] = [];
  for (const action of MATRIX_ACTIONS) {
    const capability = MATRIX[area][action];
    if (capability !== null && !out.includes(capability)) out.push(capability);
  }
  return out;
}

/** The distinct capabilities one action column carries, in area order (column "all" toggle). */
export function actionCapabilities(action: MatrixAction): readonly Capability[] {
  const out: Capability[] = [];
  for (const area of MATRIX_AREAS) {
    const capability = MATRIX[area][action];
    if (capability !== null && !out.includes(capability)) out.push(capability);
  }
  return out;
}

/** Capabilities that have no cell. Empty by construction; the layout test holds it there. */
export function capabilitiesWithoutCell(): readonly Capability[] {
  return CAPABILITIES.filter((capability) => !PRIMARY_CELL.has(capability));
}
