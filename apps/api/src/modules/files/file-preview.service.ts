import { authorize } from '@tmanage/domain';
import type { AuditAction, Capability, Principal } from '@tmanage/domain';
import { ObjectNotFoundError } from '@tmanage/storage';
import type { ObjectStore, OpenedObject } from '@tmanage/storage';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FileAssetRow, FileVersionRow, ProjectRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import { DeliverableVersionsRepository } from '../approvals/deliverable-versions.repository.js';
import { AttachmentVersionsRepository } from './attachment-versions.repository.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import { FileClientRelation } from './file-client-relation.js';
import { assertDoor, destroy, mayServeOriginalInline } from './file-download.service.js';
import type { FileAccess, FileDownloadService, ResolvedFile } from './file-download.service.js';
import { FilePreviewsRepository } from './file-previews.repository.js';
import type { FilePreview, PreviewKind } from './file-previews.repository.js';
import { previewPlanFor } from './preview-generators/index.js';
import type { PreviewRequester } from './preview-job.js';

/**
 * R4 slice 4 — the viewer's manifest, the derivative bytes, and "Try again".
 *
 * Every read goes through {@link FileDownloadService.resolve}: the same row, purpose, client
 * relation, `authorize()` and scan-policy decision the download door makes, so a file the viewer
 * shows is exactly a file the caller could download, and every refusal is the door's one 404
 * (audited as `file_preview.viewed`, `denied`). The manifest reports a not-yet-scanned file as
 * `pending` instead of failing, so the screen can say "Preview after the virus check".
 *
 * Derivative bytes are served `inline` only for the types TManage itself made
 * ({@link PREVIEW_INLINE_TYPES}); an SVG only as the sanitised `svg_safe` copy, under
 * `Content-Security-Policy: sandbox; default-src 'none'`. The original keeps the download door.
 *
 * Audit: one `file_preview.viewed` `allowed` row per principal and file per
 * {@link VIEW_AUDIT_WINDOW_MS}, not one per page tile.
 */
export const FILE_PREVIEW_SERVICE = Symbol.for('tmanage.FilePreviewService');

const VIEW_ACTION: AuditAction = 'file_preview.viewed';

/** One allowed audit row per principal and file per ten minutes. */
export const VIEW_AUDIT_WINDOW_MS = 10 * 60_000;

/** The derivative types the content route renders in place. TManage wrote every one of them. */
export const PREVIEW_INLINE_TYPES: ReadonlySet<string> = new Set([
  'image/webp',
  'image/png',
  'image/jpeg',
  'image/svg+xml',
]);

/** The derivative kinds that carry bytes a viewer shows (the `*_meta` kinds are numbers only). */
const DISPLAY_KINDS: ReadonlySet<PreviewKind> = new Set<PreviewKind>([
  'preview',
  'thumb',
  'page_thumb',
  'svg_safe',
  'psd_flat',
  'poster',
]);

export type ViewerKind =
  | 'image'
  | 'svg'
  | 'pdf'
  | 'psd'
  | 'office_docx'
  | 'office_pptx'
  | 'office_xlsx'
  | 'video'
  | 'audio'
  | 'zip'
  | 'text'
  | 'unsupported';

export type PreviewManifestStatus = 'ready' | 'pending' | 'failed' | 'unsupported';

/** The version's scan state as the viewer labels it. */
export type PreviewScanStatus = 'clean' | 'not_scanned' | 'pending_scan' | 'blocked';

/** One derivative the viewer may load. `url` is an API path (prefix it with the API origin). */
export interface PreviewDerivativeView {
  readonly id: string;
  readonly kind: string;
  /** 0 for a whole-file derivative; 1, 2 … for a page. */
  readonly pageNo: number;
  readonly url: string;
  readonly mimeType: string;
  readonly width: number | null;
  readonly height: number | null;
}

export interface PreviewFileView {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
}

export interface PreviewVersionInfoView {
  readonly fileVersionId: string;
  readonly mimeType: string | null;
  readonly sizeBytes: number;
  readonly scanStatus: PreviewScanStatus;
}

