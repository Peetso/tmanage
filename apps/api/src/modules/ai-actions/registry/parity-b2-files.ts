/**
 * AI action registry — parity pass, batch 2, lane "files" (owner rule 2026-11-23: the in-app AI
 * and the external MCP must be able to do whatever the account has the right to do; ADR-0015
 * part 1, rule 4).
 *
 * Routes withheld in `NEVER` as `storage_connection`, `calendar_connection`, `file_review` and
 * `figma_links` without a K1-K5 reason become ops here: company storage settings and disconnects
 * (Google Drive, OneDrive), the storage hand-over and "Move to Drive" job, a person's own calendar
 * connections and due-date mirror, the file viewer's previews, review threads and decisions (studio
 * and portal doors), and Figma links, frames and frame threads. Classified ops that had no detail
 * (upload sessions, Drive/OneDrive attachments and imports, cloud folders, meeting guests, unfurl,
 * inbound e-mail, the realtime ticket) get one. Inputs mirror each controller's own parser.
 *
 * Kept in `NEVER`: `POST …/calendar-sync/feed` (K3: it mints the private ICS feed address, a bearer
 * secret shown once). Connect/complete/callback routes were never in this batch (K1).
 *
 * Scope/risk rule (lane brief): a GET is `read`/`read`; every change is `risk: 'confirm'`. Scope:
 * org settings, security, storage connections and anything shown in the client portal are
 * `manage`; the member's own everyday work (a review comment, their own calendar or Figma
 * connection, a Figma link on a project) is `write`. The member's capabilities and the services'
 * own object checks still decide every inner request; the card is the safety. Sensitivity follows
 * money > hr > destructive > external > none.
 */
import { z } from 'zod';
import type { Capability } from '@tmanage/domain';
import type { AiActionOp, AiScope, HttpMethod, Sensitivity } from './types.js';
import { bodyArgs, det, f, noArgs, pathOnly, type AiActionDetail } from './detail.js';

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

// ── Shared field shapes (mirroring the controllers' parsers) ─────────────────

/** `isDriveId` (google-drive.google.ts). */
const driveId = () => z.string().regex(/^[A-Za-z0-9_-]{5,128}$/);
/** `isDrivePageToken`. */
const drivePageToken = () => z.string().regex(/^[A-Za-z0-9_.~-]{1,512}$/);
/** `isGraphId` (onedrive.graph.ts). */
const graphId = () => z.string().regex(/^[A-Za-z0-9!_.=-]{5,255}$/);
/** `isGraphSkipToken`. */
const graphPageToken = () => z.string().regex(/^[A-Za-z0-9!_.~=%-]{1,1024}$/);
/** cloud-folders `isProviderId`: a Drive or a Graph id. */
const providerId = () => z.union([driveId(), graphId()]);
const uuid = () => z.string().uuid();
const storageProvider = () => z.enum(['google_drive', 'onedrive']);
const audience = () => z.enum(['internal', 'client_visible']);
const threadStatus = () => z.enum(['open', 'resolved', 'all']);

// review.service.ts: parseAnchor / parseStrokes / requiredBody / mentionedIds.
const unit = () => z.number().min(0).max(1);
const anchor = () =>
  z
    .union([
      z.object({ x: unit(), y: unit() }).strict(),
      z.object({ x: unit(), y: unit(), w: unit(), h: unit() }).strict(),
      z
        .object({
          strokes: z
            .array(
              z
                .object({
                  tool: z.enum(['pen', 'arrow', 'rect']),
                  color: z.string().regex(/^#[0-9a-f]{6}$/i),
                  width: f.int(1, 24).nullish(),
                  points: z
                    .array(z.tuple([unit(), unit()]))
                    .min(1)
                    .max(2000),
                })
                .strict(),
            )
            .min(1)
            .max(50),
        })
        .strict(),
      z
        .object({ timeMs: f.int(0, 2_147_483_647), x: unit().nullish(), y: unit().nullish() })
        .strict(),
      z
        .object({
          sheet: z.string().min(1).max(100),
          cell: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}$/),
        })
        .strict(),
    ])
    .nullish();
const reviewBody = () => f.text(10_000);
const mentions = () => z.array(uuid()).max(50).nullish();
const anchorKind = () => z.enum(['pin', 'box', 'draw', 'time', 'cell', 'none']).nullish();
const frameAnchorKind = () => z.enum(['pin', 'box', 'draw', 'none']).nullish();
const pageNo = () => f.int(1, 100_000).nullish();

const fileThreadInput = (param: string) =>
  bodyArgs([param], {
    body: reviewBody(),
    anchorKind: anchorKind(),
    anchor: anchor(),
    pageNo: pageNo(),
    versionId: z.string().max(64).nullish(),
    audience: audience().nullish(),
    mentions: mentions(),
  });
const frameThreadInput = () =>
  bodyArgs(['frameId'], {
    body: reviewBody(),
    anchorKind: frameAnchorKind(),
    anchor: anchor(),
    audience: audience().nullish(),
    mentions: mentions(),
  });
const commentInput = (param: string) =>
  bodyArgs([param], { body: reviewBody(), mentions: mentions() });
const moveInput = () =>
  bodyArgs(['threadId'], {
    anchor: anchor(),
    pageNo: pageNo(),
    versionId: z.string().max(64).nullish(),
  });

/** figma.rest.ts `NODE_ID` / `normaliseNodeId` (`1:2` or `1-2`, instance paths). */
const figmaNodeId = () =>
  z
    .string()
    .regex(/^(?:I?\d+[:-]\d+)(?:;\d+[:-]\d+)*$/)
    .max(64);
const FIGMA_ATTACH_TARGETS = [
  'work_item',
  'deliverable',
  'deliverable_version',
  'request',
  'file_asset',
] as const;
/** figma.rest.ts `MAX_CAPTURED_FRAMES`. */
const MAX_CAPTURED_FRAMES = 250;

const BINARY = ' The result is the file itself (bytes with its content type), not JSON.';

// ── Ops: one per route moved out of NEVER (71) ───────────────────────────────

