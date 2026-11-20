import type { ApiClient } from './client';

/**
 * R4 slice 4 — the viewer manifest (`GET …/files/:fileAssetId/preview`, and the portal twin
 * `GET …/portal/files/:fileAssetId/preview`) and its retry (`POST …/preview/retry`, studio only).
 *
 * Every `url` in the manifest (`derivatives[].url`, `originalUrl`) is an API path: the screen
 * prefixes it with `apiBaseUrl()` and the browser sends the session cookie (`<img>` with
 * `crossorigin="use-credentials"`, `<video crossorigin="use-credentials">`, or a credentialed
 * `fetch` for pdf.js). Mirrors the API's `FilePreviewManifestView` and its parts (paired `Exact`
 * in `e2e/contracts/api-web-shapes.ts`).
 */
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
  | 'fig'
  | 'text'
  | 'unsupported';

export type PreviewManifestStatus = 'ready' | 'pending' | 'failed' | 'unsupported';

export type PreviewScanStatus = 'clean' | 'not_scanned' | 'pending_scan' | 'blocked';

export interface PreviewDerivative {
  readonly id: string;
  readonly kind: string;
  /** 0 for a whole-file derivative; 1, 2 … for a page. */
  readonly pageNo: number;
  readonly url: string;
  readonly mimeType: string;
  readonly width: number | null;
  readonly height: number | null;
}

export interface PreviewFile {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
}

export interface PreviewVersionInfo {
  readonly fileVersionId: string;
  readonly mimeType: string | null;
  readonly sizeBytes: number;
  readonly scanStatus: PreviewScanStatus;
  /** QA-FIX S9. Why a `blocked` file was refused, by kind; `null` otherwise. */
  readonly blockedReason?: PreviewBlockedReason | null;
}

/** QA-FIX S9. The API's `BlockedReason` (`apps/api/src/modules/files/file-safety.ts`). */
export type PreviewBlockedReason = 'malware' | 'file_type' | 'content' | 'damaged';

export interface PreviewChainVersion {
  readonly versionNo: number;
  readonly fileAssetId: string;
  readonly fileName: string;
  readonly createdAt: string;
  readonly current: boolean;
}

export interface PreviewChain {
  readonly rootFileAssetId: string;
  /** Newest first; always at least the file itself. */
  readonly versions: readonly PreviewChainVersion[];
}

export interface PreviewCapabilities {
  /** 52-24: the `proofing` flag. Off, comments are neither read nor shown (the routes answer 404). */
  readonly canReview: boolean;
  readonly canComment: boolean;
  readonly canDraw: boolean;
  readonly canResolve: boolean;
  readonly canDecide: boolean;
  readonly canUploadVersion: boolean;
  readonly canDownload: boolean;
  readonly canRetry: boolean;
  /** FIX5 item 5. The uploader, a project manager or the company owner/admin may delete the file. */
  readonly canDelete: boolean;
}

export interface PreviewDecisionContext {
  readonly kind: 'file' | 'deliverable';
  readonly deliverableId: string | null;
  readonly deliverableVersionId: string | null;
}

/**
 * R4 slice 9 — video / audio facts read by the preview job (`media_meta`). `codecNotice` says the
 * browser cannot decode a track (HEVC / ProRes picture, AC-3 sound …): the stage shows the notice
 * and the download instead of a player that never starts.
 */
export type CodecNotice = 'video_codec' | 'audio_codec';

export interface PreviewMedia {
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  readonly width: number | null;
  readonly height: number | null;
  /** Degrees the picture is turned (0, 90, 180, 270). */
  readonly rotation: number;
  readonly frameRate: number | null;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  /** Sound samples a second and channel count of the sound track. */
  readonly sampleRate: number | null;
  readonly channels: number | null;
  readonly codecNotice: CodecNotice | null;
}

/** R4 slice 10 — one Photoshop layer, top first; `children` is empty unless `kind` is `group`. */
export type PsdLayerKind = 'group' | 'pixel' | 'text' | 'smart_object' | 'adjustment';

export interface PreviewPsdLayer {
  readonly name: string;
  readonly kind: PsdLayerKind;
  readonly visible: boolean;
  /** 0 … 100. */
  readonly opacity: number;
  readonly blendMode: string;
  readonly children: readonly PreviewPsdLayer[];
}

/** The PSD's layer list (read-only) and whether the preview is a stack of layers (`approximate`). */
export interface PreviewPsd {
  readonly width: number | null;
  readonly height: number | null;
  readonly layerCount: number;
  readonly groupCount: number;
  readonly approximate: boolean;
  readonly layers: readonly PreviewPsdLayer[];
}

/** One line of a ZIP's table of contents (files and the folders they imply). */
export interface PreviewZipEntry {
  readonly path: string;
  readonly folder: boolean;
  readonly sizeBytes: number;
  /** As the zipping tool wrote it, local time without a zone. */
  readonly modifiedAt: string | null;
}

/** What is inside a ZIP. Nothing is extracted or served. */
export interface PreviewZip {
  readonly fileCount: number;
  readonly folderCount: number;
  readonly totalBytes: number;
  readonly compressedBytes: number;
  readonly encrypted: boolean;
  readonly entries: readonly PreviewZipEntry[];
}

