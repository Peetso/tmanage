/**
 * AI action registry — parity pass, batch 4, lane C "lifecycle" (owner rules 2026-11-23: "anything
 * the account can do by hand, the AI can do", and what a member obviously needs — removing what
 * they made — must exist; ADR-0015 part 1, rule 4).
 *
 * The live AI test (`work/pass-2026-11-23/AI-ACTIONS-LIVE-TEST.md` §5, G1–G5) found records the AI
 * could make and nobody could take away. Each op here mirrors a route built in the same change:
 *
 * - G1 projects: rename, archive, restore, and delete — an EMPTY project only; one that holds
 *   anything is refused 409 `project_not_empty` and is archived instead (`ProjectsRepository
 *   .deleteEmpty`: the foreign keys onto `projects` decide "empty", not a hand-kept list).
 * - G2 a team, a work label definition, an unpublished work form with no submissions, a draft
 *   quote and a draft invoice (an issued invoice stays void/credit only).
 * - G5 files: the workspace-wide file list, and a small inline file (base64, 512 KiB, a type
 *   allow-list) added to a work item through the upload's own checks. A URL is never accepted.
 * - G4 the owner's AI settings (Settings > AI): read, and change. They were NEVER `ai_chat` ("the
 *   AI never reads or changes its own settings"); the owner asked for them by name (G4). The change
 *   is manage-class and confirm-class, so it always waits on a card the owner confirms in person,
 *   and the route's owner gate (`requireAiSettingsOwner`) still decides every call. The AI never
 *   approves its own card: K2 stands, the confirm and undo routes stay NEVER.
 *
 * Risk and scope (lane rule): a GET is `read`/`read`; every change is `risk: 'confirm'`, so it
 * always goes on a card. Scope: company structure and settings (teams, labels, AI settings,
 * deleting a project, invoices) are `manage`; the member's own everyday work (renaming or archiving
 * a project they manage, their form, their draft quote, a file on a work item) is `write`.
 * Sensitivity: every removal is `destructive`; nothing here moves money (a draft is not issued, so
 * the typed-amount gate has nothing to confirm).
 */
import { z } from 'zod';
import { PROJECT_NAME_MAX } from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';
import type { AiActionOp, AiScope, HttpMethod, Sensitivity } from './types.js';
import { bodyArgs, det, f, noArgs, pathOnly, type AiActionDetail } from './detail.js';
import { INLINE_FILE_MAX_BYTES, INLINE_FILE_TYPES } from '../../files/inline-file.js';

const ORG = '/v1/organizations/:orgSlug';

function op(
  id: string,
  method: HttpMethod,
  path: string,
  capability: Capability,
  scope: AiScope,
): AiActionOp {
  const risk = method === 'GET' ? 'read' : 'confirm';
  return {
    id,
    method,
    path: `${ORG}${path}`,
    capability,
    risk,
    scope: risk === 'read' ? 'read' : scope,
  };
}

const R = 'read' as const;
const W = 'write' as const;
const M = 'manage' as const;

export const lifecycleOps: readonly AiActionOp[] = [
  // G1 projects.
  op('projects.update', 'PATCH', '/projects/:projectId', 'project.manage', W),
  op('projects.archive', 'POST', '/projects/:projectId/archive', 'project.manage', W),
  op('projects.unarchive', 'POST', '/projects/:projectId/unarchive', 'project.manage', W),
  op('projects.delete', 'DELETE', '/projects/:projectId', 'project.delete', M),
  // G2 removals.
  op('people.teams.delete', 'DELETE', '/people/teams/:id', 'org.manage', M),
  op('work.labels.delete', 'DELETE', '/work/labels/:labelId', 'work.delete', M),
  op('work_forms.delete', 'DELETE', '/work-forms/:formId', 'work.create', W),
  op('quotes.delete', 'DELETE', '/quotes/:quoteId', 'project.manage', W),
  op('client_invoices.delete', 'DELETE', '/client-invoices/:invoiceId', 'finance.manage', M),
  // G5 files.
  op('files.workspace.list', 'GET', '/files', 'file.download', R),
  op(
    'work_item_files.upload_inline',
    'POST',
    '/work-items/:workItemId/inline-files',
    'work.update',
    W,
  ),
  // G4 the owner's AI settings.
  op('copilot.settings.get', 'GET', '/copilot/settings/', 'org.manage', R),
  op('copilot.settings.update', 'PATCH', '/copilot/settings/', 'org.manage', M),
];