/** One version of the attachment chain the caller may open. */
export interface PreviewChainVersionView {
  readonly versionNo: number;
  readonly fileAssetId: string;
  readonly fileName: string;
  readonly createdAt: string;
  readonly current: boolean;
}

export interface PreviewChainView {
  readonly rootFileAssetId: string;
  /** Newest first; always at least the file itself. */
  readonly versions: readonly PreviewChainVersionView[];
}

export interface PreviewCapabilitiesView {
  readonly canComment: boolean;
  readonly canDraw: boolean;
  readonly canResolve: boolean;
  readonly canDecide: boolean;
  readonly canUploadVersion: boolean;
  readonly canDownload: boolean;
  readonly canRetry: boolean;
}

/**
 * What Approve / Request changes act on: a plain file, or a deliverable version (whose buttons
 * call the existing approval routes).
 */
export interface PreviewDecisionContextView {
  readonly kind: 'file' | 'deliverable';
  readonly deliverableId: string | null;
  readonly deliverableVersionId: string | null;
}

/**
 * R4 slice 9 — what the video / audio stage needs before it loads a byte: the picture size (to
 * reserve the frame), and whether a browser can play the codec at all. `codecNotice` names the
 * track a browser cannot decode (an HEVC or ProRes `.mov`); the screen then offers the download
 * and an "upload an MP4" hint instead of a player that never starts. Codec names are MediaInfo's
 * format names ("AVC", "HEVC", "AAC"), shown only as facts in the Details tab.
 */
export interface PreviewMediaView {
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  readonly width: number | null;
  readonly height: number | null;
  readonly rotation: number;
  readonly frameRate: number | null;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly sampleRate: number | null;
  readonly channels: number | null;
  readonly codecNotice: 'video_codec' | 'audio_codec' | null;
}

export interface FilePreviewManifestView {
  readonly file: PreviewFileView;
  readonly version: PreviewVersionInfoView | null;
  readonly kind: ViewerKind;
  readonly status: PreviewManifestStatus;
  readonly derivatives: readonly PreviewDerivativeView[];
  /**
   * The original's bytes for a stage that plays or parses them itself (PDF, video, audio, GIF,
   * text) — `?inline=1` for media. `null` while the file may not be served.
   */
  readonly originalUrl: string | null;
  readonly pages: number | null;
  readonly durationMs: number | null;
  /** Video and audio facts once the preview job has read them; `null` before, and for other kinds. */
  readonly media: PreviewMediaView | null;
  /** A browser-side rendering is approximate (Office files): the screen says so. */
  readonly approximate: boolean;
  /** The sanitised SVG dropped outside references (linked images, remote styles). */
  readonly linkedImagesRemoved: boolean;
  readonly versions: PreviewChainView;
  readonly decisionContext: PreviewDecisionContextView;
  readonly capabilities: PreviewCapabilitiesView;
}

export interface PreviewRetryView {
  /** How many failed previews went back into the queue. */
  readonly reset: number;
}

/** Derivative bytes, ready for the response. */
export interface PreviewContent {
  readonly stream: OpenedObject['stream'];
  readonly mimeType: string;
  readonly sizeBytes: number;
}

export interface ManifestInput {
  readonly orgSlug: string;
  readonly fileAssetId: string;
  /** Opened from a deliverable version: the manifest's decision context names it. */
  readonly deliverableVersionId?: string | undefined;
}

export type PreviewDoor = 'internal' | 'client';

export function viewerKindFor(mimeType: string | null): ViewerKind {
  if (mimeType === null) return 'unsupported';
  if (mimeType === 'image/svg+xml') return 'svg';
  if (mimeType === 'image/vnd.adobe.photoshop') return 'psd';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/zip') return 'zip';
  if (mimeType.startsWith('text/')) return 'text';
  if (mimeType.endsWith('.wordprocessingml.document')) return 'office_docx';
  if (mimeType.endsWith('.presentationml.presentation')) return 'office_pptx';
  if (mimeType.endsWith('.spreadsheetml.sheet')) return 'office_xlsx';
  return 'unsupported';
}