export const filesOps: readonly AiActionOp[] = [
  // Google Drive as company storage (0210).
  op('google_drive.settings.set', 'PUT', '/integrations/google-drive/settings', 'org.manage', M),
  op('google_drive.storage.disconnect', 'DELETE', '/integrations/google-drive/', 'org.manage', M),
  op(
    'google_drive.project_files.list',
    'GET',
    '/integrations/google-drive/projects/:projectId/files',
    'work.update',
    R,
  ),
  op(
    'google_drive.root_options.list',
    'GET',
    '/integrations/google-drive/root-options',
    'org.manage',
    R,
  ),
  // OneDrive as company storage (0236).
  op('onedrive.settings.set', 'PUT', '/integrations/onedrive/settings', 'org.manage', M),
  op('onedrive.storage.disconnect', 'DELETE', '/integrations/onedrive/', 'org.manage', M),
  op('onedrive.folders.list', 'GET', '/integrations/onedrive/folders', 'org.manage', R),
  op('onedrive.root_options.list', 'GET', '/integrations/onedrive/root-options', 'org.manage', R),
  op(
    'onedrive.project_files.list',
    'GET',
    '/integrations/onedrive/projects/:projectId/files',
    'work.update',
    R,
  ),
  // 51-17 storage hand-over, 57-13b "Move to Drive".
  op(
    'storage.handover_targets.list',
    'GET',
    '/integrations/storage/handover-targets',
    'org.security.manage',
    R,
  ),
  op('storage.handover.create', 'POST', '/integrations/storage/handover', 'org.security.manage', M),
  op(
    'storage.migration_jobs.create',
    'POST',
    '/integrations/storage/migration-jobs/',
    'org.security.manage',
    M,
  ),
  op(
    'storage.migration_jobs.latest',
    'GET',
    '/integrations/storage/migration-jobs/',
    'org.security.manage',
    R,
  ),
  op(
    'storage.migration_jobs.get',
    'GET',
    '/integrations/storage/migration-jobs/:jobId',
    'org.security.manage',
    R,
  ),
  // The caller's own calendar connections (0237) and calendar sync (53-14).
  op('google_calendar.connection.get', 'GET', '/integrations/google-calendar/', 'meeting.read', R),
  op('google_calendar.team.list', 'GET', '/integrations/google-calendar/team', 'org.manage', R),
  op(
    'google_calendar.connection.disconnect',
    'DELETE',
    '/integrations/google-calendar/',
    'meeting.read',
    W,
  ),
  op(
    'microsoft_calendar.connection.get',
    'GET',
    '/integrations/microsoft-calendar/',
    'meeting.read',
    R,
  ),
  op(
    'microsoft_calendar.connection.disconnect',
    'DELETE',
    '/integrations/microsoft-calendar/',
    'meeting.read',
    W,
  ),
  op(
    'calendar_sync.due_date_mirror.set',
    'PUT',
    '/calendar-sync/:provider/due-date-mirror',
    'meeting.write',
    W,
  ),
  op('calendar_sync.feed.get', 'GET', '/calendar-sync/feed', 'meeting.read', R),
  op('calendar_sync.feed.revoke', 'DELETE', '/calendar-sync/feed', 'meeting.read', W),
  // File viewer previews (R4 slice 4).
  op('files.previews.manifest.get', 'GET', '/files/:fileAssetId/preview/', 'file.download', R),
  op(
    'files.previews.content.get',
    'GET',
    '/files/:fileAssetId/preview/:previewId/content',
    'file.download',
    R,
  ),
  op('files.previews.retry', 'POST', '/files/:fileAssetId/preview/retry', 'file.upload', W),
  op(
    'portal.files.previews.manifest.get',
    'GET',
    '/portal/files/:fileAssetId/preview/',
    'file.download',
    R,
  ),
  op(
    'portal.files.previews.content.get',
    'GET',
    '/portal/files/:fileAssetId/preview/:previewId/content',
    'file.download',
    R,
  ),
  // File review decisions (R4 slice 11).
  op('files.review.decisions.list', 'GET', '/files/:fileId/review/decisions/', 'file.download', R),
  op(
    'files.review.decisions.create',
    'POST',
    '/files/:fileId/review/decisions/',
    'approval.decide',
    W,
  ),
  op(
    'portal.files.review.decisions.list',
    'GET',
    '/portal/files/:fileId/review/decisions/',
    'file.download',
    R,
  ),
  op(
    'portal.files.review.decisions.create',
    'POST',
    '/portal/files/:fileId/review/decisions/',
    'approval.decide',
    M,
  ),
  // Studio review threads (R4 slice 5).
  op('files.review.threads.list', 'GET', '/files/:fileId/review/threads', 'file.download', R),
  op('files.review.threads.create', 'POST', '/files/:fileId/review/threads', 'file.upload', W),
  op(
    'review.threads.comments.create',
    'POST',
    '/review/threads/:threadId/comments',
    'file.upload',
    W,
  ),
  op('review.threads.resolve', 'POST', '/review/threads/:threadId/resolve', 'file.upload', W),
  op('review.threads.unresolve', 'POST', '/review/threads/:threadId/unresolve', 'file.upload', W),
  op('review.threads.move', 'PATCH', '/review/threads/:threadId', 'file.upload', W),
  op('review.comments.update', 'PATCH', '/review/comments/:commentId', 'file.upload', W),
  op('review.comments.delete', 'DELETE', '/review/comments/:commentId', 'file.upload', W),
  op(
    'review.mention_candidates.list',
    'GET',
    '/projects/:projectId/review/mention-candidates',
    'work.read',
    R,
  ),
  // Portal review threads (R4 slice 8): client-facing, so `manage`.
  op(
    'portal.files.review.threads.list',
    'GET',
    '/portal/files/:fileId/review/threads',
    'file.download',
    R,
  ),
  op(
    'portal.files.review.threads.create',
    'POST',
    '/portal/files/:fileId/review/threads',
    'file.upload',
    M,
  ),
  op(
    'portal.review.threads.comments.create',
    'POST',
    '/portal/review/threads/:threadId/comments',
    'file.upload',
    M,
  ),
  op(
    'portal.review.threads.resolve',
    'POST',
    '/portal/review/threads/:threadId/resolve',
    'file.upload',
    M,
  ),
  op(
    'portal.review.threads.unresolve',
    'POST',
    '/portal/review/threads/:threadId/unresolve',
    'file.upload',
    M,
  ),
  op('portal.review.threads.move', 'PATCH', '/portal/review/threads/:threadId', 'file.upload', M),
  op(
    'portal.review.comments.update',
    'PATCH',
    '/portal/review/comments/:commentId',
    'file.upload',
    M,
  ),
  op(
    'portal.review.comments.delete',
    'DELETE',
    '/portal/review/comments/:commentId',
    'file.upload',
    M,
  ),
  op(
    'portal.review.mention_candidates.list',
    'GET',
    '/portal/projects/:projectId/review/mention-candidates',
    'client_projection.read',
    R,
  ),
  // Figma links (R4 slice 13).
  op('figma.connection.get', 'GET', '/figma/connection', 'work.read', R),
  op('figma.connection.disconnect', 'DELETE', '/figma/connection', 'work.read', W),
  op('figma.links.get', 'GET', '/figma/links/:linkId', 'file.download', R),
  op('figma.links.snapshots.refresh', 'POST', '/figma/links/:linkId/snapshots', 'file.upload', W),
  op('figma.links.pages.set', 'PUT', '/figma/links/:linkId/pages', 'file.upload', W),
  op('figma.links.delete', 'DELETE', '/figma/links/:linkId', 'file.upload', W),
  op('figma.frames.snapshot.get', 'GET', '/figma/frames/:frameId/snapshot', 'file.download', R),
  op('figma.frames.thumb.get', 'GET', '/figma/frames/:frameId/thumb', 'file.download', R),
  op('figma.frames.render.get', 'GET', '/figma/frames/:frameId/render', 'file.download', R),
  op('figma.inspect', 'POST', '/projects/:projectId/figma/inspect', 'file.upload', W),
  op('figma.links.create', 'POST', '/projects/:projectId/figma/links', 'file.upload', W),
  op('figma.links.list', 'GET', '/projects/:projectId/figma/links', 'file.download', R),
  op('portal.figma.links.list', 'GET', '/portal/figma/links', 'client_projection.read', R),
  op('portal.figma.links.get', 'GET', '/portal/figma/links/:linkId', 'client_projection.read', R),
  op(
    'portal.figma.project_links.list',
    'GET',
    '/portal/projects/:projectId/figma/links',
    'client_projection.read',
    R,
  ),
  op(
    'portal.figma.frames.snapshot.get',
    'GET',
    '/portal/figma/frames/:frameId/snapshot',
    'client_projection.read',
    R,
  ),
  op(
    'portal.figma.frames.thumb.get',
    'GET',
    '/portal/figma/frames/:frameId/thumb',
    'client_projection.read',
    R,
  ),
  op(
    'portal.figma.frames.render.get',
    'GET',
    '/portal/figma/frames/:frameId/render',
    'client_projection.read',
    R,
  ),
  // Threads on Figma frames.
  op(
    'figma.frames.review.threads.list',
    'GET',
    '/figma/frames/:frameId/review/threads',
    'file.download',
    R,
  ),
  op(
    'figma.frames.review.threads.create',
    'POST',
    '/figma/frames/:frameId/review/threads',
    'file.upload',
    W,
  ),
  op(
    'portal.figma.frames.review.threads.list',
    'GET',
    '/portal/figma/frames/:frameId/review/threads',
    'file.download',
    R,
  ),
  op(
    'portal.figma.frames.review.threads.create',
    'POST',
    '/portal/figma/frames/:frameId/review/threads',
    'file.upload',
    M,
  ),
];

