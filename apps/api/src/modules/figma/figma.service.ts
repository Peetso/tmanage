import { authorize } from '@tmanage/domain';
import type { AuditAction, AuditMetadataValue, Capability, Principal } from '@tmanage/domain';
import { ObjectNotFoundError } from '@tmanage/storage';
import type { ObjectStore } from '@tmanage/storage';
import type { Readable } from 'node:stream';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { FigmaFrameRow, FigmaLinkRow, ProjectRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { SeedCipher } from '../identity/seed-cipher.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { FigmaAccess, clientMayRead } from './figma-access.js';
import { ReviewThreadsRepository } from '../files/review-threads.repository.js';
import {
  FIGMA_ATTACH_TARGETS,
  FigmaRepository,
  type FigmaAttachTarget,
  type FigmaLinkAudience,
} from './figma.repository.js';
import {
  FigmaAuthError,
  FigmaNotFoundError,
  FigmaRateLimitError,
  type FigmaRestClient,
  MAX_FIGMA_FRAMES,
  figmaEmbedUrl,
  figmaOpenUrl,
  normaliseNodeId,
  parseFigmaUrl,
  type FigmaNodeSummary,
} from './figma.rest.js';

/**
 * R4 slice 13 — Figma links in the proofing viewer (SPEC R4 §2, §3.3, §3.4).
 *
 * ## The token
 *
 * Each member pastes their own Figma personal access token. It is checked with Figma (`/v1/me`)
 * before it is stored, then stored only as the SeedCipher envelope bound to the member
 * ({@link figmaTokenBinding}), so a row copied to another member fails to open. Only the last
 * four characters are ever echoed. The token is decrypted in {@link FigmaService.tokenFor} and in
 * the snapshot job, and never leaves the API.
 *
 * ## Who may do what
 *
 * Connect / disconnect: the member, for their own token (route gate `work.read`). Attach a link,
 * refresh its snapshots, remove it: `file.upload` on the link's project at the link's audience.
 * Read a link: `file.download` (staff); a client reads only `client_visible` links of a project
 * its `client_projection.read` reaches, and only in snapshot mode (no embed, no Figma address, no
 * file key). Every refusal is one 404.
 *
 * ## Network calls never run inside a transaction
 *
 * Figma is called, then the result is written in a short transaction of its own, as the Drive
 * service does.
 */

export const FIGMA_SERVICE = Symbol.for('tmanage.FigmaService');

/** A removed link's rows are purged after this (PA-03's default window). */
const PURGE_AFTER_MS = 30 * 24 * 60 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[\x21-\x7e]{20,200}$/;

export type FigmaDoor = 'internal' | 'client';

/** The additional data binding a stored token to its member. */
export function figmaTokenBinding(
  organizationId: string,
  membershipId: string,
): {
  userId: string;
} {
  return { userId: `figma:${organizationId}:${membershipId}` };
}

/** The `derived`-zone key of one frame's snapshot. Built from checked UUIDs only. */
export function figmaSnapshotObjectKey(
  organizationId: string,
  linkId: string,
  frameId: string,
): string {
  for (const value of [organizationId, linkId, frameId]) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
      throw new Error('figma snapshot key component is not a lowercase UUID');
    }
  }
  return `tenant/${organizationId}/figma/${linkId}/${frameId}`;
}

// ─── Views ───────────────────────────────────────────────────────────────

export interface FigmaConnectionView {
  readonly status: 'not_connected' | 'connected' | 'error';
  readonly handle: string | null;
  /** The token's last four characters ("…ab12"), or null. */
  readonly tokenHint: string | null;
}

export interface FigmaDetectedFrameView {
  readonly nodeId: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly pageName: string | null;
}

export interface FigmaInspectView {
  readonly fileName: string;
  /** The frame the pasted link pointed at, when it named one. */
  readonly linkedNodeId: string | null;
  readonly frames: readonly FigmaDetectedFrameView[];
  readonly maxFrames: number;
}

export type FigmaSnapshotStatusView = 'pending' | 'ready' | 'failed';

export interface FigmaFrameView {
  readonly id: string;
  readonly nodeId: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly snapshotStatus: FigmaSnapshotStatusView;
  /** API path of the PNG (`…/figma/frames/:id/snapshot`), null until one is stored. */
  readonly snapshotPath: string | null;
  readonly capturedAt: string | null;
  readonly sizeChanged: boolean;
  readonly openThreads: number;
  /** Live mode only: the frame in Figma's embed. Null for a client. */
  readonly embedUrl: string | null;
}