/** Kinds the browser renders from the original itself, whatever derivatives exist. */
function rendersOriginal(kind: ViewerKind, mimeType: string | null): boolean {
  return (
    kind === 'pdf' ||
    kind === 'video' ||
    kind === 'audio' ||
    kind === 'text' ||
    mimeType === 'image/gif'
  );
}

/**
 * The manifest's status from the version's access and its derivative rows: `pending` while the
 * scan or the preview job has work to do, `failed` when every try failed (or the file was
 * blocked), `unsupported` when nothing can be shown in place.
 */
export function manifestStatusFor(input: {
  readonly access: FileAccess['state'];
  readonly kind: ViewerKind;
  readonly mimeType: string | null;
  readonly planned: boolean;
  readonly rows: readonly FilePreview[];
}): PreviewManifestStatus {
  if (input.access === 'blocked') return 'failed';
  if (input.access !== 'servable') return 'pending';
  if (rendersOriginal(input.kind, input.mimeType)) return 'ready';
  if (!input.planned) return 'unsupported';
  if (input.rows.length === 0) return 'pending';
  const shown = input.rows.some(
    (row) => row.status === 'ready' && (row.kind === 'preview' || row.kind === 'svg_safe'),
  );
  if (shown) return 'ready';
  if (input.rows.some((row) => row.status === 'pending')) return 'pending';
  if (input.rows.some((row) => row.status === 'failed')) return 'failed';
  return 'unsupported';
}

/** Whether a derivative row may be served inline as the bytes it claims to be. */
export function isInlineDerivative(row: FilePreview): boolean {
  if (row.status !== 'ready' || row.objectKey === null || row.mimeType === null) return false;
  if (!DISPLAY_KINDS.has(row.kind)) return false;
  if (!PREVIEW_INLINE_TYPES.has(row.mimeType)) return false;
  // An SVG is served only as the sanitised copy, never under another kind.
  if (row.mimeType === 'image/svg+xml') return row.kind === 'svg_safe';
  return true;
}

/** Remembers when each principal last had a view audited, so a page of tiles is one row. */
export class ViewAuditDebounce {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly windowMs: number = VIEW_AUDIT_WINDOW_MS,
    private readonly maxEntries: number = 10_000,
  ) {}

  /** `true` when this view should be audited now (and records it). */
  take(key: string, now: number): boolean {
    const last = this.seen.get(key);
    if (last !== undefined && now - last < this.windowMs) return false;
    if (this.seen.size >= this.maxEntries) this.seen.clear();
    this.seen.set(key, now);
    return true;
  }
}