// ── Sensitivity: every new op that is not a read ─────────────────────────────

export const filesSensitivity: Readonly<Record<string, Sensitivity>> = {
  'google_drive.settings.set': 'none',
  'google_drive.storage.disconnect': 'destructive',
  'onedrive.settings.set': 'none',
  'onedrive.storage.disconnect': 'destructive',
  'storage.handover.create': 'none',
  // Moves every file TManage still holds into the provider: a bulk rewrite.
  'storage.migration_jobs.create': 'destructive',
  'google_calendar.connection.disconnect': 'destructive',
  'microsoft_calendar.connection.disconnect': 'destructive',
  'calendar_sync.due_date_mirror.set': 'none',
  'calendar_sync.feed.revoke': 'destructive',
  'files.previews.retry': 'none',
  'files.review.decisions.create': 'none',
  'portal.files.review.decisions.create': 'external',
  // A thread or reply may be client-visible (audience), so it can reach outside the team.
  'files.review.threads.create': 'external',
  'review.threads.comments.create': 'external',
  'review.threads.resolve': 'none',
  'review.threads.unresolve': 'none',
  'review.threads.move': 'none',
  'review.comments.update': 'external',
  'review.comments.delete': 'destructive',
  'portal.files.review.threads.create': 'external',
  'portal.review.threads.comments.create': 'external',
  'portal.review.threads.resolve': 'external',
  'portal.review.threads.unresolve': 'external',
  'portal.review.threads.move': 'external',
  'portal.review.comments.update': 'external',
  'portal.review.comments.delete': 'destructive',
  'figma.connection.disconnect': 'destructive',
  'figma.links.snapshots.refresh': 'none',
  'figma.links.pages.set': 'none',
  'figma.links.delete': 'destructive',
  'figma.inspect': 'none',
  // `audience: client_visible` shows the design in the client portal.
  'figma.links.create': 'external',
  'figma.frames.review.threads.create': 'external',
  'portal.figma.frames.review.threads.create': 'external',
};

// ── Details: the 71 new ops and the 25 classified ops that had none ──────────