export interface FigmaLinkCapabilitiesView {
  readonly canComment: boolean;
  readonly canRefresh: boolean;
  readonly canRemove: boolean;
  /** Live mode is offered (staff only; Figma decides whether it opens). */
  readonly canLive: boolean;
}

export interface FigmaLinkView {
  readonly id: string;
  readonly projectId: string;
  readonly fileName: string | null;
  readonly audience: FigmaLinkAudience;
  readonly attachedToType: FigmaAttachTarget | null;
  readonly attachedToId: string | null;
  /** "Open in Figma" (staff only; null for a client). */
  readonly openUrl: string | null;
  readonly createdAt: string;
  readonly frames: readonly FigmaFrameView[];
  readonly capabilities: FigmaLinkCapabilitiesView;
}

export interface FigmaLinkSummaryView {
  readonly id: string;
  readonly fileName: string | null;
  readonly audience: FigmaLinkAudience;
  readonly frameCount: number;
  readonly createdAt: string;
}

export interface FigmaLinkListView {
  readonly links: readonly FigmaLinkSummaryView[];
}

export interface FigmaRefreshView {
  readonly queued: number;
}

export interface SnapshotContent {
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly stream: Readable;
}

export interface InspectInput {
  readonly url?: unknown;
}

export interface AttachInput {
  readonly url?: unknown;
  readonly nodeIds?: unknown;
  readonly audience?: unknown;
  readonly attachedTo?: unknown;
}

/** What the snapshot job exposes to the service: a request for a pass. */
export interface FigmaSnapshotRequester {
  request(): void;
}

export interface FigmaServiceDeps {
  readonly database: TenantDatabase;
  readonly audit: AuditService;
  readonly cipher: SeedCipher;
  readonly rest: FigmaRestClient;
  readonly store: ObjectStore;
  readonly snapshots?: FigmaSnapshotRequester | null;
  readonly embedOrigin?: string;
  readonly repository?: FigmaRepository;
  readonly projects?: Pick<ProjectsRepository, 'findById'>;
  readonly threads?: Pick<ReviewThreadsRepository, 'countOpenBySubjects'>;
  readonly now?: () => Date;
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(422, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

function badRequest(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request is invalid', [{ field, message }]);
}

function notFound(): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound);
}

function conflict(
  detail: 'not_connected' | 'no_access' | 'rate_limited' | 'unreachable',
): ApiError {
  const messages = {
    not_connected: 'Connect Figma first',
    no_access: 'Your Figma account cannot open this file',
    rate_limited: 'Figma is busy. Try again in a minute',
    unreachable: 'Figma is not reachable right now. Try again',
  } as const;
  return new ApiError(409, 'conflict', messages[detail], [{ field: 'figma', message: detail }]);
}

function audienceOf(raw: unknown): FigmaLinkAudience {
  if (raw === undefined || raw === null) return 'internal';
  if (raw === 'internal' || raw === 'client_visible') return raw;
  throw invalid('audience', 'must be internal or client_visible');
}

function attachTargetOf(raw: unknown): { type: FigmaAttachTarget; id: string } | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid('attachedTo', 'must be { type, id }');
  }
  const type = (raw as Record<string, unknown>)['type'];
  const id = (raw as Record<string, unknown>)['id'];
  if (typeof type !== 'string' || !(FIGMA_ATTACH_TARGETS as readonly string[]).includes(type)) {
    throw invalid('attachedTo.type', 'must be work_item, deliverable_version or request');
  }
  if (typeof id !== 'string' || !UUID.test(id)) throw invalid('attachedTo.id', 'must be an id');
  return { type: type as FigmaAttachTarget, id: id.toLowerCase() };
}

function nodeIdsOf(raw: unknown, fallback: string | null): readonly string[] {
  if (raw === undefined || raw === null) {
    if (fallback) return [fallback];
    throw invalid('nodeIds', 'pick at least one frame');
  }
  if (!Array.isArray(raw)) throw invalid('nodeIds', 'must be a list of frame ids');
  const ids: string[] = [];
  for (const entry of raw) {
    const id = typeof entry === 'string' ? normaliseNodeId(entry) : null;
    if (!id) throw invalid('nodeIds', 'must be a list of frame ids');
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) throw invalid('nodeIds', 'pick at least one frame');
  if (ids.length > MAX_FIGMA_FRAMES) {
    throw invalid('nodeIds', `pick ${MAX_FIGMA_FRAMES} frames or fewer`);
  }
  return ids;
}