/** Non-read ops only; every removal is `destructive`. */
export const lifecycleSensitivity: Readonly<Record<string, Sensitivity>> = {
  'projects.update': 'none',
  'projects.archive': 'destructive',
  'projects.unarchive': 'none',
  'projects.delete': 'destructive',
  'people.teams.delete': 'destructive',
  'work.labels.delete': 'destructive',
  'work_forms.delete': 'destructive',
  'quotes.delete': 'destructive',
  'client_invoices.delete': 'destructive',
  'work_item_files.upload_inline': 'none',
  'copilot.settings.update': 'none',
};

/**
 * The Settings > AI bounds (`copilot/ai-settings.rules.ts`, `ai-conversations.service.ts`), stated
 * here because no registry file imports the copilot module (it imports the registry). Held equal
 * by `parity-b4-lifecycle.test.ts`.
 */
export const AI_SETTINGS_BOUNDS = {
  memberSharePercent: [1, 100],
  conversationRetentionDays: [1, 365],
  membersPerPatch: 50,
} as const;

const iso = () => z.string().datetime({ offset: true });
const membershipIds = () =>
  z.array(f.id()).min(1).max(AI_SETTINGS_BOUNDS.membersPerPatch).optional();
/** Standard base64 for at most {@link INLINE_FILE_MAX_BYTES} decoded bytes. */
const base64 = () =>
  z
    .string()
    .min(4)
    .max(Math.ceil(INLINE_FILE_MAX_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const inlineTypes = INLINE_FILE_TYPES as readonly [string, ...string[]];

export const lifecycleDetails: readonly AiActionDetail[] = [
  det({
    id: 'projects.update',
    title: 'Rename a project',
    description:
      'Change a project name (1-190 characters). expectedUpdatedAt is the updatedAt last read ' +
      '(projects.get); a newer change is a conflict. An archived project is restored first.',
    input: bodyArgs(['projectId'], {
      name: f.shortText(PROJECT_NAME_MAX),
      expectedUpdatedAt: iso(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Rename',
        args: {
          projectId: 'pr_1',
          name: 'Website relaunch 2027',
          expectedUpdatedAt: '2026-11-23T09:00:00.000Z',
        },
      },
    ],
  }),
  det({
    id: 'projects.archive',
    title: 'Archive a project',
    description:
      'Take a project out of every list without erasing anything; projects.unarchive brings it ' +
      'back. Use this for a project that holds work, files or links.',
    input: pathOnly('projectId'),
    redact: 'standard',
    examples: [{ summary: 'Archive', args: { projectId: 'pr_1' } }],
  }),
  det({
    id: 'projects.unarchive',
    title: 'Restore an archived project',
    description: 'Bring an archived project back into the lists.',
    input: pathOnly('projectId'),
    redact: 'standard',
    examples: [{ summary: 'Restore', args: { projectId: 'pr_1' } }],
  }),
  det({
    id: 'projects.delete',
    title: 'Delete an empty project',
    description:
      'Delete a project that holds nothing (no work items, documents, files, meetings, chats, ' +
      'client links or costs). A project that holds anything is refused (409 project_not_empty): ' +
      'archive it instead (projects.archive). Cannot be undone.',
    input: pathOnly('projectId'),
    redact: 'standard',
    examples: [{ summary: 'Delete', args: { projectId: 'pr_1' } }],
  }),
  det({
    id: 'people.teams.delete',
    title: 'Delete a team',
    description:
      'Delete a team (the id people.teams.list gives). Its members stay in the workspace; only the ' +
      'grouping goes. Owners/admins only. Cannot be undone.',
    input: pathOnly('id'),
    redact: 'people',
    examples: [{ summary: 'Delete', args: { id: 'team_1' } }],
  }),
  det({
    id: 'work.labels.delete',
    title: 'Delete a work label',
    description:
      'Delete a label definition (the labelId work.labels.list gives). The tag comes off every work ' +
      'item that carries it. Cannot be undone.',
    input: pathOnly('labelId'),
    redact: 'standard',
    examples: [{ summary: 'Delete', args: { labelId: 'lbl_1' } }],
  }),
  det({
    id: 'work_forms.delete',
    title: 'Delete a work form',
    description:
      'Delete a work form you made (the formId work_forms.list gives), or any form as an owner/admin. ' +
      'A published form must be unpublished first (409 form_published); a form with submissions ' +
      'is kept (409 form_has_submissions). Cannot be undone.',
    input: pathOnly('formId'),
    redact: 'standard',
    examples: [{ summary: 'Delete', args: { formId: 'wf_1' } }],
  }),
  det({
    id: 'quotes.delete',
    title: 'Delete a draft quote',
    description:
      'Delete a quote that was never sent (status draft; the quoteId quotes.list gives). A sent, ' +
      'accepted or declined quote is refused (409 not_draft). Cannot be undone.',
    input: pathOnly('quoteId'),
    redact: 'finance',
    examples: [{ summary: 'Delete', args: { quoteId: 'q_1' } }],
  }),
  det({
    id: 'client_invoices.delete',
    title: 'Delete a draft invoice',
    description:
      'Delete a client invoice that was never issued (state draft, no number yet); the time, ' +
      'expenses and retainer it pulled are released. An issued invoice is refused (409 ' +
      'not_draft): it can only be voided or credited. Cannot be undone.',
    input: pathOnly('invoiceId'),
    redact: 'finance',
    examples: [{ summary: 'Delete', args: { invoiceId: 'inv_1' } }],
  }),
  det({
    id: 'files.workspace.list',
    title: 'List all files',
    description:
      'Every ready file across the projects you can read, newest change first (name, type, size, ' +
      'project, scan status). limit 1-200, default 50.',
    input: bodyArgs([], { limit: f.int(1, 200).optional() }),
    redact: 'standard',
    examples: [{ summary: 'Latest files', args: { limit: 20 } }],
  }),
  det({
    id: 'work_item_files.upload_inline',
    title: 'Add a small file to a work item',
    description:
      'Attach a file whose content you send as standard base64 (contentBase64, at most 512 KiB ' +
      'decoded) to a work item. name is a plain file name; mimeType is one of: ' +
      `${INLINE_FILE_TYPES.join(', ')}. The file passes the usual checks (company file rules, ` +
      'size cap, virus scan) before anyone can open it. A URL is never accepted.',
    input: bodyArgs(['workItemId'], {
      name: f.shortText(255),
      mimeType: z.enum(inlineTypes),
      contentBase64: base64(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'A short note',
        args: {
          workItemId: 'wi_1',
          name: 'notes.txt',
          mimeType: 'text/plain',
          contentBase64: 'aGVsbG8=',
        },
      },
    ],
  }),
  det({
    id: 'copilot.settings.get',
    title: "Show the workspace's AI settings",
    description:
      'Settings > AI: whether the AI is on, what it may do (writeScope read or read_write), quick ' +
      'changes (runAtOnce), file reading, the member share of AI credits, how long AI ' +
      'conversations are kept, and the members it is blocked for. The workspace owner only.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Settings', args: {} }],
  }),
  det({
    id: 'copilot.settings.update',
    title: "Change the workspace's AI settings",
    description:
      'Change one or more AI settings: aiEnabled, writeScope (read = answer only, read_write = ' +
      'answer and make changes), runAtOnce (needs read_write), fileReading, memberSharePercent ' +
      '(1-100), conversationRetentionDays (1-365), blockMembershipIds / allowMembershipIds (at most ' +
      '50 each). The workspace owner only; the owner confirms the change in person.',
    input: bodyArgs([], {
      aiEnabled: f.bool().optional(),
      writeScope: z.enum(['read', 'read_write']).optional(),
      runAtOnce: f.bool().optional(),
      fileReading: f.bool().optional(),
      memberSharePercent: f.int(...AI_SETTINGS_BOUNDS.memberSharePercent).optional(),
      conversationRetentionDays: f.int(...AI_SETTINGS_BOUNDS.conversationRetentionDays).optional(),
      blockMembershipIds: membershipIds(),
      allowMembershipIds: membershipIds(),
    }),
    redact: 'config',
    examples: [
      { summary: 'Answers only', args: { writeScope: 'read' } },
      { summary: 'Keep chats 90 days', args: { conversationRetentionDays: 90 } },
    ],
  }),
];