/** One frame of a `.fig` page, as the file lists it (nothing is drawn from the file). */
export interface PreviewFigFrame {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
  readonly section: string | null;
}

export interface PreviewFigPage {
  readonly name: string;
  readonly frameCount: number;
  readonly frames: readonly PreviewFigFrame[];
}

/** A `.fig` file's pages and frames; `truncated` when more exist than are listed. */
export interface PreviewFig {
  readonly fileName: string | null;
  readonly frameCount: number;
  readonly truncated: boolean;
  readonly pages: readonly PreviewFigPage[];
}

export interface PreviewOfficeSheet {
  readonly name: string;
  readonly hidden: boolean;
}

/**
 * Word / PowerPoint / Excel facts. PowerPoint: slide size in EMU (pins are stored relative to the
 * slide box) and the slide count; Word: page size in twips and Word's own page count; Excel: sheets.
 */
export interface PreviewOffice {
  readonly format: 'docx' | 'pptx' | 'xlsx';
  readonly pages: number | null;
  readonly pageWidth: number | null;
  readonly pageHeight: number | null;
  readonly sheets: readonly PreviewOfficeSheet[];
}

export interface FilePreviewManifest {
  readonly file: PreviewFile;
  readonly version: PreviewVersionInfo | null;
  readonly kind: ViewerKind;
  readonly status: PreviewManifestStatus;
  readonly derivatives: readonly PreviewDerivative[];
  /** The original's bytes for a stage that renders them itself; `null` while not servable. */
  readonly originalUrl: string | null;
  readonly pages: number | null;
  readonly durationMs: number | null;
  /** Video / audio facts; `null` until read, and for other kinds. */
  readonly media: PreviewMedia | null;
  readonly approximate: boolean;
  readonly linkedImagesRemoved: boolean;
  /** The preview is the small picture saved inside the file (an EPS), not the artwork itself. */
  readonly embeddedPreview: boolean;
  /** Photoshop layers; `null` before read, and for other kinds. */
  readonly psd: PreviewPsd | null;
  /** A ZIP's contents; `null` before read, and for other kinds. */
  readonly zip: PreviewZip | null;
  /** A `.fig` file's pages and frames; `null` before read, and for other kinds. */
  readonly fig: PreviewFig | null;
  /** Office facts; `null` before read, and for other kinds. */
  readonly office: PreviewOffice | null;
  readonly versions: PreviewChain;
  readonly decisionContext: PreviewDecisionContext;
  readonly capabilities: PreviewCapabilities;
}

export interface PreviewRetryResult {
  readonly reset: number;
}

export type PreviewDoor = 'studio' | 'portal';

function previewPath(door: PreviewDoor, organizationSlug: string, fileAssetId: string): string {
  const portal = door === 'portal' ? '/portal' : '';
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}${portal}/files/${encodeURIComponent(fileAssetId)}/preview`;
}

/**
 * The react-query key of one file's preview manifest, shared by the viewer, the compare view and
 * the small thumbnails (FIX6 item 5), so a manifest loaded once is not asked for again.
 */
export function filePreviewQueryKey(
  door: PreviewDoor,
  organizationSlug: string,
  fileAssetId: string,
  deliverableVersionId = '',
): readonly string[] {
  return ['file-preview', door, organizationSlug, fileAssetId, deliverableVersionId];
}

export async function getFilePreviewManifest(
  client: ApiClient,
  organizationSlug: string,
  fileAssetId: string,
  options: { readonly door?: PreviewDoor; readonly deliverableVersionId?: string } = {},
): Promise<FilePreviewManifest> {
  const query = options.deliverableVersionId
    ? `?deliverableVersionId=${encodeURIComponent(options.deliverableVersionId)}`
    : '';
  const { data } = await client.request<FilePreviewManifest>({
    path: `${previewPath(options.door ?? 'studio', organizationSlug, fileAssetId)}${query}`,
  });
  return data;
}

/** Put the file's failed previews back in the queue ("Try again"). Studio only. */
export async function retryFilePreview(
  client: ApiClient,
  organizationSlug: string,
  fileAssetId: string,
): Promise<PreviewRetryResult> {
  const { data } = await client.request<PreviewRetryResult>({
    method: 'POST',
    path: `${previewPath('studio', organizationSlug, fileAssetId)}/retry`,
  });
  return data;
}

/** The page-image derivatives in page order (page 0 — the whole file — first). */
export function previewPages(manifest: FilePreviewManifest): readonly PreviewDerivative[] {
  return manifest.derivatives
    .filter((derivative) => derivative.kind === 'preview' || derivative.kind === 'svg_safe')
    .slice()
    .sort((a, b) => a.pageNo - b.pageNo);
}

/** The best thumbnail for a strip or a card, if one is ready. */
export function previewThumb(
  manifest: FilePreviewManifest,
  pageNo = 0,
): PreviewDerivative | undefined {
  return (
    manifest.derivatives.find((d) => d.kind === 'thumb' && d.pageNo === pageNo) ??
    manifest.derivatives.find((d) => d.kind === 'page_thumb' && d.pageNo === pageNo)
  );
}

/** Whether the manifest is still waiting on the virus check or the preview job (poll again). */
export function previewIsPending(manifest: FilePreviewManifest): boolean {
  return manifest.status === 'pending';
}