function requireId(value: string, field: string): void {
  if (!UUID.test(value)) throw notFound();
  void field;
}

export class FigmaService {
  private readonly repository: FigmaRepository;
  private readonly projects: Pick<ProjectsRepository, 'findById'>;
  private readonly threads: Pick<ReviewThreadsRepository, 'countOpenBySubjects'>;
  private readonly now: () => Date;
  private readonly access: FigmaAccess;

  constructor(private readonly deps: FigmaServiceDeps) {
    this.repository = deps.repository ?? new FigmaRepository();
    this.projects = deps.projects ?? new ProjectsRepository();
    this.threads = deps.threads ?? new ReviewThreadsRepository();
    this.now = deps.now ?? (() => new Date());
    this.access = new FigmaAccess(deps.database, this.repository, this.projects);
  }

  // ── Connection (own token) ───────────────────────────────────────────────

  async connection(context: TenantContext, principal: Principal): Promise<FigmaConnectionView> {
    this.requireStaff(principal);
    const row = await this.deps.database.read(context, (runner) =>
      this.repository.findConnection(runner, context, context.membershipId),
    );
    if (!row) return { status: 'not_connected', handle: null, tokenHint: null };
    return {
      status: row.status === 'error' ? 'error' : 'connected',
      handle: row.figmaUserHandle,
      tokenHint: row.tokenHint,
    };
  }

  async connect(
    context: TenantContext,
    principal: Principal,
    input: { readonly token?: unknown },
  ): Promise<FigmaConnectionView> {
    this.requireStaff(principal);
    const token = typeof input.token === 'string' ? input.token.trim() : '';
    if (!TOKEN.test(token)) throw invalid('token', 'paste the whole personal access token');
    let handle: string | null;
    try {
      ({ handle } = await this.deps.rest.me(token));
    } catch (error) {
      if (error instanceof FigmaAuthError)
        throw invalid('token', 'Figma did not accept this token');
      throw this.figmaFailure(error);
    }
    const tokenCiphertext = this.deps.cipher.encrypt(
      token,
      figmaTokenBinding(context.organizationId, context.membershipId),
    );
    await this.deps.database.transaction(context, async (tx) => {
      await this.repository.saveConnection(tx, context, {
        membershipId: context.membershipId,
        tokenCiphertext,
        tokenHint: token.slice(-4),
        handle,
      });
      await this.auditAllowed(
        tx,
        context,
        principal,
        'figma.connection_changed',
        context.membershipId,
        {
          connected: true,
        },
      );
    });
    return { status: 'connected', handle, tokenHint: token.slice(-4) };
  }

  async disconnect(context: TenantContext, principal: Principal): Promise<FigmaConnectionView> {
    this.requireStaff(principal);
    await this.deps.database.transaction(context, async (tx) => {
      const removed = await this.repository.deleteConnection(tx, context, context.membershipId);
      if (removed) {
        await this.auditAllowed(
          tx,
          context,
          principal,
          'figma.connection_changed',
          context.membershipId,
          { connected: false },
        );
      }
    });
    return { status: 'not_connected', handle: null, tokenHint: null };
  }

  // ── Attach ───────────────────────────────────────────────────────────────

  /** `POST projects/:projectId/figma/inspect` — the file's name and frames, for the dialog. */
  async inspect(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    input: InspectInput,
  ): Promise<FigmaInspectView> {
    this.requireStaff(principal);
    requireId(projectId, 'projectId');
    const parsed = parseFigmaUrl(input.url);
    if (!parsed) throw invalid('url', 'paste a link to a Figma design file');
    await this.projectFor(context, principal, projectId, 'file.upload', 'internal');
    const token = await this.tokenFor(context);
    try {
      const file = await this.deps.rest.file(token, parsed.fileKey);
      let frames = file.frames;
      if (parsed.nodeId && !frames.some((frame) => frame.nodeId === parsed.nodeId)) {
        const extra = await this.deps.rest.nodes(token, parsed.fileKey, [parsed.nodeId]);
        frames = [...extra.nodes, ...frames];
      }
      return {
        fileName: file.name,
        linkedNodeId: parsed.nodeId,
        frames: frames.map(detectedView),
        maxFrames: MAX_FIGMA_FRAMES,
      };
    } catch (error) {
      throw await this.figmaCallFailure(context, error);
    }
  }