export class FilePreviewService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly downloads: FileDownloadService,
    private readonly assets: FileAssetsRepository,
    private readonly store: ObjectStore,
    private readonly audit: AuditService,
    private readonly previews: FilePreviewsRepository = new FilePreviewsRepository(),
    private readonly requester?: PreviewRequester,
    private readonly relation: FileClientRelation = new FileClientRelation(),
    private readonly versions: AttachmentVersionsRepository = new AttachmentVersionsRepository(),
    private readonly deliverableVersions: DeliverableVersionsRepository = new DeliverableVersionsRepository(),
    private readonly debounce: ViewAuditDebounce = new ViewAuditDebounce(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** `GET …/files/:fileAssetId/preview` (studio) and `…/portal/files/:fileAssetId/preview`. */
  async manifest(
    context: TenantContext,
    principal: Principal,
    door: PreviewDoor,
    input: ManifestInput,
  ): Promise<FilePreviewManifestView> {
    assertDoor(principal, door);
    const resolved = await this.downloads.resolve(
      context,
      principal,
      input.fileAssetId,
      VIEW_ACTION,
    );
    const { asset, version, access } = resolved;
    const base = filesBase(input.orgSlug, door, asset.id);
    const mimeType = version?.detectedMimeType ?? null;
    const kind = viewerKindFor(mimeType);

    const { rows, chain, decisionContext } = await this.database.read(context, async (runner) => ({
      rows: version ? await this.previews.listForVersion(runner, context, version.id) : [],
      chain: await this.chainFor(runner, context, principal, asset),
      decisionContext: await this.decisionContextFor(
        runner,
        context,
        asset,
        input.deliverableVersionId,
      ),
    }));

    const servable = access.state === 'servable';
    const status = manifestStatusFor({
      access: access.state,
      kind,
      mimeType,
      planned: previewPlanFor(mimeType).length > 0,
      rows,
    });
    const derivatives = servable
      ? rows.filter(isInlineDerivative).map((row) => toDerivativeView(row, base))
      : [];
    const original =
      servable && mimeType !== null
        ? `${base}/content${mayServeOriginalInline(mimeType) ? '?inline=1' : ''}`
        : null;

    if (servable) await this.auditView(context, principal, asset, version, null);

    return {
      file: { id: asset.id, name: asset.name, projectId: asset.projectId },
      version: version ? toVersionInfo(version, access) : null,
      kind,
      status,
      derivatives,
      originalUrl: original,
      pages: numberMeta(rows, 'pages'),
      durationMs: numberMeta(rows, 'durationMs'),
      media: servable ? mediaViewFrom(rows) : null,
      approximate: booleanMeta(rows, 'approximate'),
      linkedImagesRemoved: booleanMeta(rows, 'linkedImagesRemoved'),
      versions: chain,
      decisionContext,
      capabilities: this.capabilitiesFor(principal, resolved, rows),
    };
  }

  /** `GET …/preview/:previewId/content` — one derivative's bytes, under the download gate. */
  async content(
    context: TenantContext,
    principal: Principal,
    door: PreviewDoor,
    fileAssetId: string,
    previewId: string,
  ): Promise<PreviewContent> {
    assertDoor(principal, door);
    const { asset, version, access } = await this.downloads.resolve(
      context,
      principal,
      fileAssetId,
      VIEW_ACTION,
    );
    if (version === null) throw await this.downloads.notReady(context, asset.status, VIEW_ACTION);
    if (access.state === 'scan_required_by_policy') {
      throw await this.downloads.blockedByPolicy(context, VIEW_ACTION);
    }
    if (access.state !== 'servable') {
      throw await this.downloads.notReady(context, asset.status, VIEW_ACTION);
    }

    const row = await this.database.read(context, (runner) =>
      this.previews.findById(runner, context, previewId),
    );
    // The row must be this file's, of the version the door would serve, ready, and ours to inline.
    if (
      !row ||
      row.fileAssetId !== asset.id ||
      row.fileVersionId !== version.id ||
      !isInlineDerivative(row) ||
      row.objectKey === null ||
      row.mimeType === null
    ) {
      throw await this.downloads.refuse(context, 'preview_not_found', VIEW_ACTION);
    }

    let opened: OpenedObject;
    try {
      opened = await this.store.openDerivative({ objectKey: row.objectKey });
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        throw await this.downloads.refuse(context, 'derivative_missing', VIEW_ACTION);
      }
      throw error;
    }
    if (row.sizeBytes !== null && opened.sizeBytes !== row.sizeBytes) {
      destroy(opened.stream);
      throw await this.downloads.refuse(context, 'size_mismatch', VIEW_ACTION);
    }
    try {
      await this.auditView(context, principal, asset, version, row.kind);
    } catch (error) {
      destroy(opened.stream);
      throw error;
    }
    return { stream: opened.stream, mimeType: row.mimeType, sizeBytes: opened.sizeBytes };
  }

  /** `POST …/files/:fileAssetId/preview/retry` — studio only, `file.upload`. */
  async retry(
    context: TenantContext,
    principal: Principal,
    fileAssetId: string,
  ): Promise<PreviewRetryView> {
    assertDoor(principal, 'internal');
    const resolved = await this.downloads.resolve(context, principal, fileAssetId, VIEW_ACTION);
    if (!this.allowed(principal, resolved, 'file.upload')) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'retry_not_allowed');
    }
    const reset = await this.database.transaction(context, (tx) =>
      this.previews.resetFailed(tx, context, resolved.asset.id, this.now()),
    );
    if (reset > 0) this.requester?.request();
    return { reset };
  }

  private async auditView(
    context: TenantContext,
    principal: Principal,
    asset: FileAssetRow,
    version: FileVersionRow | null,
    previewKind: string | null,
  ): Promise<void> {
    const key = `${context.organizationId}:${principal.userId}:${asset.id}`;
    if (!this.debounce.take(key, this.now().getTime())) return;
    await this.database.transaction(context, (tx) =>
      this.audit.record(tx, context, {
        action: VIEW_ACTION,
        objectId: asset.id,
        result: 'allowed',
        actorUserId: principal.userId,
        metadata: {
          project_id: asset.projectId,
          file_version_id: version?.id ?? null,
          preview_kind: previewKind,
          principal_kind: principal.kind,
        },
      }),
    );
  }

  private capabilitiesFor(
    principal: Principal,
    resolved: ResolvedFile,
    rows: readonly FilePreview[],
  ): PreviewCapabilitiesView {
    const active = resolved.project.archivedAt === null;
    const canComment = active && this.allowed(principal, resolved, 'file.upload');
    const internal = principal.kind === 'internal';
    const canUploadVersion = internal && canComment;
    return {
      canComment,
      canDraw: canComment,
      canResolve: canComment,
      canDecide: active && this.allowed(principal, resolved, 'approval.decide'),
      canUploadVersion,
      canDownload: resolved.access.state === 'servable',
      canRetry: canUploadVersion && rows.some((row) => row.status === 'failed'),
    };
  }

  private allowed(principal: Principal, resolved: ResolvedFile, capability: Capability): boolean {
    const { asset, project } = resolved;
    return authorize({
      principal,
      capability,
      resource: {
        organizationId: asset.organizationId,
        projectId: asset.projectId,
        // The gate already decided the caller may read this file; a published deliverable's
        // file is client content even when its upload was internal.
        audience: principal.kind === 'client' ? 'client_visible' : asset.audience,
        clientOrganizationId: asset.clientOrganizationId,
        lifecycle: lifecycleOf(project),
        // A plain file's decision is open to any client whose role holds `approval.decide`
        // (SPEC §3.4); a deliverable's own approval routes check the reviewer relation.
        ...(capability === 'approval.decide' ? { isAssignedReviewer: true } : {}),
      },
    }).allowed;
  }

  /** The attachment chain, limited to the versions this caller may open. */
  private async chainFor(
    runner: Parameters<FileClientRelation['reach']>[0],
    context: TenantContext,
    principal: Principal,
    asset: FileAssetRow,
  ): Promise<PreviewChainView> {
    const link = await this.versions.findInvolving(runner, context, asset.id);
    const rootId = link ? link.rootFileAssetId : asset.id;
    const root = rootId === asset.id ? asset : await this.assets.findById(runner, context, rootId);
    const entries: { versionNo: number; asset: FileAssetRow; createdAt: Date }[] = [];
    if (root) entries.push({ versionNo: 1, asset: root, createdAt: root.createdAt });
    if (link) {
      for (const row of await this.versions.listForRoot(runner, context, rootId)) {
        const member =
          row.fileAssetId === asset.id
            ? asset
            : await this.assets.findById(runner, context, row.fileAssetId);
        if (member)
          entries.push({ versionNo: row.versionNo, asset: member, createdAt: row.createdAt });
      }
    }
    const visible: typeof entries = [];
    for (const entry of entries) {
      if (
        entry.asset.id === asset.id ||
        (await this.mayOpen(runner, context, principal, entry.asset))
      ) {
        visible.push(entry);
      }
    }
    const newestFirst = visible.sort((a, b) => b.versionNo - a.versionNo);
    const newest = entries.reduce((max, entry) => Math.max(max, entry.versionNo), 0);
    return {
      rootFileAssetId: rootId,
      versions: newestFirst.map((entry) => ({
        versionNo: entry.versionNo,
        fileAssetId: entry.asset.id,
        fileName: entry.asset.name,
        createdAt: entry.createdAt.toISOString(),
        current: entry.versionNo === newest,
      })),
    };
  }

  /** The door's read decision for another version (without its scan state or an audit row). */
  private async mayOpen(
    runner: Parameters<FileClientRelation['reach']>[0],
    context: TenantContext,
    principal: Principal,
    member: FileAssetRow,
  ): Promise<boolean> {
    if (member.deletedAt !== null) return false;
    let audience = member.audience;
    if (principal.kind === 'client') {
      const reach = await this.relation.reach(runner, context, principal, member);
      if (!reach) return false;
      audience = reach.audience;
    }
    return authorize({
      principal,
      capability: 'file.download',
      resource: {
        organizationId: member.organizationId,
        projectId: member.projectId,
        audience,
        clientOrganizationId: member.clientOrganizationId,
        lifecycle: 'active',
      },
    }).allowed;
  }

  private async decisionContextFor(
    runner: Parameters<FileClientRelation['reach']>[0],
    context: TenantContext,
    asset: FileAssetRow,
    deliverableVersionId: string | undefined,
  ): Promise<PreviewDecisionContextView> {
    const plain: PreviewDecisionContextView = {
      kind: 'file',
      deliverableId: null,
      deliverableVersionId: null,
    };
    if (!deliverableVersionId || !UUID.test(deliverableVersionId)) return plain;
    const named = await this.deliverableVersions.findById(runner, context, deliverableVersionId);
    if (!named || named.fileAssetId !== asset.id || named.projectId !== asset.projectId) {
      return plain;
    }
    return {
      kind: 'deliverable',
      deliverableId: named.deliverableId,
      deliverableVersionId: named.id,
    };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function filesBase(orgSlug: string, door: PreviewDoor, fileAssetId: string): string {
  const portal = door === 'client' ? '/portal' : '';
  return `/v1/organizations/${encodeURIComponent(orgSlug)}${portal}/files/${encodeURIComponent(fileAssetId)}`;
}

function toDerivativeView(row: FilePreview, base: string): PreviewDerivativeView {
  return {
    id: row.id,
    kind: row.kind,
    pageNo: row.pageNo,
    url: `${base}/preview/${encodeURIComponent(row.id)}/content`,
    mimeType: row.mimeType ?? '',
    width: row.width,
    height: row.height,
  };
}

function toVersionInfo(version: FileVersionRow, access: FileAccess): PreviewVersionInfoView {
  return {
    fileVersionId: version.id,
    mimeType: version.detectedMimeType,
    sizeBytes: version.sizeBytes,
    scanStatus:
      access.state === 'servable'
        ? access.scanStatus
        : access.state === 'blocked'
          ? 'blocked'
          : 'pending_scan',
  };
}

function lifecycleOf(project: ProjectRow): 'active' | 'archived' {
  return project.archivedAt === null ? 'active' : 'archived';
}

function numberMeta(rows: readonly FilePreview[], key: string): number | null {
  for (const row of rows) {
    const value = row.status === 'ready' ? row.meta?.[key] : undefined;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function stringMeta(meta: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = meta[key];
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 64) : null;
}

function finiteMeta(meta: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = meta[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The ready `media_meta` row as the manifest's `media` block (`null` until the job has run). */
export function mediaViewFrom(rows: readonly FilePreview[]): PreviewMediaView | null {
  const row = rows.find(
    (candidate) => candidate.kind === 'media_meta' && candidate.status === 'ready',
  );
  const meta = row?.meta;
  if (!meta) return null;
  const notice = meta['codecNotice'];
  const rotation = finiteMeta(meta, 'rotation');
  return {
    hasVideo: meta['hasVideo'] === true,
    hasAudio: meta['hasAudio'] === true,
    width: finiteMeta(meta, 'width'),
    height: finiteMeta(meta, 'height'),
    rotation: rotation === 90 || rotation === 180 || rotation === 270 ? rotation : 0,
    frameRate: finiteMeta(meta, 'frameRate'),
    videoCodec: stringMeta(meta, 'videoCodec'),
    audioCodec: stringMeta(meta, 'audioCodec'),
    sampleRate: finiteMeta(meta, 'sampleRate'),
    channels: finiteMeta(meta, 'channels'),
    codecNotice: notice === 'video_codec' || notice === 'audio_codec' ? notice : null,
  };
}

function booleanMeta(rows: readonly FilePreview[], key: string): boolean {
  return rows.some((row) => row.status === 'ready' && row.meta?.[key] === true);
}
