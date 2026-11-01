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
}

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
  readonly canComment: boolean;
  readonly canDraw: boolean;
  readonly canResolve: boolean;
  readonly canDecide: boolean;
  readonly canUploadVersion: boolean;
  readonly canDownload: boolean;
  readonly canRetry: boolean;
}

export interface PreviewDecisionContext {
  readonly kind: 'file' | 'deliverable';
  readonly deliverableId: string | null;
  readonly deliverableVersionId: string | null;
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
  readonly approximate: boolean;
  readonly linkedImagesRemoved: boolean;
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