  /** `POST projects/:projectId/figma/links` — attach the picked frames; snapshots are queued. */
  async attach(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    input: AttachInput,
  ): Promise<FigmaLinkView> {
    this.requireStaff(principal);
    requireId(projectId, 'projectId');
    const parsed = parseFigmaUrl(input.url);
    if (!parsed) throw invalid('url', 'paste a link to a Figma design file');
    const audience = audienceOf(input.audience);
    const target = attachTargetOf(input.attachedTo);
    const nodeIds = nodeIdsOf(input.nodeIds, parsed.nodeId);
    await this.projectFor(context, principal, projectId, 'file.upload', audience);
    if (target) {
      const targetProject = await this.deps.database.read(context, (runner) =>
        this.repository.attachTargetProject(runner, context, target.type, target.id),
      );
      if (targetProject !== projectId) throw invalid('attachedTo', 'is not on this project');
    }
    const token = await this.tokenFor(context);
    let fileName: string;
    let nodes: readonly FigmaNodeSummary[];
    try {
      const found = await this.deps.rest.nodes(token, parsed.fileKey, nodeIds);
      fileName = found.name;
      nodes = found.nodes;
    } catch (error) {
      throw await this.figmaCallFailure(context, error);
    }
    if (nodes.length === 0) throw invalid('nodeIds', 'none of these frames is in the file');

    const linkId = await this.deps.database.transaction(context, async (tx) => {
      const id = await this.repository.insertLink(tx, context, {
        projectId,
        fileKey: parsed.fileKey,
        fileName: fileName === '' ? null : fileName,
        url: parsed.url,
        attachedToType: target?.type ?? null,
        attachedToId: target?.id ?? null,
        audience,
        createdByMembershipId: context.membershipId,
        frames: nodes.map((node) => ({
          nodeId: node.nodeId,
          name: node.name,
          width: node.width,
          height: node.height,
        })),
      });
      await this.auditAllowed(tx, context, principal, 'figma.link_attached', id, {
        project_id: projectId,
        audience,
        frame_count: nodes.length,
        attached_to_type: target?.type ?? null,
      });
      return id;
    });
    this.deps.snapshots?.request();
    return this.link(context, principal, 'internal', linkId);
  }

  /** `GET projects/:projectId/figma/links?attachedToType=&attachedToId=` */
  async list(
    context: TenantContext,
    principal: Principal,
    door: FigmaDoor,
    projectId: string,
    query: { readonly attachedToType?: string; readonly attachedToId?: string },
  ): Promise<FigmaLinkListView> {
    this.requireDoor(principal, door);
    requireId(projectId, 'projectId');
    let target: { type: FigmaAttachTarget; id: string } | null = null;
    if (query.attachedToType !== undefined || query.attachedToId !== undefined) {
      try {
        target = attachTargetOf({ type: query.attachedToType, id: query.attachedToId });
      } catch {
        throw badRequest('attachedTo', 'must name a work item, deliverable version or request');
      }
    }
    const client = principal.kind === 'client';
    if (client) {
      if (!clientMayRead(principal, projectId)) throw notFound();
    } else {
      await this.projectFor(context, principal, projectId, 'file.download', 'internal');
    }
    const rows = await this.deps.database.read(context, async (runner) => {
      const links = await this.repository.listLinksAttachedTo(runner, context, projectId, target);
      const out: FigmaLinkSummaryView[] = [];
      for (const link of links) {
        if (client && link.audience !== 'client_visible') continue;
        const frames = await this.repository.listFrames(runner, context, link.id);
        out.push({
          id: link.id,
          fileName: link.fileName,
          audience: link.audience as FigmaLinkAudience,
          frameCount: frames.length,
          createdAt: link.createdAt.toISOString(),
        });
      }
      return out;
    });
    return { links: rows };
  }