const newOpDetails: readonly AiActionDetail[] = [
  // Google Drive.
  det({
    id: 'google_drive.settings.set',
    title: 'Change the Google Drive storage settings',
    description:
      'Switch where the company keeps files (storageMode tmanage or google_drive) and/or the ' +
      'Drive location: {kind: my_drive}, {kind: folder, folderId} or {kind: shared_drive, ' +
      'driveId} (ids from google_drive.root_options.list). Send at least one of the two. ' +
      'Owner/admin (org.manage); returns the storage status (google_drive.storage.get).',
    input: bodyArgs([], {
      storageMode: z.enum(['tmanage', 'google_drive']).optional(),
      location: z
        .object({
          kind: z.enum(['my_drive', 'folder', 'shared_drive']),
          folderId: driveId().optional(),
          driveId: driveId().optional(),
        })
        .strict()
        .optional(),
    }),
    redact: 'config',
    examples: [{ summary: 'Keep files in Google Drive', args: { storageMode: 'google_drive' } }],
  }),
  det({
    id: 'google_drive.storage.disconnect',
    title: 'Disconnect Google Drive',
    description:
      "Disconnect the company's Google Drive: the token is revoked and wiped, and storage falls " +
      'back to TManage. Files already in Drive stay there. Owner/admin only; returns the status.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Disconnect', args: {} }],
  }),
  det({
    id: 'google_drive.project_files.list',
    title: "List a project's Google Drive files",
    description:
      "List one of the project's own TManage folders in the company Google Drive (projectId " +
      'from projects.list). Optional folderId opens a sub-folder; pageToken is the nextPageToken ' +
      'of the previous page. Needs work.update on the project.',
    input: bodyArgs(['projectId'], {
      folderId: driveId().optional(),
      pageToken: drivePageToken().optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'Project root folder', args: { projectId: 'pr_1' } }],
  }),
  det({
    id: 'google_drive.root_options.list',
    title: 'List Shared Drives for the company folder',
    description:
      'The Shared Drives the connected Google account can hold the company root folder in, for ' +
      'google_drive.settings.set. Owner/admin only.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Shared Drives', args: {} }],
  }),
  // OneDrive.
  det({
    id: 'onedrive.settings.set',
    title: 'Change the OneDrive storage settings',
    description:
      'Switch where the company keeps files (storageMode tmanage or onedrive) and/or the root ' +
      'location: {kind: my_files}, {kind: folder, driveId, itemId} (from onedrive.folders.list) ' +
      'or {kind: library, driveId} (from onedrive.root_options.list). Send at least one of the ' +
      'two. Owner/admin only; returns the storage status (onedrive.storage.get).',
    input: bodyArgs([], {
      storageMode: z.enum(['tmanage', 'onedrive']).optional(),
      location: z
        .object({
          kind: z.enum(['my_files', 'folder', 'library']),
          driveId: graphId().optional(),
          itemId: graphId().optional(),
        })
        .strict()
        .optional(),
    }),
    redact: 'config',
    examples: [{ summary: 'Keep files in OneDrive', args: { storageMode: 'onedrive' } }],
  }),
  det({
    id: 'onedrive.storage.disconnect',
    title: 'Disconnect OneDrive',
    description:
      "Disconnect the company's OneDrive: the token is wiped and storage falls back to " +
      'TManage. Files already in OneDrive stay there. Owner/admin only; returns the status.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Disconnect', args: {} }],
  }),
  det({
    id: 'onedrive.folders.list',
    title: 'Browse OneDrive folders',
    description:
      "Sub-folders of the connected OneDrive (the root, or folderId), for choosing the company's " +
      "root folder with onedrive.settings.set. pageToken is the previous page's token. " +
      'Owner/admin only.',
    input: bodyArgs([], {
      folderId: graphId().optional(),
      pageToken: graphPageToken().optional(),
    }),
    redact: 'config',
    examples: [{ summary: 'Top-level folders', args: {} }],
  }),
  det({
    id: 'onedrive.root_options.list',
    title: 'List SharePoint libraries for the company folder',
    description:
      'The SharePoint libraries the connected Microsoft account can hold the company root in, ' +
      'for onedrive.settings.set. Owner/admin only.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Libraries', args: {} }],
  }),
  det({
    id: 'onedrive.project_files.list',
    title: "List a project's OneDrive files",
    description:
      "List one of the project's own TManage folders in the company OneDrive (projectId from " +
      "projects.list). Optional folderId opens a sub-folder; pageToken is the previous page's " +
      'token. Needs work.update on the project.',
    input: bodyArgs(['projectId'], {
      folderId: graphId().optional(),
      pageToken: graphPageToken().optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'Project root folder', args: { projectId: 'pr_1' } }],
  }),
  // Storage hand-over and move.
  det({
    id: 'storage.handover_targets.list',
    title: 'List admins who can take over company storage',
    description:
      'The owners and admins who could hold the company Google Drive or OneDrive connection ' +
      '(provider google_drive or onedrive), with whether each is ready (two-step sign-in). ' +
      'Owner/org admin (org.security.manage).',
    input: bodyArgs([], { provider: storageProvider() }),
    redact: 'people',
    examples: [{ summary: 'Drive candidates', args: { provider: 'google_drive' } }],
  }),
  det({
    id: 'storage.handover.create',
    title: 'Hand company storage over to another admin',
    description:
      'Name the admin (toUserId from storage.handover_targets.list) who takes over the company ' +
      'storage connection for provider; it completes when that admin reconnects from the ' +
      'Storage screen. Refused (409) when the storage is not connected or the admin lacks ' +
      'two-step sign-in. Owner/org admin only.',
    input: bodyArgs([], { provider: storageProvider(), toUserId: uuid() }),
    redact: 'people',
    notifies: true,
    examples: [
      {
        summary: 'Hand Drive to an admin',
        args: { provider: 'google_drive', toUserId: '0192e4a0-0000-7000-8000-000000000001' },
      },
    ],
  }),
  det({
    id: 'storage.migration_jobs.create',
    title: 'Move company files into Drive or OneDrive',
    description:
      'Start moving every file TManage still stores into the connected provider (google_drive ' +
      'or onedrive), or answer the job already running. Returns the job (id, state, counts); ' +
      'follow it with storage.migration_jobs.get. Refused (409) when the provider is not ' +
      'connected. Owner/org admin only.',
    input: bodyArgs([], { provider: storageProvider() }),
    redact: 'standard',
    examples: [{ summary: 'Move to Drive', args: { provider: 'google_drive' } }],
  }),
  det({
    id: 'storage.migration_jobs.latest',
    title: 'Show the latest storage move',
    description:
      'The latest "Move to Drive/OneDrive" job with its progress and counts, or none. ' +
      'Owner/org admin only.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Latest move', args: {} }],
  }),
  det({
    id: 'storage.migration_jobs.get',
    title: 'Show a storage move',
    description:
      "One storage move job's state, progress and counts (jobId from " +
      'storage.migration_jobs.latest or .create). Owner/org admin only.',
    input: pathOnly('jobId'),
    redact: 'standard',
    examples: [{ summary: 'Job progress', args: { jobId: 'job_1' } }],
  }),
  // Calendars.
  det({
    id: 'google_calendar.connection.get',
    title: 'Show my Google Calendar connection',
    description:
      "The caller's own Google Calendar + Meet connection: whether it is connected, the account " +
      'and the due-date mirror setting. Never a token.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'My connection', args: {} }],
  }),
  det({
    id: 'google_calendar.team.list',
    title: "List the team's calendar connections",
    description:
      'Which members have connected Google Calendar (Settings > Calendar connections, "Your ' +
      'team\'s calendars"). Owners/admins (org.manage) only.',
    input: noArgs(),
    redact: 'people',
    examples: [{ summary: 'Team calendars', args: {} }],
  }),
  det({
    id: 'google_calendar.connection.disconnect',
    title: 'Disconnect my Google Calendar',
    description:
      "Disconnect the caller's own Google Calendar: the token is revoked and wiped; meetings " +
      'stay in TManage. Returns the connection status.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Disconnect', args: {} }],
  }),
  det({
    id: 'microsoft_calendar.connection.get',
    title: 'Show my Outlook calendar connection',
    description:
      "The caller's own Microsoft (Outlook) calendar connection: whether it is connected, the " +
      'account and the due-date mirror setting. Never a token.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'My connection', args: {} }],
  }),
  det({
    id: 'microsoft_calendar.connection.disconnect',
    title: 'Disconnect my Outlook calendar',
    description:
      "Disconnect the caller's own Microsoft calendar: the token is wiped; meetings stay in " +
      'TManage. Returns the connection status.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Disconnect', args: {} }],
  }),
  det({
    id: 'calendar_sync.due_date_mirror.set',
    title: 'Turn the due-date mirror on or off',
    description:
      "Mirror the caller's work-item due dates into their own connected calendar (provider " +
      "google or microsoft) or stop it. Answers that connection's status.",
    input: bodyArgs(['provider'], { enabled: f.bool() }),
    redact: 'standard',
    examples: [{ summary: 'Mirror to Google', args: { provider: 'google', enabled: true } }],
  }),
  det({
    id: 'calendar_sync.feed.get',
    title: 'Show whether I have a calendar feed',
    description:
      'Whether the caller has a private ICS calendar feed address, and when it was made. Never ' +
      'the address itself (it is shown once, in the app, when created).',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Feed status', args: {} }],
  }),
  det({
    id: 'calendar_sync.feed.revoke',
    title: 'Turn off my calendar feed',
    description:
      "Revoke the caller's private ICS feed address; calendar apps subscribed to it stop " +
      'updating. Returns the feed status.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Revoke feed', args: {} }],
  }),
  // Previews.
  det({
    id: 'files.previews.manifest.get',
    title: "Show a file's preview manifest",
    description:
      'The viewer manifest for a file (fileAssetId from work_items.files.list or files.versions' +
      '.list): its previews (ids, kinds, states, pages) and what the caller may do. Optional ' +
      'deliverableVersionId opens it as that deliverable version.',
    input: bodyArgs(['fileAssetId'], { deliverableVersionId: z.string().max(64).optional() }),
    redact: 'standard',
    examples: [{ summary: 'Manifest', args: { fileAssetId: 'fa_1' } }],
  }),
  det({
    id: 'files.previews.content.get',
    title: 'Get a preview image or page',
    description:
      'The bytes of one TManage-made preview of a file (previewId from ' +
      'files.previews.manifest.get).' +
      BINARY +
      ' The manifest gives the same facts as JSON.',
    input: pathOnly('fileAssetId', 'previewId'),
    redact: 'standard',
    examples: [{ summary: 'Page 1', args: { fileAssetId: 'fa_1', previewId: 'pv_1' } }],
  }),
  det({
    id: 'files.previews.retry',
    title: "Retry a file's failed previews",
    description:
      "Put a file's failed previews back in the queue (fileAssetId). Returns how many were " +
      'queued. Needs file.upload and access to the file.',
    input: pathOnly('fileAssetId'),
    redact: 'standard',
    examples: [{ summary: 'Retry', args: { fileAssetId: 'fa_1' } }],
  }),
  det({
    id: 'portal.files.previews.manifest.get',
    title: "Show a portal file's preview manifest",
    description:
      'The client portal viewer manifest for a client-visible file (fileAssetId from ' +
      'portal.projects.files.list). Works only for a client principal.',
    input: bodyArgs(['fileAssetId'], { deliverableVersionId: z.string().max(64).optional() }),
    redact: 'client_safe',
    examples: [{ summary: 'Manifest', args: { fileAssetId: 'fa_1' } }],
  }),
  det({
    id: 'portal.files.previews.content.get',
    title: 'Get a portal preview image or page',
    description:
      'The bytes of one preview of a client-visible file (previewId from ' +
      'portal.files.previews.manifest.get).' +
      BINARY +
      ' Works only for a client principal.',
    input: pathOnly('fileAssetId', 'previewId'),
    redact: 'client_safe',
    examples: [{ summary: 'Page 1', args: { fileAssetId: 'fa_1', previewId: 'pv_1' } }],
  }),
  // Decisions.
  det({
    id: 'files.review.decisions.list',
    title: "List a file's review decisions",
    description:
      "Approve / request-changes decisions on a file's versions and each version's review " +
      'state (fileId from work_items.files.list).',
    input: pathOnly('fileId'),
    redact: 'standard',
    examples: [{ summary: 'Decisions', args: { fileId: 'fa_1' } }],
  }),
  det({
    id: 'files.review.decisions.create',
    title: 'Approve or request changes on a file',
    description:
      'Record approved or changes_requested on a file version (fileAssetId: a version of fileId, ' +
      'default the file itself). note (max 2000) is required for changes_requested. A ' +
      'deliverable is refused (409 use_deliverable_approval): use its approval instead.',
    input: bodyArgs(['fileId'], {
      fileAssetId: z.string().min(1).max(36).optional(),
      decision: z.enum(['approved', 'changes_requested']),
      note: z.string().max(2000).nullish(),
    }),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Approve', args: { fileId: 'fa_1', decision: 'approved' } }],
  }),
  det({
    id: 'portal.files.review.decisions.list',
    title: "List a portal file's review decisions",
    description:
      "The client's view of a file's decisions (client decisions only). Works only for a " +
      'client principal.',
    input: pathOnly('fileId'),
    redact: 'client_safe',
    examples: [{ summary: 'Decisions', args: { fileId: 'fa_1' } }],
  }),
  det({
    id: 'portal.files.review.decisions.create',
    title: 'Approve or request changes as the client',
    description:
      "Record the client's approved or changes_requested on a file version; note is required " +
      'for changes_requested. Works only for a client principal whose role can decide.',
    input: bodyArgs(['fileId'], {
      fileAssetId: z.string().min(1).max(36).optional(),
      decision: z.enum(['approved', 'changes_requested']),
      note: z.string().max(2000).nullish(),
    }),
    redact: 'client_safe',
    notifies: true,
    examples: [
      {
        summary: 'Ask for changes',
        args: { fileId: 'fa_1', decision: 'changes_requested', note: 'Logo larger, please.' },
      },
    ],
  }),
  // Studio review threads.
  det({
    id: 'files.review.threads.list',
    title: "List a file's review threads",
    description:
      'Comment threads (pins, boxes, drawings, moments, cells) on a file with their comments. ' +
      'Optional versionId (one version) and status open, resolved or all.',
    input: bodyArgs(['fileId'], {
      versionId: z.string().max(64).optional(),
      status: threadStatus().optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'Open threads', args: { fileId: 'fa_1', status: 'open' } }],
  }),
  det({
    id: 'files.review.threads.create',
    title: 'Comment on a file',
    description:
      'Open a review thread on a file with its first comment (body, max 10000). anchorKind ' +
      'pin {x,y}, box {x,y,w,h}, draw {strokes}, time {timeMs}, cell {sheet,cell} or none; ' +
      'coordinates are 0..1 of the page (pageNo). audience internal or client_visible ' +
      '(mentioning a client makes it client_visible); mentions are user ids from ' +
      'review.mention_candidates.list. versionId, if sent, must be the latest version.',
    input: fileThreadInput('fileId'),
    redact: 'standard',
    notifies: true,
    examples: [
      {
        summary: 'Pin on page 2',
        args: {
          fileId: 'fa_1',
          body: 'Typo in the headline.',
          anchorKind: 'pin',
          anchor: { x: 0.4, y: 0.2 },
          pageNo: 2,
        },
      },
    ],
  }),
  det({
    id: 'review.threads.comments.create',
    title: 'Reply on a review thread',
    description:
      'Add a reply (body, max 10000) to a review thread (threadId from files.review.threads.list ' +
      'or figma.frames.review.threads.list). mentions are user ids; the reply is seen by ' +
      'whoever sees the thread, the client too on a client-visible one.',
    input: commentInput('threadId'),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Reply', args: { threadId: 'th_1', body: 'Fixed in v3.' } }],
  }),
  det({
    id: 'review.threads.resolve',
    title: 'Resolve a review thread',
    description: 'Mark a review thread resolved (threadId). Returns the thread.',
    input: pathOnly('threadId'),
    redact: 'standard',
    examples: [{ summary: 'Resolve', args: { threadId: 'th_1' } }],
  }),
  det({
    id: 'review.threads.unresolve',
    title: 'Reopen a review thread',
    description: 'Reopen a resolved review thread (threadId). Returns the thread.',
    input: pathOnly('threadId'),
    redact: 'standard',
    examples: [{ summary: 'Reopen', args: { threadId: 'th_1' } }],
  }),
  det({
    id: 'review.threads.move',
    title: 'Move my review pin',
    description:
      "Move the caller's own thread to a new place on the version it was drawn on: anchor in the " +
      "thread's own kind (0..1 coordinates) and pageNo. Only the thread's author; a thread with " +
      'no place cannot move.',
    input: moveInput(),
    redact: 'standard',
    examples: [{ summary: 'Move pin', args: { threadId: 'th_1', anchor: { x: 0.5, y: 0.5 } } }],
  }),
  det({
    id: 'review.comments.update',
    title: 'Edit my review comment',
    description:
      "Change the text (body, max 10000) and mentions of the caller's own review comment, " +
      'within fifteen minutes of posting.',
    input: commentInput('commentId'),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Fix wording', args: { commentId: 'cm_1', body: 'Typo in the title.' } }],
  }),
  det({
    id: 'review.comments.delete',
    title: 'Delete my review comment',
    description: "Delete the caller's own review comment (commentId). An absent one is a no-op.",
    input: pathOnly('commentId'),
    redact: 'standard',
    examples: [{ summary: 'Delete', args: { commentId: 'cm_1' } }],
  }),
  det({
    id: 'review.mention_candidates.list',
    title: 'Find people to mention in a review',
    description:
      'People who may be @mentioned on a review comment in a project: q is a name prefix (max ' +
      '100), audience client_visible adds client people, limit 1-25 (default 10).',
    input: bodyArgs(['projectId'], {
      q: z.string().max(100).optional(),
      audience: audience().optional(),
      limit: f.int(1, 25).optional(),
    }),
    redact: 'people',
    examples: [{ summary: 'Names starting Sa', args: { projectId: 'pr_1', q: 'Sa' } }],
  }),
  // Portal review threads.
  det({
    id: 'portal.files.review.threads.list',
    title: "List a portal file's review threads",
    description:
      'The client-visible threads on a file (status open, resolved or all). Works only for a ' +
      'client principal.',
    input: bodyArgs(['fileId'], { status: threadStatus().optional() }),
    redact: 'client_safe',
    examples: [{ summary: 'Open threads', args: { fileId: 'fa_1', status: 'open' } }],
  }),
  det({
    id: 'portal.files.review.threads.create',
    title: 'Comment on a file as the client',
    description:
      'Open a client-visible review thread on a file with its first comment; same anchor ' +
      'rules as files.review.threads.create (audience may only be client_visible). Works only ' +
      'for a client principal.',
    input: fileThreadInput('fileId'),
    redact: 'client_safe',
    notifies: true,
    examples: [{ summary: 'General comment', args: { fileId: 'fa_1', body: 'Looks great.' } }],
  }),
  det({
    id: 'portal.review.threads.comments.create',
    title: 'Reply on a review thread as the client',
    description:
      'Add a client reply (body, max 10000) to a client-visible review thread. Works only for ' +
      'a client principal.',
    input: commentInput('threadId'),
    redact: 'client_safe',
    notifies: true,
    examples: [{ summary: 'Reply', args: { threadId: 'th_1', body: 'Thanks, approved.' } }],
  }),
  det({
    id: 'portal.review.threads.resolve',
    title: 'Resolve a review thread as the client',
    description: 'Mark a client-visible review thread resolved. Works only for a client principal.',
    input: pathOnly('threadId'),
    redact: 'client_safe',
    examples: [{ summary: 'Resolve', args: { threadId: 'th_1' } }],
  }),
  det({
    id: 'portal.review.threads.unresolve',
    title: 'Reopen a review thread as the client',
    description: 'Reopen a client-visible review thread. Works only for a client principal.',
    input: pathOnly('threadId'),
    redact: 'client_safe',
    examples: [{ summary: 'Reopen', args: { threadId: 'th_1' } }],
  }),
  det({
    id: 'portal.review.threads.move',
    title: 'Move my review pin as the client',
    description:
      "Move the client's own thread on the version it was drawn on (anchor, pageNo). Works only " +
      'for a client principal and the thread author.',
    input: moveInput(),
    redact: 'client_safe',
    examples: [{ summary: 'Move pin', args: { threadId: 'th_1', anchor: { x: 0.3, y: 0.6 } } }],
  }),
  det({
    id: 'portal.review.comments.update',
    title: 'Edit my review comment as the client',
    description:
      "Change the client's own review comment within fifteen minutes. Works only for a client " +
      'principal.',
    input: commentInput('commentId'),
    redact: 'client_safe',
    notifies: true,
    examples: [{ summary: 'Fix wording', args: { commentId: 'cm_1', body: 'Logo bigger.' } }],
  }),
  det({
    id: 'portal.review.comments.delete',
    title: 'Delete my review comment as the client',
    description: "Delete the client's own review comment. Works only for a client principal.",
    input: pathOnly('commentId'),
    redact: 'client_safe',
    examples: [{ summary: 'Delete', args: { commentId: 'cm_1' } }],
  }),
  det({
    id: 'portal.review.mention_candidates.list',
    title: 'Find people to mention as the client',
    description:
      'People a client may @mention on a review comment in a project (q name prefix, limit ' +
      '1-25). Works only for a client principal.',
    input: bodyArgs(['projectId'], {
      q: z.string().max(100).optional(),
      limit: f.int(1, 25).optional(),
    }),
    redact: 'client_safe',
    examples: [{ summary: 'Names starting Sa', args: { projectId: 'pr_1', q: 'Sa' } }],
  }),
  // Figma.
  det({
    id: 'figma.connection.get',
    title: 'Show my Figma connection',
    description:
      "The caller's own Figma connection: connected or not and the token's last four " +
      'characters, never the token.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'My Figma', args: {} }],
  }),
  det({
    id: 'figma.connection.disconnect',
    title: 'Disconnect my Figma account',
    description:
      "Remove the caller's own stored Figma token. Attached links keep their stored snapshots " +
      'but cannot refresh with this token. Returns the connection status.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Disconnect', args: {} }],
  }),
  det({
    id: 'figma.links.get',
    title: 'Open a Figma link',
    description:
      "A Figma link's viewer manifest (linkId from figma.links.list): frames with ids, " +
      'snapshot states, pages and what the caller may do.',
    input: pathOnly('linkId'),
    redact: 'standard',
    examples: [{ summary: 'Open', args: { linkId: 'fl_1' } }],
  }),
  det({
    id: 'figma.links.snapshots.refresh',
    title: 'Refresh a Figma link from Figma',
    description:
      "Read the Figma file again (new, renamed, moved and removed frames) with the caller's " +
      'Figma token and redraw every captured frame. Accepted (202); rate-limited by Figma.',
    input: pathOnly('linkId'),
    redact: 'standard',
    examples: [{ summary: 'Refresh', args: { linkId: 'fl_1' } }],
  }),
  det({
    id: 'figma.links.pages.set',
    title: 'Choose which Figma pages to capture',
    description:
      'Capture only some pages of a large Figma file: pageIds are page ids from figma.links.get ' +
      '(at least one), or null for every page. Returns the link.',
    input: bodyArgs(['linkId'], { pageIds: z.array(figmaNodeId()).min(1).nullish() }),
    redact: 'standard',
    examples: [{ summary: 'Two pages', args: { linkId: 'fl_1', pageIds: ['0:1', '12:3'] } }],
  }),
  det({
    id: 'figma.links.delete',
    title: 'Remove a Figma link',
    description:
      'Remove a Figma link from its project, with its stored snapshots and frame threads.',
    input: pathOnly('linkId'),
    redact: 'standard',
    examples: [{ summary: 'Remove', args: { linkId: 'fl_1' } }],
  }),
  det({
    id: 'figma.frames.snapshot.get',
    title: 'Get a Figma frame snapshot',
    description:
      "A frame's stored PNG snapshot (frameId from figma.links.get)." +
      BINARY +
      ' figma.links.get gives the frame facts as JSON.',
    input: pathOnly('frameId'),
    redact: 'standard',
    examples: [{ summary: 'Snapshot', args: { frameId: 'fr_1' } }],
  }),
  det({
    id: 'figma.frames.thumb.get',
    title: 'Get a Figma frame thumbnail',
    description: "A small PNG of a frame's snapshot (frameId from figma.links.get)." + BINARY,
    input: pathOnly('frameId'),
    redact: 'standard',
    examples: [{ summary: 'Thumbnail', args: { frameId: 'fr_1' } }],
  }),
  det({
    id: 'figma.frames.render.get',
    title: 'Get a sharp Figma frame render',
    description:
      'The frame rendered sharper for zooming (made once, then stored; rate-limited).' + BINARY,
    input: pathOnly('frameId'),
    redact: 'standard',
    examples: [{ summary: 'Render', args: { frameId: 'fr_1' } }],
  }),
  det({
    id: 'figma.inspect',
    title: 'Read a Figma link before attaching it',
    description:
      "Read a pasted Figma design URL (url, max 1000) with the caller's Figma token: the file's " +
      'name, pages and frames (node ids for figma.links.create). Changes nothing.',
    input: bodyArgs(['projectId'], { url: f.text(1000) }),
    redact: 'standard',
    examples: [
      {
        summary: 'Inspect',
        args: { projectId: 'pr_1', url: 'https://www.figma.com/design/AbC123/Homepage' },
      },
    ],
  }),
  det({
    id: 'figma.links.create',
    title: 'Attach a Figma file to a project',
    description:
      'Attach a Figma design (url) to a project, the whole file or only nodeIds (frame ids from ' +
      `figma.inspect, max ${MAX_CAPTURED_FRAMES}); optionally to one item: attachedTo {type, id}. ` +
      'audience internal (default) or client_visible (shown in the client portal). Snapshots ' +
      'are captured in the background.',
    input: bodyArgs(['projectId'], {
      url: f.text(1000),
      nodeIds: z.array(figmaNodeId()).min(1).max(MAX_CAPTURED_FRAMES).nullish(),
      audience: audience().nullish(),
      attachedTo: z
        .object({ type: z.enum(FIGMA_ATTACH_TARGETS), id: uuid() })
        .strict()
        .nullish(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Whole file, internal',
        args: { projectId: 'pr_1', url: 'https://www.figma.com/design/AbC123/Homepage' },
      },
    ],
  }),
  det({
    id: 'figma.links.list',
    title: "List a project's Figma links",
    description:
      "The project's Figma links, or only those attached to one item: attachedToType (" +
      `${FIGMA_ATTACH_TARGETS.join(', ')}) together with attachedToId.`,
    input: bodyArgs(['projectId'], {
      attachedToType: z.enum(FIGMA_ATTACH_TARGETS).optional(),
      attachedToId: uuid().optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'All links', args: { projectId: 'pr_1' } }],
  }),
  det({
    id: 'portal.figma.links.list',
    title: 'List Figma designs shared with the client',
    description:
      "Every client-visible Figma link across the client's projects. Works only for a client " +
      'principal.',
    input: noArgs(),
    redact: 'client_safe',
    examples: [{ summary: 'All shared designs', args: {} }],
  }),
  det({
    id: 'portal.figma.links.get',
    title: 'Open a Figma link as the client',
    description:
      "A client-visible Figma link's viewer manifest. Works only for a client principal.",
    input: pathOnly('linkId'),
    redact: 'client_safe',
    examples: [{ summary: 'Open', args: { linkId: 'fl_1' } }],
  }),
  det({
    id: 'portal.figma.project_links.list',
    title: "List a project's Figma links as the client",
    description:
      "A project's client-visible Figma links (optionally attachedToType with attachedToId). " +
      'Works only for a client principal.',
    input: bodyArgs(['projectId'], {
      attachedToType: z.enum(FIGMA_ATTACH_TARGETS).optional(),
      attachedToId: uuid().optional(),
    }),
    redact: 'client_safe',
    examples: [{ summary: 'Project designs', args: { projectId: 'pr_1' } }],
  }),
  det({
    id: 'portal.figma.frames.snapshot.get',
    title: 'Get a Figma frame snapshot as the client',
    description:
      "A client-visible frame's stored PNG snapshot." + BINARY + ' Client principal only.',
    input: pathOnly('frameId'),
    redact: 'client_safe',
    examples: [{ summary: 'Snapshot', args: { frameId: 'fr_1' } }],
  }),
  det({
    id: 'portal.figma.frames.thumb.get',
    title: 'Get a Figma frame thumbnail as the client',
    description: 'A small PNG of a client-visible frame.' + BINARY + ' Client principal only.',
    input: pathOnly('frameId'),
    redact: 'client_safe',
    examples: [{ summary: 'Thumbnail', args: { frameId: 'fr_1' } }],
  }),
  det({
    id: 'portal.figma.frames.render.get',
    title: 'Get a sharp Figma frame render as the client',
    description:
      'A client-visible frame rendered sharper for zooming.' + BINARY + ' Client principal only.',
    input: pathOnly('frameId'),
    redact: 'client_safe',
    examples: [{ summary: 'Render', args: { frameId: 'fr_1' } }],
  }),
  det({
    id: 'figma.frames.review.threads.list',
    title: "List a Figma frame's review threads",
    description:
      "Comment threads on a Figma frame's snapshot (frameId from figma.links.get), status open, " +
      'resolved or all.',
    input: bodyArgs(['frameId'], { status: threadStatus().optional() }),
    redact: 'standard',
    examples: [{ summary: 'Open threads', args: { frameId: 'fr_1', status: 'open' } }],
  }),
  det({
    id: 'figma.frames.review.threads.create',
    title: 'Comment on a Figma frame',
    description:
      'Open a thread on a Figma frame with its first comment (body): anchorKind pin, box, draw ' +
      'or none, 0..1 coordinates. A thread on an internal link stays internal; client_visible ' +
      'only on a client-visible link. Reply with review.threads.comments.create.',
    input: frameThreadInput(),
    redact: 'standard',
    notifies: true,
    examples: [
      {
        summary: 'Box on the hero',
        args: {
          frameId: 'fr_1',
          body: 'Spacing too tight here.',
          anchorKind: 'box',
          anchor: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 },
        },
      },
    ],
  }),
  det({
    id: 'portal.figma.frames.review.threads.list',
    title: "List a Figma frame's threads as the client",
    description:
      'Client-visible threads on a Figma frame (status open, resolved or all). Client ' +
      'principal only.',
    input: bodyArgs(['frameId'], { status: threadStatus().optional() }),
    redact: 'client_safe',
    examples: [{ summary: 'Threads', args: { frameId: 'fr_1' } }],
  }),
  det({
    id: 'portal.figma.frames.review.threads.create',
    title: 'Comment on a Figma frame as the client',
    description:
      'Open a client-visible thread on a Figma frame (anchorKind pin, box, draw or none). ' +
      'Client principal only.',
    input: frameThreadInput(),
    redact: 'client_safe',
    notifies: true,
    examples: [{ summary: 'Comment', args: { frameId: 'fr_1', body: 'Love this one.' } }],
  }),
];

