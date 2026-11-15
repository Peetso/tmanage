import { authorize } from '@tmanage/domain';
import type { AuditAction, AuditMetadataValue, Capability, Principal } from '@tmanage/domain';
import { ObjectNotFoundError } from '@tmanage/storage';
import type { ObjectStore } from '@tmanage/storage';
import type { Readable } from 'node:stream';
import { createFixedWindowLimiter, type RequestAdmission } from '../../common/http/rate-limiter.js';
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
import { oauthFlowIsOwnersAndMatches } from '../../common/http/oauth-flow.js';
import {
  FIGMA_CALLBACK_PATH,
  FIGMA_OAUTH_TOKEN_PREFIX,
  FigmaOAuthRefusedError,
  exchangeFigmaCode,
  figmaAuthorizeUrl,
  newFigmaFlow,
  type FigmaFlow,
  type FigmaOAuthConfig,
  type FigmaReturnTo,
} from './figma-oauth.js';
import { ReviewThreadsRepository } from '../files/review-threads.repository.js';
import {
  FIGMA_ATTACH_TARGETS,
  FigmaRepository,
  type FigmaAttachTarget,
  type FigmaLinkAudience,
  type FigmaSnapshotError,
} from './figma.repository.js';
import {
  diffFrames,
  fromNode,
  fromOutline,
  fromRow,
  parsePageFilter,
  parseStoredOutline,
  placeFrames,
  storedOutlineJson,
  type PlannedFrame,
} from './figma-outline.js';
import {
  FigmaAuthError,
  FigmaNotFoundError,
  FigmaRateLimitError,
  type FigmaOutline,
  type FigmaRestClient,
  MAX_CAPTURED_FRAMES,
  MAX_RENDER_BYTES,
  figmaEmbedUrl,
  figmaOpenUrl,
  figmaWaitMs,
  normaliseNodeId,
  parseFigmaUrl,
  renderScale,
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
 * refresh it from Figma, choose its pages, remove it: `file.upload` on the link's project at the
 * link's audience.
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

/** The small picture of a snapshot, beside it in the `derived` zone. */
export function figmaThumbObjectKey(snapshotObjectKey: string): string {
  return `${snapshotObjectKey}.thumb`;
}

/**
 * A sharper render of a frame: beside its snapshot, named by scale and by the snapshot's hash, so
 * a refreshed frame gets a new render and the old one is never served for it.
 */
export function figmaRenderObjectKey(
  snapshotObjectKey: string,
  scale: number,
  snapshotHash: string | null,
): string {
  const hash = (snapshotHash ?? '').slice(0, 12);
  if (!/^[0-9a-f]{12}$/.test(hash)) throw new Error('figma render key needs the snapshot hash');
  return `${snapshotObjectKey}.r${Math.round(scale * 100)}-${hash}`;
}

/**
 * A member's decrypted Figma token, or null (none stored, or it no longer opens). Decrypted only
 * here and in the snapshot job's use of this; it never leaves the API. `connectedOnly`: a token
 * Figma refused once (`error`) is not used for background work.
 */
export async function readMemberToken(
  database: TenantDatabase,
  repository: FigmaRepository,
  cipher: SeedCipher,
  context: TenantContext,
  membershipId: string,
  connectedOnly = true,
): Promise<string | null> {
  const row = await database.read(context, (runner) =>
    repository.findConnection(runner, context, membershipId),
  );
  if (!row || (connectedOnly && row.status !== 'connected')) return null;
  try {
    return cipher.decrypt(
      row.tokenCiphertext,
      figmaTokenBinding(context.organizationId, membershipId),
    );
  } catch {
    return null;
  }
}

/** Sharper renders on demand, per ten minutes: per person, and per workspace. */
export const RENDER_WINDOW_MS = 10 * 60_000;
/**
 * Security review M2 (2026-11-14): one "Refresh from Figma" per link per this long. A refresh
 * spends the link creator's Figma quota (the outline, then every captured frame again), so it is
 * held server-side from the link's own last read, which every process sees.
 */
export const REFRESH_COOLDOWN_MS = 3 * 60_000;
export const RENDERS_PER_PERSON = 40;
export const RENDERS_PER_WORKSPACE = 150;

// ─── Views ───────────────────────────────────────────────────────────────

export interface FigmaConnectionView {
  readonly status: 'not_connected' | 'connected' | 'error';
  readonly handle: string | null;
  /** The token's last four characters ("…ab12"), or null. */
  readonly tokenHint: string | null;
  /** FIX4 item 6: one-click Connect (Figma's own sign-in) is set up on this server. */
  readonly oneClick: boolean;
}

export interface FigmaDetectedFrameView {
  readonly nodeId: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly pageName: string | null;
  readonly sectionName: string | null;
}

export interface FigmaInspectPageView {
  readonly id: string;
  readonly name: string;
  readonly frameCount: number;
}

export interface FigmaInspectView {
  readonly fileName: string;
  /** The frame (or page) the pasted link pointed at, when it named one. */
  readonly linkedNodeId: string | null;
  readonly pages: readonly FigmaInspectPageView[];
  /** Every frame of the file, in Figma's order (for "Only some frames"). */
  readonly frames: readonly FigmaDetectedFrameView[];
  /** The file had more frames than TManage reads ({@link MAX_OUTLINE_FRAMES}). */
  readonly truncated: boolean;
  /** How many frames one link captures. */
  readonly maxFrames: number;
}

/** `skipped`: listed, but beyond what the link captures. */
export type FigmaSnapshotStatusView = 'pending' | 'ready' | 'failed' | 'skipped';

export interface FigmaFrameView {
  readonly id: string;
  readonly nodeId: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** The Figma page and section(s) it sits in (null: a nested frame, or an older link). */
  readonly pageId: string | null;
  readonly pageName: string | null;
  readonly sectionName: string | null;
  /** Where it sits on its page (the whole-page view); null when unknown. */
  readonly x: number | null;
  readonly y: number | null;
  readonly snapshotStatus: FigmaSnapshotStatusView;
  /** API path of the PNG (`…/figma/frames/:id/snapshot`), null until one is stored. */
  readonly snapshotPath: string | null;
  /** API path of a small picture of the snapshot (the whole-page view), or null. */
  readonly thumbPath: string | null;
  /** API path of a sharper render for zooming in, or null when the snapshot is the sharpest. */
  readonly sharpPath: string | null;
  /** The scale of {@link sharpPath} (1 = Figma's own size), or null. */
  readonly sharpScale: number | null;
  readonly capturedAt: string | null;
  readonly sizeChanged: boolean;
  /** The frame was not in Figma at the last refresh; it stays with its comments. */
  readonly gone: boolean;
  /** Team only: why the last capture failed, for the team's screen (null for a client). */
  readonly snapshotError: FigmaSnapshotError | null;
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

export interface FigmaLinkPageView {
  readonly id: string;
  readonly name: string;
  /** Frames listed on the page (gone ones left out). */
  readonly frameCount: number;
  /** Frames on the page whose snapshot is stored. */
  readonly readyCount: number;
  /** Whether the page is captured (the team's choice when the file is over the limit). */
  readonly selected: boolean;
}

/** The truth about the capture: how much of the file there is, and how much is shown. */
export interface FigmaCaptureView {
  readonly mode: 'whole_file' | 'picked';
  readonly pageCount: number;
  readonly frameCount: number;
  readonly ready: number;
  readonly pending: number;
  readonly failed: number;
  /** Listed but not captured: beyond the limit, or on a page the team left out. */
  readonly skipped: number;
  readonly gone: number;
  readonly maxFrames: number;
  /** More frames than one link captures: the team chooses pages. */
  readonly overLimit: boolean;
  /** The file had more frames than TManage reads at all. */
  readonly truncated: boolean;
  readonly syncedAt: string | null;
  /**
   * Figma refused the link creator's token (429): pictures resume after this time (ISO), or null.
   * The team's screen says so; a client only sees "being prepared".
   */
  readonly waitUntil: string | null;
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
  /** The frame the viewer opens on (the one the pasted link pointed at), or null. */
  readonly focusFrameId: string | null;
  readonly pages: readonly FigmaLinkPageView[];
  readonly capture: FigmaCaptureView;
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
  /** "Only some frames": the picked frames. Absent = the whole file. */
  readonly nodeIds?: unknown;
  readonly audience?: unknown;
  readonly attachedTo?: unknown;
}

export interface PagesInput {
  /** The page ids to capture, or null for every page. */
  readonly pageIds?: unknown;
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
  /** FIX4 item 6: the server's Figma app for one-click Connect, or null (token path only). */
  readonly oauth?: FigmaOAuthConfig | null;
  /** Where Figma redirects back (`{apiPublicUrl}/v1/integrations/figma/callback`). */
  readonly apiPublicUrl?: string;
  /** Test seam for the code exchange. */
  readonly exchange?: typeof exchangeFigmaCode;
  /**
   * Sharper renders made on demand (zoom): per workspace and per person, so a client cannot spend
   * the workspace's Figma quota. A render already stored is free.
   */
  readonly renderAdmission?: {
    readonly workspace: RequestAdmission;
    readonly person: RequestAdmission;
  };
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

function rateLimited(): ApiError {
  return new ApiError(429, 'rate_limited', MESSAGES.rateLimited, undefined, 'figma_render_capped');
}

function conflict(
  detail: 'not_connected' | 'no_access' | 'rate_limited' | 'recently_refreshed' | 'unreachable',
  /** When asking again makes sense (Figma's Retry-After, or the refresh cooldown left). */
  retryAfterSeconds?: number,
): ApiError {
  const messages = {
    not_connected: 'Connect Figma first',
    no_access: 'Your Figma account cannot open this file',
    rate_limited: 'Figma asked TManage to wait before reading this file again',
    recently_refreshed: 'This file was refreshed a moment ago',
    unreachable: 'Figma is not reachable right now. Try again',
  } as const;
  const details: { field: string; message: string }[] = [{ field: 'figma', message: detail }];
  if (retryAfterSeconds !== undefined) {
    details.push({
      field: 'retry_after',
      message: String(Math.max(1, Math.ceil(retryAfterSeconds))),
    });
  }
  return new ApiError(409, 'conflict', messages[detail], details);
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
    throw invalid('attachedTo.type', `must be one of ${FIGMA_ATTACH_TARGETS.join(', ')}`);
  }
  if (typeof id !== 'string' || !UUID.test(id)) throw invalid('attachedTo.id', 'must be an id');
  return { type: type as FigmaAttachTarget, id: id.toLowerCase() };
}

/** "Only some frames": the picked node ids, or null for the whole file. */
function nodeIdsOf(raw: unknown): readonly string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw invalid('nodeIds', 'must be a list of frame ids');
  const ids: string[] = [];
  for (const entry of raw) {
    const id = typeof entry === 'string' ? normaliseNodeId(entry) : null;
    if (!id) throw invalid('nodeIds', 'must be a list of frame ids');
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) throw invalid('nodeIds', 'pick at least one frame');
  if (ids.length > MAX_CAPTURED_FRAMES) {
    throw invalid('nodeIds', `pick ${MAX_CAPTURED_FRAMES} frames or fewer`);
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
  /** Renders being fetched now, so two viewers of one frame cost one Figma call. */
  private readonly renders = new Map<string, Promise<void>>();
  private readonly defaultAdmission = {
    workspace: createFixedWindowLimiter({ windowMs: RENDER_WINDOW_MS, max: RENDERS_PER_WORKSPACE }),
    person: createFixedWindowLimiter({ windowMs: RENDER_WINDOW_MS, max: RENDERS_PER_PERSON }),
  };

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
    if (!row) return { status: 'not_connected', handle: null, tokenHint: null, ...this.oneClick() };
    return {
      status: row.status === 'error' ? 'error' : 'connected',
      handle: row.figmaUserHandle,
      tokenHint: row.tokenHint,
      ...this.oneClick(),
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
    return { status: 'connected', handle, tokenHint: token.slice(-4), ...this.oneClick() };
  }

  private oneClick(): { readonly oneClick: boolean } {
    return { oneClick: Boolean(this.deps.oauth && this.deps.apiPublicUrl) };
  }

  private redirectUri(): string {
    return `${(this.deps.apiPublicUrl ?? '').replace(/\/+$/, '')}${FIGMA_CALLBACK_PATH}`;
  }

  /**
   * FIX4 item 6. Start one-click Connect: Figma's consent address and the flow the controller
   * seals into the cookie. 409 `not_configured` when the server has no Figma app.
   */
  startConnect(
    context: TenantContext,
    principal: Principal,
    organizationSlug: string,
    returnTo: FigmaReturnTo = 'integrations',
  ): { readonly url: string; readonly flow: FigmaFlow } {
    this.requireStaff(principal);
    const config = this.deps.oauth;
    if (!config || !this.deps.apiPublicUrl) {
      throw new ApiError(
        409,
        'conflict',
        'Figma sign-in is not set up',
        undefined,
        'not_configured',
      );
    }
    const flow = newFigmaFlow({
      organizationId: context.organizationId,
      organizationSlug,
      membershipId: context.membershipId,
      returnTo,
    });
    return {
      url: figmaAuthorizeUrl({
        config,
        redirectUri: this.redirectUri(),
        state: flow.state,
        verifier: flow.verifier,
      }),
      flow,
    };
  }

  /**
   * FIX4 item 6. Finish one-click Connect under the member's own session: the cookie's flow must
   * be this person's in this workspace and its state must match; then the code is exchanged, Figma
   * names the account, and the token is stored encrypted like a pasted one.
   */
  async completeConnect(
    context: TenantContext,
    principal: Principal,
    flow: FigmaFlow | undefined,
    input: { readonly code?: unknown; readonly state?: unknown },
  ): Promise<FigmaConnectionView> {
    this.requireStaff(principal);
    const config = this.deps.oauth;
    if (!config || !this.deps.apiPublicUrl) {
      throw new ApiError(
        409,
        'conflict',
        'Figma sign-in is not set up',
        undefined,
        'not_configured',
      );
    }
    if (!oauthFlowIsOwnersAndMatches(flow, context, input)) {
      throw invalid('state', 'the Figma sign-in expired; press Connect again');
    }
    const code = input.code as string;
    let accessToken: string;
    try {
      ({ accessToken } = await (this.deps.exchange ?? exchangeFigmaCode)({
        config,
        redirectUri: this.redirectUri(),
        code,
        // L5: PKCE; a flow from before the change has no verifier and sends none.
        verifier: flow.verifier,
      }));
    } catch (error) {
      if (error instanceof FigmaOAuthRefusedError) {
        throw invalid('code', 'Figma did not accept the sign-in; press Connect again');
      }
      throw conflict('unreachable');
    }
    const stored = `${FIGMA_OAUTH_TOKEN_PREFIX}${accessToken}`;
    let handle: string | null;
    try {
      ({ handle } = await this.deps.rest.me(stored));
    } catch (error) {
      if (error instanceof FigmaAuthError) {
        throw invalid('code', 'Figma did not accept the sign-in; press Connect again');
      }
      throw this.figmaFailure(error);
    }
    // Figma offers apps no endpoint to revoke an OAuth token (nor a pasted personal token), so a
    // replaced token is only forgotten here; the person can remove TManage in Figma's settings.
    const tokenCiphertext = this.deps.cipher.encrypt(
      stored,
      figmaTokenBinding(context.organizationId, context.membershipId),
    );
    const tokenHint = accessToken.slice(-4);
    await this.deps.database.transaction(context, async (tx) => {
      await this.repository.saveConnection(tx, context, {
        membershipId: context.membershipId,
        tokenCiphertext,
        tokenHint,
        handle,
      });
      await this.auditAllowed(
        tx,
        context,
        principal,
        'figma.connection_changed',
        context.membershipId,
        { connected: true },
      );
    });
    return { status: 'connected', handle, tokenHint, ...this.oneClick() };
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
    return { status: 'not_connected', handle: null, tokenHint: null, ...this.oneClick() };
  }

  // ── Attach ───────────────────────────────────────────────────────────────

  /**
   * `POST projects/:projectId/figma/inspect` — the whole file's pages and frames (sections walked),
   * for the dialog's counts and its optional "Only some frames" list.
   */
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
      const outline = await this.deps.rest.outline(token, parsed.fileKey);
      const extra = await this.nestedFrames(token, parsed.fileKey, outline, [parsed.nodeId]);
      const frames = [...extra, ...outline.frames.map(fromOutline)];
      return {
        fileName: outline.name,
        linkedNodeId: parsed.nodeId,
        pages: outline.pages.map((page) => ({
          id: page.id,
          name: page.name,
          frameCount: outline.frames.filter((frame) => frame.pageId === page.id).length,
        })),
        frames: frames.map(detectedView),
        truncated: outline.truncated,
        maxFrames: MAX_CAPTURED_FRAMES,
      };
    } catch (error) {
      throw await this.figmaCallFailure(context, error);
    }
  }

  /**
   * `POST projects/:projectId/figma/links` — attach the whole file (every page, every frame,
   * sections walked), or only the picked frames. Nothing is drawn here: the frames are listed,
   * the first {@link MAX_CAPTURED_FRAMES} in order of relevance are queued, and the snapshot job
   * captures them in the background.
   */
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
    const picked = nodeIdsOf(input.nodeIds);
    await this.projectFor(context, principal, projectId, 'file.upload', audience);
    if (target) {
      const targetProject = await this.deps.database.read(context, (runner) =>
        this.repository.attachTargetProject(runner, context, target.type, target.id),
      );
      if (targetProject !== projectId) throw invalid('attachedTo', 'is not on this project');
    }
    const token = await this.tokenFor(context);
    let outline: FigmaOutline;
    let frames: readonly PlannedFrame[];
    try {
      outline = await this.deps.rest.outline(token, parsed.fileKey);
      frames = await this.framesFor(token, parsed.fileKey, outline, picked, [parsed.nodeId]);
    } catch (error) {
      throw await this.figmaCallFailure(context, error);
    }
    if (frames.length === 0) {
      throw invalid(
        picked ? 'nodeIds' : 'url',
        picked ? 'none of these frames is in the file' : 'this file has no frames',
      );
    }
    const placements = placeFrames(
      frames,
      parsed.nodeId,
      null,
      picked ? Number.MAX_SAFE_INTEGER : MAX_CAPTURED_FRAMES,
    );

    const linkId = await this.deps.database.transaction(context, async (tx) => {
      const id = await this.repository.insertLink(tx, context, {
        projectId,
        fileKey: parsed.fileKey,
        fileName: outline.name === '' ? null : outline.name,
        url: parsed.url,
        attachedToType: target?.type ?? null,
        attachedToId: target?.id ?? null,
        audience,
        createdByMembershipId: context.membershipId,
        captureMode: picked ? 'picked' : 'whole_file',
        focusNodeId: parsed.nodeId,
        outlineJson: storedOutlineJson(outline),
        frames: frames.map((frame) => ({ frame, placement: placements.get(frame.nodeId)! })),
      });
      await this.auditAllowed(tx, context, principal, 'figma.link_attached', id, {
        project_id: projectId,
        audience,
        frame_count: frames.length,
        captured_count: [...placements.values()].filter((place) => place.captured).length,
        capture_mode: picked ? 'picked' : 'whole_file',
        attached_to_type: target?.type ?? null,
      });
      return id;
    });
    this.deps.snapshots?.request();
    return this.link(context, principal, 'internal', linkId);
  }

  /**
   * The frames a link lists: the whole outline (plus a nested frame the link pointed at), or the
   * picked ones (outline order; a picked frame inside another frame is read directly).
   */
  private async framesFor(
    token: string,
    fileKey: string,
    outline: FigmaOutline,
    picked: readonly string[] | null,
    focus: readonly (string | null)[],
  ): Promise<readonly PlannedFrame[]> {
    if (!picked) {
      const extra = await this.nestedFrames(token, fileKey, outline, focus);
      return [...extra, ...outline.frames.map(fromOutline)];
    }
    const wanted = new Set(picked);
    const listed = outline.frames.filter((frame) => wanted.has(frame.nodeId)).map(fromOutline);
    const extra = await this.nestedFrames(token, fileKey, outline, picked);
    return [...extra, ...listed];
  }

  /** Named nodes the outline does not list (and that are not pages), read from Figma directly. */
  private async nestedFrames(
    token: string,
    fileKey: string,
    outline: FigmaOutline,
    nodeIds: readonly (string | null)[],
  ): Promise<readonly PlannedFrame[]> {
    const known = new Set([
      ...outline.frames.map((frame) => frame.nodeId),
      ...outline.pages.map((page) => page.id),
    ]);
    const missing = [
      ...new Set(nodeIds.filter((id): id is string => id !== null && !known.has(id))),
    ];
    if (missing.length === 0) return [];
    const found = await this.deps.rest.nodes(token, fileKey, missing);
    return found.nodes.map(fromNode);
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
        throw badRequest('attachedTo', `must name one of ${FIGMA_ATTACH_TARGETS.join(', ')}`);
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
          frameCount: frames.filter((frame) => frame.goneAt === null).length,
          createdAt: link.createdAt.toISOString(),
        });
      }
      return out;
    });
    return { links: rows };
  }

  /**
   * `GET portal/figma/links` — every Figma link shared with this client, across the projects its
   * portal reaches (the portal's Files page lists them; a client does not know project ids).
   */
  async clientLinks(context: TenantContext, principal: Principal): Promise<FigmaLinkListView> {
    this.requireDoor(principal, 'client');
    const links: FigmaLinkSummaryView[] = [];
    for (const projectId of principal.projectIds) {
      if (!clientMayRead(principal, projectId)) continue;
      links.push(...(await this.list(context, principal, 'client', projectId, {})).links);
    }
    links.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { links };
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
    const { rows, frames } = await this.deps.database.read(context, async (runner) => {
      const listed = await this.repository.listFrames(runner, context, link.id);
      const open = await this.threads.countOpenBySubjects(
        runner,
        context,
        'figma_frame',
        listed.map((row) => row.id),
        client ? ['client_visible'] : ['internal', 'client_visible'],
      );
      return {
        rows: listed,
        frames: listed.map((row) => this.frameView(row, open.get(row.id) ?? 0, link, client)),
      };
    });
    const outline = parseStoredOutline(link.outlineJson);
    const filter = parsePageFilter(link.pageFilterJson);
    const live = rows.filter((row) => row.goneAt === null);
    const count = (status: string) => live.filter((row) => row.snapshotStatus === status).length;
    const waitUntil =
      link.figmaWaitUntil && link.figmaWaitUntil.getTime() > this.now().getTime()
        ? link.figmaWaitUntil
        : null;
    // Someone is looking at pictures still to come: wake the job (debounced, in this process).
    // On shared hosting the process can sleep between requests, so its own timer is not enough.
    if (count('pending') > 0 && !waitUntil) this.deps.snapshots?.request();
    const focus =
      rows.find((row) => row.nodeId === link.focusNodeId) ??
      rows.find((row) => row.pageId !== null && row.pageId === link.focusNodeId) ??
      null;
    return {
      id: link.id,
      projectId: link.projectId,
      fileName: link.fileName,
      audience: link.audience as FigmaLinkAudience,
      attachedToType: client ? null : (link.attachedToType as FigmaAttachTarget | null),
      attachedToId: client ? null : link.attachedToId,
      openUrl: client
        ? null
        : figmaOpenUrl(link.fileKey, link.focusNodeId ?? rows[0]?.nodeId ?? null),
      createdAt: link.createdAt.toISOString(),
      focusFrameId: focus?.id ?? null,
      pages: outline.pages.map((page) => {
        const onPage = live.filter((row) => row.pageId === page.id);
        return {
          id: page.id,
          name: page.name,
          frameCount: onPage.length,
          readyCount: onPage.filter((row) => row.snapshotStatus === 'ready').length,
          selected: filter === null || filter.has(page.id),
        };
      }),
      capture: {
        mode: link.captureMode === 'whole_file' ? 'whole_file' : 'picked',
        pageCount: outline.pages.length,
        frameCount: live.length,
        ready: count('ready'),
        pending: count('pending'),
        failed: count('failed'),
        skipped: count('skipped'),
        gone: rows.length - live.length,
        maxFrames: MAX_CAPTURED_FRAMES,
        overLimit: link.captureMode === 'whole_file' && live.length > MAX_CAPTURED_FRAMES,
        truncated: outline.truncated,
        syncedAt: link.syncedAt ? link.syncedAt.toISOString() : null,
        waitUntil: waitUntil && !client ? waitUntil.toISOString() : null,
      },
      frames,
      capabilities: {
        canComment,
        canRefresh: canWrite,
        canRemove: canWrite,
        canLive: !client,
      },
    };
  }

  /**
   * `POST figma/links/:linkId/snapshots` — "Refresh from Figma" (team only). The file is read
   * again: new frames are listed (and captured within the limit), renamed, moved and resized
   * frames are updated in place — same frame, so its comments stay — and frames Figma no longer
   * has are kept and marked "Removed in Figma". Every captured frame is drawn again.
   */
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
    const now = this.now();
    // Figma refused this link's token a short while ago (429): say until when, ask nothing.
    const waitLeft = (link.figmaWaitUntil?.getTime() ?? 0) - now.getTime();
    if (waitLeft > 0) throw conflict('rate_limited', waitLeft / 1000);
    // Claimed atomically and stamped before Figma is called: of refreshes sent at once one goes
    // on, and a refresh that then fails still waits out the cooldown. Attaching does not start
    // it, so the first refresh always goes on.
    const claimed = await this.deps.database.transaction(context, (tx) =>
      this.repository.claimRefresh(
        tx,
        context,
        link.id,
        now,
        new Date(now.getTime() - REFRESH_COOLDOWN_MS),
      ),
    );
    if (!claimed) {
      const since = link.refreshClaimedAt?.getTime() ?? now.getTime();
      throw conflict('recently_refreshed', (since + REFRESH_COOLDOWN_MS - now.getTime()) / 1000);
    }
    const token = await this.refreshToken(context, link);
    const rows = await this.deps.database.read(context, (runner) =>
      this.repository.listFrames(runner, context, link.id),
    );
    const whole = link.captureMode === 'whole_file';
    let outline: FigmaOutline;
    let frames: readonly PlannedFrame[];
    try {
      outline = await this.deps.rest.outline(token, link.fileKey);
      frames = await this.framesFor(
        token,
        link.fileKey,
        outline,
        whole ? null : rows.map((row) => row.nodeId),
        [link.focusNodeId, ...rows.filter((row) => row.pageId === null).map((row) => row.nodeId)],
      );
    } catch (error) {
      if (error instanceof FigmaRateLimitError) {
        const until = new Date(now.getTime() + figmaWaitMs(error.retryAfterSeconds));
        await this.deps.database.transaction(context, (tx) =>
          this.repository.setFigmaWait(tx, context, link.id, until),
        );
        throw conflict('rate_limited', (until.getTime() - now.getTime()) / 1000);
      }
      throw await this.figmaCallFailure(context, error);
    }
    const placements = placeFrames(
      frames,
      link.focusNodeId,
      whole ? parsePageFilter(link.pageFilterJson) : null,
      whole ? MAX_CAPTURED_FRAMES : Number.MAX_SAFE_INTEGER,
    );
    const diff = diffFrames(rows, frames, placements);
    const queued = [...placements.values()].filter((place) => place.captured).length;
    await this.deps.database.transaction(context, async (tx) => {
      await this.repository.applyFrameDiff(tx, context, link.id, diff);
      await this.repository.updateLinkOutline(tx, context, link.id, {
        fileName: outline.name === '' ? null : outline.name,
        outlineJson: storedOutlineJson(outline),
      });
      await this.auditAllowed(tx, context, principal, 'figma.link_refreshed', link.id, {
        project_id: link.projectId,
        added: diff.inserts.length,
        updated: diff.updates.length,
        removed: diff.gone.length,
        queued,
      });
    });
    this.deps.snapshots?.request();
    return { queued };
  }

  /**
   * `PUT figma/links/:linkId/pages` — which pages to capture when the file has more frames than
   * one link captures (`pageIds: null` is every page). No Figma call: the listed frames are
   * placed again and the job captures the newly chosen ones.
   */
  async setPages(
    context: TenantContext,
    principal: Principal,
    linkId: string,
    input: PagesInput,
  ): Promise<FigmaLinkView> {
    this.requireStaff(principal);
    requireId(linkId, 'linkId');
    const { link, project } = await this.access.readableLink(context, principal, linkId);
    if (!this.mayWrite(principal, link, project)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'figma_write_denied');
    }
    const known = new Set(parseStoredOutline(link.outlineJson).pages.map((page) => page.id));
    let filter: ReadonlySet<string> | null = null;
    if (input.pageIds !== null && input.pageIds !== undefined) {
      if (!Array.isArray(input.pageIds) || input.pageIds.length === 0) {
        throw invalid('pageIds', 'choose at least one page, or null for every page');
      }
      const ids = new Set<string>();
      for (const raw of input.pageIds) {
        const id = typeof raw === 'string' ? normaliseNodeId(raw) : null;
        if (!id || !known.has(id)) throw invalid('pageIds', 'must be pages of this file');
        ids.add(id);
      }
      filter = ids;
    }
    await this.deps.database.transaction(context, async (tx) => {
      const rows = (await this.repository.listFrames(tx, context, link.id)).filter(
        (row) => row.goneAt === null,
      );
      await this.repository.setPageFilter(
        tx,
        context,
        link.id,
        filter ? JSON.stringify([...filter]) : null,
      );
      await this.repository.placeFrames(
        tx,
        context,
        rows,
        placeFrames(rows.map(fromRow), link.focusNodeId, filter, MAX_CAPTURED_FRAMES),
      );
    });
    this.deps.snapshots?.request();
    return this.link(context, principal, 'internal', link.id);
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
    const frame = await this.readyFrame(context, principal, door, frameId);
    return this.openStored(frame.snapshotObjectKey!, 'image/png');
  }

  /** `GET figma/frames/:frameId/thumb` (and the portal twin): the whole-page view's picture. */
  async thumb(
    context: TenantContext,
    principal: Principal,
    door: FigmaDoor,
    frameId: string,
  ): Promise<SnapshotContent> {
    const frame = await this.readyFrame(context, principal, door, frameId);
    if (!frame.hasThumb) throw notFound();
    return this.openStored(figmaThumbObjectKey(frame.snapshotObjectKey!), 'image/webp');
  }

  /**
   * `GET figma/frames/:frameId/render` (and the portal twin) — the frame rendered sharper for
   * zooming in, at the scale {@link renderScale} allows (up to Figma's 4×). The scale is the
   * server's, never the caller's. A render already stored (keyed by the snapshot's hash, so a
   * refresh makes a new one) is served at once; a new one is fetched with the link creator's
   * Figma connection — the client never needs one — under a per-person and per-workspace limit.
   */
  async render(
    context: TenantContext,
    principal: Principal,
    door: FigmaDoor,
    frameId: string,
  ): Promise<SnapshotContent> {
    const frame = await this.readyFrame(context, principal, door, frameId);
    const scale = renderScale(frame.width, frame.height);
    if (scale === null) throw notFound();
    const objectKey = figmaRenderObjectKey(frame.snapshotObjectKey!, scale, frame.snapshotHash);
    try {
      return await this.openStored(objectKey, 'image/png');
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
    }
    const pending = this.renders.get(objectKey);
    if (pending) {
      await pending;
      return this.openStored(objectKey, 'image/png');
    }
    const admission = this.deps.renderAdmission ?? this.defaultAdmission;
    if (!admission.person(`${context.organizationId}:${principal.userId}`)) throw rateLimited();
    if (!admission.workspace(context.organizationId)) throw rateLimited();
    const work = this.drawRender(context, frame, scale, objectKey);
    this.renders.set(objectKey, work);
    try {
      await work;
    } finally {
      this.renders.delete(objectKey);
    }
    return this.openStored(objectKey, 'image/png');
  }

  private async drawRender(
    context: TenantContext,
    frame: FigmaFrameRow,
    scale: number,
    objectKey: string,
  ): Promise<void> {
    const link = await this.deps.database.read(context, (runner) =>
      this.repository.findLink(runner, context, frame.linkId),
    );
    if (!link) throw notFound();
    const token = await readMemberToken(
      this.deps.database,
      this.repository,
      this.deps.cipher,
      context,
      link.createdByMembershipId,
    );
    if (!token) throw conflict('not_connected');
    let bytes: Uint8Array;
    try {
      const urls = await this.deps.rest.renderUrls(token, link.fileKey, [frame.nodeId], scale);
      const url = urls.get(frame.nodeId);
      if (!url) throw notFound();
      bytes = await this.deps.rest.download(url, MAX_RENDER_BYTES);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw this.figmaFailure(error);
    }
    await this.deps.store.putDerivative({ objectKey, body: bytes });
    await this.deps.database.transaction(context, (tx) =>
      this.deps.audit.record(tx, context, {
        action: 'figma.snapshot_taken',
        objectId: frame.id,
        result: 'allowed',
        metadata: {
          figma_link_id: link.id,
          project_id: link.projectId,
          width: frame.width,
          height: frame.height,
          render_scale: scale,
        },
      }),
    );
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** A frame of a link the caller may read, whose snapshot is stored; one 404 otherwise. */
  private async readyFrame(
    context: TenantContext,
    principal: Principal,
    door: FigmaDoor,
    frameId: string,
  ): Promise<FigmaFrameRow> {
    this.requireDoor(principal, door);
    requireId(frameId, 'frameId');
    const frame = await this.deps.database.read(context, (runner) =>
      this.repository.findFrame(runner, context, frameId),
    );
    if (!frame || frame.snapshotStatus !== 'ready' || !frame.snapshotObjectKey) throw notFound();
    await this.access.readableLink(context, principal, frame.linkId);
    return frame;
  }

  private async openStored(objectKey: string, mimeType: string): Promise<SnapshotContent> {
    try {
      const opened = await this.deps.store.openDerivative({ objectKey });
      return { mimeType, sizeBytes: opened.sizeBytes, stream: opened.stream as Readable };
    } catch (error) {
      if (error instanceof ObjectNotFoundError) throw notFound();
      throw error;
    }
  }

  /** The member's own decrypted token, or 409 "Connect Figma first". */
  private async tokenFor(context: TenantContext): Promise<string> {
    const token = await readMemberToken(
      this.deps.database,
      this.repository,
      this.deps.cipher,
      context,
      context.membershipId,
      false,
    );
    if (!token) throw conflict('not_connected');
    return token;
  }

  /** Refresh reads Figma as the person refreshing, or else as the member who attached the link. */
  private async refreshToken(context: TenantContext, link: FigmaLinkRow): Promise<string> {
    const own = await readMemberToken(
      this.deps.database,
      this.repository,
      this.deps.cipher,
      context,
      context.membershipId,
    );
    const token =
      own ??
      (await readMemberToken(
        this.deps.database,
        this.repository,
        this.deps.cipher,
        context,
        link.createdByMembershipId,
      ));
    if (!token) throw conflict('not_connected');
    return token;
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
    const base = `${client ? '/portal' : ''}/figma/frames/${row.id}`;
    const version = `v=${(row.snapshotHash ?? '').slice(0, 12)}`;
    const sharp = ready && row.snapshotHash ? renderScale(row.width, row.height) : null;
    return {
      id: row.id,
      nodeId: row.nodeId,
      name: row.name,
      width: row.width,
      height: row.height,
      pageId: row.pageId,
      pageName: row.pageName,
      sectionName: row.sectionName,
      x: row.posX,
      y: row.posY,
      snapshotStatus: row.snapshotStatus as FigmaSnapshotStatusView,
      snapshotPath: ready ? `${base}/snapshot?${version}` : null,
      thumbPath: ready && row.hasThumb ? `${base}/thumb?${version}` : null,
      sharpPath: sharp === null ? null : `${base}/render?${version}`,
      sharpScale: sharp,
      capturedAt: row.capturedAt ? row.capturedAt.toISOString() : null,
      sizeChanged: row.sizeChanged,
      gone: row.goneAt !== null,
      snapshotError: !client && isSnapshotError(row.snapshotError) ? row.snapshotError : null,
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
    if (error instanceof FigmaRateLimitError) {
      return conflict('rate_limited', figmaWaitMs(error.retryAfterSeconds) / 1000);
    }
    return conflict('unreachable');
  }
}

const SNAPSHOT_ERRORS: ReadonlySet<string> = new Set<FigmaSnapshotError>([
  'no_connection',
  'no_access',
  'not_found',
  'too_large',
  'unreachable',
]);

function isSnapshotError(raw: string | null): raw is FigmaSnapshotError {
  return raw !== null && SNAPSHOT_ERRORS.has(raw);
}

function detectedView(frame: PlannedFrame): FigmaDetectedFrameView {
  return {
    nodeId: frame.nodeId,
    name: frame.name,
    width: frame.width,
    height: frame.height,
    pageName: frame.pageName,
    sectionName: frame.sectionName,
  };
}