  /** `GET figma/links/:linkId` (and the portal twin): the manifest the viewer draws. */
  async link(
    context: TenantContext,
    principal: Principal,
    door: FigmaDoor,
    linkId: string,
  ): Promise<FigmaLinkView> {
    this.requireDoor(principal, door);
    requireId(linkId, 'linkId');
    const { link, project } = await this.access.readableLink(context, principal, linkId);
    const client = principal.kind === 'client';
    const canWrite = !client && this.mayWrite(principal, link, project);
    const canComment = this.mayComment(principal, link, project);
    const frames = await this.deps.database.read(context, async (runner) => {
      const rows = await this.repository.listFrames(runner, context, link.id);
      const open = await this.threads.countOpenBySubjects(
        runner,
        context,
        'figma_frame',
        rows.map((row) => row.id),
        client ? ['client_visible'] : ['internal', 'client_visible'],
      );
      return rows.map((row) => this.frameView(row, open.get(row.id) ?? 0, link, client));
    });
    return {
      id: link.id,
      projectId: link.projectId,
      fileName: link.fileName,
      audience: link.audience as FigmaLinkAudience,
      attachedToType: client ? null : (link.attachedToType as FigmaAttachTarget | null),
      attachedToId: client ? null : link.attachedToId,
      openUrl: client ? null : figmaOpenUrl(link.fileKey, frames[0]?.nodeId ?? null),
      createdAt: link.createdAt.toISOString(),
      frames,
      capabilities: {
        canComment,
        canRefresh: canWrite,
        canRemove: canWrite,
        canLive: !client,
      },
    };
  }