const existingOpDetails: readonly AiActionDetail[] = [
  det({
    id: 'upload_sessions.cancel',
    title: 'Cancel a file upload',
    description:
      'Cancel an upload session that has not completed (uploadSessionId from ' +
      'upload_sessions.list); its reserved storage is released.',
    input: pathOnly('uploadSessionId'),
    redact: 'standard',
    examples: [{ summary: 'Cancel', args: { uploadSessionId: 'us_1' } }],
  }),
  det({
    id: 'upload_sessions.complete.create',
    title: 'Finish a file upload',
    description:
      'Complete an upload after every part was sent: parts lists each partNumber (1+) with the ' +
      "etag the store returned. The file then goes through TManage's checks (202); returns the " +
      'file asset.',
    input: bodyArgs(['uploadSessionId'], {
      parts: z
        .array(z.object({ partNumber: f.int(1, 1_000_000), etag: f.id(255) }).strict())
        .min(1),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'One part',
        args: { uploadSessionId: 'us_1', parts: [{ partNumber: 1, etag: 'e1' }] },
      },
    ],
  }),
  det({
    id: 'google_drive.attachments.create',
    title: 'Link a Google Drive file to a work item',
    description:
      'Attach a Google Drive file (driveFileId, a Drive id) to a work item as a live link ' +
      '(workItemId from work_items.list). To copy the file into TManage use ' +
      'work_item_files.import_drive.',
    input: bodyArgs(['workItemId'], { driveFileId: driveId() }),
    redact: 'standard',
    examples: [{ summary: 'Link', args: { workItemId: 'wi_1', driveFileId: '1AbCdEfGhIj' } }],
  }),
  det({
    id: 'google_drive.attachments.delete',
    title: 'Unlink a Google Drive file from a work item',
    description:
      'Remove a Drive link from a work item (attachmentId from google_drive.attachments.list). ' +
      'The file stays in Drive.',
    input: pathOnly('workItemId', 'attachmentId'),
    redact: 'standard',
    examples: [{ summary: 'Unlink', args: { workItemId: 'wi_1', attachmentId: 'att_1' } }],
  }),
  det({
    id: 'onedrive.attachments.create',
    title: 'Link a OneDrive file to a work item',
    description:
      'Attach a OneDrive file (driveId and itemId, Graph ids) to a work item as a live link. ' +
      'To copy the file into TManage use work_item_files.import_onedrive.',
    input: bodyArgs(['workItemId'], { driveId: graphId(), itemId: graphId() }),
    redact: 'standard',
    examples: [
      { summary: 'Link', args: { workItemId: 'wi_1', driveId: 'b!AbCdE', itemId: '01ABCDEF' } },
    ],
  }),
  det({
    id: 'onedrive.attachments.delete',
    title: 'Unlink a OneDrive file from a work item',
    description:
      'Remove a OneDrive link from a work item (attachmentId from onedrive.attachments.list). ' +
      'The file stays in OneDrive.',
    input: pathOnly('workItemId', 'attachmentId'),
    redact: 'standard',
    examples: [{ summary: 'Unlink', args: { workItemId: 'wi_1', attachmentId: 'att_1' } }],
  }),
  det({
    id: 'work_item_files.import_drive',
    title: 'Copy a Google Drive file onto a work item',
    description:
      'Copy a Google Drive file (fileId, a Drive id) into TManage through the usual file checks ' +
      'and attach the copy to the work item. A URL is never accepted.',
    input: bodyArgs(['workItemId'], { fileId: driveId() }),
    redact: 'standard',
    examples: [{ summary: 'Import', args: { workItemId: 'wi_1', fileId: '1AbCdEfGhIj' } }],
  }),
  det({
    id: 'work_item_files.import_onedrive',
    title: 'Copy a OneDrive file onto a work item',
    description:
      'Copy a OneDrive file (driveId and itemId) into TManage through the usual file checks and ' +
      'attach the copy to the work item.',
    input: bodyArgs(['workItemId'], { driveId: graphId(), itemId: graphId() }),
    redact: 'standard',
    examples: [
      { summary: 'Import', args: { workItemId: 'wi_1', driveId: 'b!AbCdE', itemId: '01ABCDEF' } },
    ],
  }),
  det({
    id: 'work_item_cloud_folders.list',
    title: "List a work item's cloud folders",
    description: 'The live Google Drive and OneDrive folders attached to a work item.',
    input: pathOnly('workItemId'),
    redact: 'standard',
    examples: [{ summary: 'Folders', args: { workItemId: 'wi_1' } }],
  }),
  det({
    id: 'work_item_cloud_folders.create',
    title: 'Attach a cloud folder to a work item',
    description:
      'Attach a live drive folder: provider google_drive with folderId, or onedrive with ' +
      'driveId and itemId (provider ids, never a URL).',
    input: bodyArgs(['workItemId'], {
      provider: storageProvider(),
      folderId: driveId().optional(),
      driveId: graphId().optional(),
      itemId: graphId().optional(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Drive folder',
        args: { workItemId: 'wi_1', provider: 'google_drive', folderId: '1FoLdEr123' },
      },
    ],
  }),
  det({
    id: 'work_item_cloud_folders.delete',
    title: 'Remove a cloud folder from a work item',
    description:
      'Detach a cloud folder (cloudFolderId from work_item_cloud_folders.list). The folder ' +
      'stays in the drive.',
    input: pathOnly('workItemId', 'cloudFolderId'),
    redact: 'standard',
    examples: [{ summary: 'Remove', args: { workItemId: 'wi_1', cloudFolderId: 'cf_1' } }],
  }),
  det({
    id: 'work_item_cloud_folders.children.list',
    title: "List a cloud folder's contents",
    description:
      "A cloud folder's files and sub-folders, live from the drive. Optional parentId opens a " +
      "sub-folder; pageToken is the previous page's token.",
    input: bodyArgs(['workItemId', 'cloudFolderId'], {
      parentId: providerId().optional(),
      pageToken: z.union([drivePageToken(), graphPageToken()]).optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'Top level', args: { workItemId: 'wi_1', cloudFolderId: 'cf_1' } }],
  }),
  det({
    id: 'work_item_cloud_folders.copy',
    title: 'Open a file from a cloud folder',
    description:
      'Make (or reuse) a checked TManage copy of a file in a cloud folder (itemId from ' +
      'work_item_cloud_folders.children.list) and return its file id for the viewer.',
    input: bodyArgs(['workItemId', 'cloudFolderId'], { itemId: providerId() }),
    redact: 'standard',
    examples: [
      { summary: 'Open', args: { workItemId: 'wi_1', cloudFolderId: 'cf_1', itemId: '1FiLe123' } },
    ],
  }),
  det({
    id: 'meeting_guests.create',
    title: 'Invite an outside guest to a meeting',
    description:
      'Invite someone who is not a TManage user by e-mail (displayName max 190, optional ' +
      'attendance) to a meeting (meetingId from meetings.list). They receive an invitation.',
    input: bodyArgs(['meetingId'], {
      email: z.string().email().max(254),
      displayName: z.string().max(190).nullish(),
      optional: f.bool().optional(),
    }),
    redact: 'people',
    notifies: true,
    examples: [{ summary: 'Invite', args: { meetingId: 'mtg_1', email: 'sam@example.com' } }],
  }),
  det({
    id: 'meeting_guests.delete',
    title: 'Remove a meeting guest',
    description: 'Remove an outside guest (guestId from meeting_guests.list) from a meeting.',
    input: pathOnly('meetingId', 'guestId'),
    redact: 'people',
    notifies: true,
    examples: [{ summary: 'Remove', args: { meetingId: 'mtg_1', guestId: 'g_1' } }],
  }),
  det({
    id: 'unfurl.get',
    title: 'Preview a link',
    description:
      'A preview card (title, description, image) for an allow-listed link (Figma, GitHub, ' +
      'Google Docs, OneDrive). Other hosts are refused; no credential is sent to the target.',
    input: bodyArgs([], { url: f.text(2048) }),
    redact: 'standard',
    examples: [{ summary: 'GitHub link', args: { url: 'https://github.com/org/repo' } }],
  }),
  det({
    id: 'inbound_email.address.get',
    title: "Show the workspace's inbound e-mail address",
    description:
      'The address clients e-mail to create requests, and its default project, or null. ' +
      'Owners/admins (org.manage) only.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Address', args: {} }],
  }),
  det({
    id: 'inbound_email.address.create',
    title: 'Create the inbound e-mail address',
    description:
      'Create the workspace address clients e-mail to open requests; defaultProjectId (from ' +
      'projects.list, or null) is where they land. Owners/admins only.',
    input: bodyArgs([], { defaultProjectId: z.string().min(1).max(64).nullish() }),
    redact: 'config',
    examples: [{ summary: 'Create', args: { defaultProjectId: 'pr_1' } }],
  }),
  det({
    id: 'inbound_email.address.rotate',
    title: 'Replace the inbound e-mail address',
    description:
      'Issue a new inbound address; the old one stops accepting mail at once. Owners/admins ' +
      'only.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Rotate', args: {} }],
  }),
  det({
    id: 'inbound_email.trust.create',
    title: 'Trust an inbound e-mail',
    description:
      'Release a held inbound e-mail (id from inbound_email.log.get): it becomes a request and ' +
      'its held attachments are released. Refused (409) when already trusted.',
    input: pathOnly('id'),
    redact: 'standard',
    examples: [{ summary: 'Trust', args: { id: 'ie_1' } }],
  }),
  det({
    id: 'inbound_email.attachment.preview.get',
    title: 'Preview an inbound e-mail attachment',
    description:
      'An inline preview of an inbound attachment (id from inbound_email.attachments.get).' +
      BINARY +
      ' inbound_email.attachments.get gives its facts as JSON.',
    input: pathOnly('id'),
    redact: 'standard',
    examples: [{ summary: 'Preview', args: { id: 'ia_1' } }],
  }),
  det({
    id: 'inbound_email.attachment.download.get',
    title: 'Download an inbound e-mail attachment',
    description:
      'The original inbound attachment (id from inbound_email.attachments.get), audited.' +
      BINARY +
      ' inbound_email.attachments.get gives its facts as JSON.',
    input: pathOnly('id'),
    redact: 'standard',
    examples: [{ summary: 'Download', args: { id: 'ia_1' } }],
  }),
  det({
    id: 'inbound_email.ask_resend.create',
    title: 'Ask the sender to re-send attachments',
    description:
      'E-mail the sender of an inbound mail (id) asking them to re-send attachments that were ' +
      'blocked, too large or unavailable. Once per mail per 24 hours; 409 when nothing can be ' +
      're-sent.',
    input: pathOnly('id'),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Ask', args: { id: 'ie_1' } }],
  }),
];

export const filesDetails: readonly AiActionDetail[] = [...newOpDetails, ...existingOpDetails];