  /** `POST figma/links/:linkId/snapshots` — "Refresh snapshots" (staff). */
  async refresh(
    context: TenantContext,
    principal: Principal,
    linkId: string,
  ): Promise<FigmaRefreshView> {
    this.requireStaff(principal);
    requireId(linkId, 'linkId');
    const { link, project } = await this.access.readableLink(context, principal, linkId);
    if (!this.mayWrite(principal, link, project)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'figma_write_denied');
    }
    const queued = await this.deps.database.transaction(context, (tx) =>
      this.repository.requeueFrames(tx, context, link.id),
    );
    this.deps.snapshots?.request();
    return { queued };
  }

  /** `DELETE figma/links/:linkId` — soft delete (PA-03); absent is a no-op. */
  async remove(context: TenantContext, principal: Principal, linkId: string): Promise<void> {
    this.requireStaff(principal);
    requireId(linkId, 'linkId');
    const found = await this.deps.database.read(context, (runner) =>
      this.repository.findLink(runner, context, linkId),
    );
    if (!found) return;
    const { link, project } = await this.access.readableLink(context, principal, linkId);
    if (!this.mayWrite(principal, link, project)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'figma_write_denied');
    }
    await this.deps.database.transaction(context, async (tx) => {
      const removed = await this.repository.softDeleteLink(
        tx,
        context,
        link.id,
        new Date(this.now().getTime() + PURGE_AFTER_MS),
      );
      if (removed) {
        await this.auditAllowed(tx, context, principal, 'figma.link_removed', link.id, {
          project_id: link.projectId,
        });
      }
    });
  }

  /** `GET figma/frames/:frameId/snapshot` (and the portal twin): the stored PNG. */
  async snapshot(
    context: TenantContext,
    principal: Principal,
    door: FigmaDoor,
    frameId: string,
  ): Promise<SnapshotContent> {
    this.requireDoor(principal, door);
    requireId(frameId, 'frameId');
    const frame = await this.deps.database.read(context, (runner) =>
      this.repository.findFrame(runner, context, frameId),
    );
    if (!frame || frame.snapshotStatus !== 'ready' || !frame.snapshotObjectKey) throw notFound();
    await this.access.readableLink(context, principal, frame.linkId);
    try {
      const opened = await this.deps.store.openDerivative({ objectKey: frame.snapshotObjectKey });
      return {
        mimeType: 'image/png',
        sizeBytes: opened.sizeBytes,
        stream: opened.stream as Readable,
      };
    } catch (error) {
      if (error instanceof ObjectNotFoundError) throw notFound();
      throw error;
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** The member's own decrypted token, or 409 "Connect Figma first". */
  private async tokenFor(context: TenantContext): Promise<string> {
    const row = await this.deps.database.read(context, (runner) =>
      this.repository.findConnection(runner, context, context.membershipId),
    );
    if (!row) throw conflict('not_connected');
    try {
      return this.deps.cipher.decrypt(
        row.tokenCiphertext,
        figmaTokenBinding(context.organizationId, context.membershipId),
      );
    } catch {
      throw conflict('not_connected');
    }
  }

  private async projectFor(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    capability: Capability,
    audience: FigmaLinkAudience,
  ): Promise<ProjectRow> {
    const project = await this.deps.database.read(context, (runner) =>
      this.projects.findById(runner, context, projectId),
    );
    if (!project) throw notFound();
    const allowed = authorize({
      principal,
      capability,
      resource: {
        organizationId: project.organizationId,
        projectId: project.id,
        audience,
        clientOrganizationId: null,
        lifecycle: project.archivedAt === null ? 'active' : 'archived',
      },
    }).allowed;
    if (!allowed) throw notFound();
    if (capability === 'file.upload' && project.archivedAt !== null) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'project_archived');
    }
    return project;
  }

  private mayWrite(principal: Principal, link: FigmaLinkRow, project: ProjectRow): boolean {
    if (project.archivedAt !== null || principal.kind === 'client') return false;
    return authorize({
      principal,
      capability: 'file.upload',
      resource: {
        organizationId: project.organizationId,
        projectId: project.id,
        audience: link.audience as FigmaLinkAudience,
        clientOrganizationId: null,
        lifecycle: 'active',
      },
    }).allowed;
  }

  private mayComment(principal: Principal, link: FigmaLinkRow, project: ProjectRow): boolean {
    if (project.archivedAt !== null) return false;
    const client = principal.kind === 'client';
    return authorize({
      principal,
      capability: 'file.upload',
      resource: {
        organizationId: project.organizationId,
        projectId: project.id,
        audience: client ? 'client_visible' : (link.audience as FigmaLinkAudience),
        clientOrganizationId: client ? principal.clientOrganizationId : null,
        lifecycle: 'active',
      },
    }).allowed;
  }

  private frameView(
    row: FigmaFrameRow,
    openThreads: number,
    link: FigmaLinkRow,
    client: boolean,
  ): FigmaFrameView {
    const ready = row.snapshotStatus === 'ready' && row.snapshotObjectKey !== null;
    return {
      id: row.id,
      nodeId: row.nodeId,
      name: row.name,
      width: row.width,
      height: row.height,
      snapshotStatus: row.snapshotStatus as FigmaSnapshotStatusView,
      snapshotPath: ready
        ? `${client ? '/portal' : ''}/figma/frames/${row.id}/snapshot?v=${(row.snapshotHash ?? '').slice(0, 12)}`
        : null,
      capturedAt: row.capturedAt ? row.capturedAt.toISOString() : null,
      sizeChanged: row.sizeChanged,
      openThreads,
      embedUrl: client ? null : figmaEmbedUrl(link.fileKey, row.nodeId, this.deps.embedOrigin),
    };
  }

  private requireStaff(principal: Principal): void {
    if (principal.kind !== 'internal') throw notFound();
  }

  private requireDoor(principal: Principal, door: FigmaDoor): void {
    if (door === 'client' ? principal.kind !== 'client' : principal.kind !== 'internal') {
      throw notFound();
    }
  }

  private async auditAllowed(
    tx: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    action: AuditAction,
    objectId: string,
    metadata: Readonly<Record<string, AuditMetadataValue>>,
  ): Promise<void> {
    await this.deps.audit.record(tx, context, {
      action,
      objectId,
      result: 'allowed',
      actorUserId: principal.userId,
      metadata,
    });
  }

  /** A Figma refusal of the caller's token marks the connection `error`. */
  private async figmaCallFailure(context: TenantContext, error: unknown): Promise<ApiError> {
    if (error instanceof FigmaAuthError) {
      if (error.status === 401) {
        await this.deps.database.transaction(context, (tx) =>
          this.repository.markConnectionError(tx, context, context.membershipId),
        );
        return conflict('not_connected');
      }
      return conflict('no_access');
    }
    return this.figmaFailure(error);
  }

  private figmaFailure(error: unknown): ApiError {
    if (error instanceof FigmaNotFoundError) return conflict('no_access');
    if (error instanceof FigmaRateLimitError) return conflict('rate_limited');
    return conflict('unreachable');
  }
}

function detectedView(frame: FigmaNodeSummary): FigmaDetectedFrameView {
  return {
    nodeId: frame.nodeId,
    name: frame.name,
    width: frame.width,
    height: frame.height,
    pageName: frame.pageName,
  };
}
