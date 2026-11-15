'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { getAttachmentHistory } from '../../lib/api/attachment-versions';
import { apiBaseUrl, browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { ApiRequestError } from '../../lib/api/errors';
import {
  filePreviewQueryKey,
  getFilePreviewManifest,
  previewPages,
  retryFilePreview,
  type FilePreviewManifest,
} from '../../lib/api/file-preview';
import {
  getFileReviewDecisions,
  recordFileReviewDecision,
  type FileReviewDecision,
} from '../../lib/api/file-review-decisions';
import {
  createReviewThread,
  listReviewThreads,
  moveReviewThread,
  type ReviewDoor,
  type ReviewThread,
} from '../../lib/api/review';
import { localeDirection } from '../../lib/i18n/direction';
import {
  DEFAULT_DRAW_COLOUR,
  DEFAULT_DRAW_WIDTH,
  strokesBBox,
  toDrawAnchorInput,
  type DrawStroke,
} from '../../lib/review-anchors';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useT } from '../../lib/i18n/use-t';
import { AudioStage } from './AudioStage';
import { CompareStage } from './CompareStage';
import { DecisionRail } from './DecisionRail';
import { useDeleteFile } from './DeleteFileDialog';
import { ShareFileDialog } from './ShareFileDialog';
import { HelpTip } from '../help/HelpTip';
import { CheckedLabel } from '../screens/CheckedLabel';
import type { DrawSettings } from './DrawLayer';
import { DrawToolbar } from './DrawToolbar';
import { DesktopFileStage, TextFileStage } from './FileTextStages';
import { desktopFormatFor, textViewFor } from './file-formats';
import { ImageStage } from './ImageStage';
import { MediaCodecNotice } from './MediaCodecNotice';
import { OfficeDocxStage } from './OfficeDocxStage';
import { OfficePptxStage } from './OfficePptxStage';
import { OfficeXlsxStage, type CellRef } from './OfficeXlsxStage';
import { PageStrip } from './PageStrip';
import { PdfStage, PdfThumb, usePdfDocument } from './PdfStage';
import { PinLayer, type ViewerDraft } from './PinLayer';
import { PsdLayersPanel, PsdNotice } from './PsdLayersPanel';
import { ThreadComposer, type ComposerSubmit } from './ThreadComposer';
import { ThreadPanel, type PanelTab } from './ThreadPanel';
import {
  EmbeddedPreviewChip,
  EmbeddedPreviewNotice,
  UnsupportedStage,
  unsupportedReasonFor,
} from './UnsupportedStage';
import { UploadVersionDialog } from './UploadVersionDialog';
import { VersionsTab } from './VersionsTab';
import { VideoStage } from './VideoStage';
import { ZipList } from './ZipList';
import { ReviewDoorProvider } from './review-door';
import { FigFileStage } from './FigFileStage';
import { ViewerCanvas, type ViewerTool } from './ViewerCanvas';
import { ViewerShell, ViewerTools } from './ViewerShell';
import { ViewerStatePanel, type ViewerCanvasState } from './ViewerStatePanel';
import { ZoomControls } from './ZoomControls';
import { clampZoom, fitZoom, stepZoom } from './viewer-geometry';
import { ViewerIcon } from './viewer-icons';
import './viewer.css';
import './viewer-versions.css';

export interface FileViewerProps {
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly fileId: string;
  /** Opened from a deliverable version: the decision buttons follow the deliverable's approvals. */
  readonly deliverableVersionId?: string;
  /** A thread to open straight away (`?thread=` from a notification or email). */
  readonly initialThreadId?: string;
  readonly client?: ApiClient;
  /** The API origin the manifest's paths hang off; the browser's own by default. */
  readonly apiBase?: string;
  /**
   * R4 slice 8. `portal`: the client's viewer — the client's routes under `/portal`, no audience
   * switch, comments-only rail. `studio` (default): the team's viewer.
   */
  readonly door?: ReviewDoor;
  /**
   * R4 slice 8 (V-45). A team member previewing the portal viewer: the team's own routes, read as
   * the client reads them — client-visible threads only, nothing can be written or decided.
   */
  readonly previewAsClient?: boolean;
  /** The delivery team's name for the portal composer's "who will see this" line. */
  readonly teamName?: string;
  /** Where Back goes; the project page by default. */
  readonly backHref?: string;
  /** Shown above the comments in the rail (the portal's decision card). */
  readonly railTop?: ReactNode;
  /** A line above the toolbar, told how many team-only threads a client preview hides. */
  readonly renderBanner?: (hiddenTeamThreads: number) => ReactNode;
  /** Replaces the studio `AppShell` (the portal shell). */
  readonly renderShell?: (header: ViewerHeader, body: ReactNode) => ReactNode;
  /** R4 slice 11. Opens another file of the chain (a new version); a full page load by default. */
  readonly onOpenFile?: (href: string) => void;
}

/** The header parts the viewer hands to its shell. */
export interface ViewerHeader {
  readonly eyebrow: string;
  readonly title: string;
  readonly titleMeta: ReactNode;
  readonly actions: ReactNode;
  readonly topBar: ReactNode;
}

/** How often the open viewer re-reads the threads (no realtime topic yet). */
export const THREAD_POLL_MS = 10_000;
/** How often a file still being checked or prepared asks again. */
export const PENDING_POLL_MS = 5_000;

/** Image types every browser draws from the original, so the viewer need not wait for a preview. */
const BROWSER_IMAGES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export type StageKind =
  | 'image'
  | 'pdf'
  | 'video'
  | 'audio'
  | 'office_docx'
  | 'office_pptx'
  | 'office_xlsx'
  | 'zip'
  | 'fig'
  | 'text'
  | 'desktop'
  | 'unsupported'
  | 'none';

/** The stages that draw on the zoomable canvas (pins, boxes, drawings). */
export function isCanvasStage(stage: StageKind): stage is 'image' | 'pdf' {
  return stage === 'image' || stage === 'pdf';
}

/**
 * What the stage shows for this manifest: an image (PSD's flattened copy, an EPS's embedded
 * preview), a PDF, a video or audio player, an Office file, a ZIP list, the "no preview" card for
 * a file nothing in the browser can show, or a state card (checking, preparing, failed, blocked).
 */
export function stageFor(manifest: FilePreviewManifest): {
  readonly stage: StageKind;
  readonly state: ViewerCanvasState | null;
  readonly src: string | null;
} {
  const scan = manifest.version?.scanStatus;
  if (scan === 'blocked') return { stage: 'none', state: 'blocked', src: null };
  // Peter, 2026-11-01: "the preview taking too much time". A photo the browser draws itself is
  // shown from the original at once; the lighter preview takes over when the job has made it.
  if (
    manifest.status === 'pending' &&
    manifest.kind === 'image' &&
    manifest.originalUrl?.includes('inline=1') &&
    BROWSER_IMAGES.has(manifest.version?.mimeType ?? '')
  ) {
    return { stage: 'image', state: null, src: manifest.originalUrl };
  }
  if (manifest.status === 'pending') {
    return {
      stage: 'none',
      state: scan === 'pending_scan' || !manifest.originalUrl ? 'checking' : 'preparing',
      src: null,
    };
  }
  if (manifest.status === 'failed') return { stage: 'none', state: 'failed', src: null };
  if (manifest.kind === 'pdf' && manifest.originalUrl) {
    return { stage: 'pdf', state: null, src: manifest.originalUrl };
  }
  if (manifest.kind === 'image' || manifest.kind === 'svg' || manifest.kind === 'psd') {
    const page = previewPages(manifest)[0];
    const src = page?.url ?? (manifest.kind === 'image' ? manifest.originalUrl : null);
    if (src) return { stage: 'image', state: null, src };
  }
  if (
    (manifest.kind === 'video' || manifest.kind === 'audio') &&
    manifest.originalUrl &&
    manifest.status === 'ready'
  ) {
    return { stage: manifest.kind, state: null, src: manifest.originalUrl };
  }
  if (
    (manifest.kind === 'office_docx' ||
      manifest.kind === 'office_pptx' ||
      manifest.kind === 'office_xlsx') &&
    manifest.originalUrl
  ) {
    return { stage: manifest.kind, state: null, src: manifest.originalUrl };
  }
  if (manifest.kind === 'zip' && manifest.zip) return { stage: 'zip', state: null, src: null };
  // FIGMA item 10: a `.fig` file — the picture saved inside it and its pages and frames.
  if (manifest.kind === 'fig') {
    const page = previewPages(manifest)[0];
    if (page || manifest.fig) return { stage: 'fig', state: null, src: page?.url ?? null };
  }
  // Peter, 2026-11-09 (item 8): source code, CSV, Markdown, HTML and DXF are drawn from the
  // original's text; an IFC model (text too) and DWG / SketchUp / Revit get the desktop card.
  const name = manifest.file.name;
  const mimeType = manifest.version?.mimeType ?? null;
  if (manifest.kind === 'text' && manifest.originalUrl) {
    return textViewFor(name, mimeType)
      ? { stage: 'text', state: null, src: manifest.originalUrl }
      : { stage: 'desktop', state: null, src: manifest.originalUrl };
  }
  if (manifest.kind === 'unsupported' && !manifest.embeddedPreview && manifest.originalUrl) {
    const format = desktopFormatFor(name, mimeType);
    if (format !== 'eps' && format !== 'other') {
      return { stage: 'desktop', state: null, src: manifest.originalUrl };
    }
  }
  if (manifest.kind === 'unsupported') {
    // An EPS with a small picture saved inside: that picture, labelled as such.
    const page = manifest.embeddedPreview ? previewPages(manifest)[0] : undefined;
    if (page) return { stage: 'image', state: null, src: page.url };
    if (manifest.originalUrl) return { stage: 'unsupported', state: null, src: null };
  }
  return { stage: 'none', state: 'unsupported', src: null };
}

/**
 * R4 slice 11 — the threads of the version on screen. A comment carried to a newer version is a
 * copy with the same number, so the rail lists this version's threads only (and the older
 * version's when it is opened). Threads with no version (none today) stay listed.
 */
export function threadsForVersion(
  threads: readonly ReviewThread[],
  fileVersionId: string | null,
): readonly ReviewThread[] {
  if (fileVersionId === null) return threads;
  return threads.filter(
    (thread) => thread.fileVersionId === null || thread.fileVersionId === fileVersionId,
  );
}

/** A comment placed on a moment of a video / audio file or on a spreadsheet cell. */
type FormatDraft =
  | { readonly kind: 'time'; readonly timeMs: number }
  | { readonly kind: 'cell'; readonly cell: CellRef };

/**
 * R4 slice 8 — what a client preview shows of the team's thread list: client-visible threads only,
 * and nothing on them that would let the previewing team member act for the client.
 */
export function threadsAsClientSees(threads: readonly ReviewThread[]): readonly ReviewThread[] {
  return threads
    .filter((thread) => thread.audience === 'client_visible')
    .map((thread) => ({
      ...thread,
      canResolve: false,
      canMove: false,
      comments: thread.comments.map((comment) => ({
        ...comment,
        canEdit: false,
        canDelete: false,
      })),
    }));
}

/** The threads anchored on what the stage shows: this version, this page, a pin, box or drawing. */
export function threadsOnStage(
  threads: readonly ReviewThread[],
  fileVersionId: string | null,
  pageNo: number | null,
): readonly ReviewThread[] {
  return threads.filter(
    (thread) =>
      (thread.anchorKind === 'pin' ||
        thread.anchorKind === 'box' ||
        thread.anchorKind === 'draw') &&
      (fileVersionId === null || thread.fileVersionId === fileVersionId) &&
      (pageNo === null || (thread.pageNo ?? 1) === pageNo),
  );
}

/**
 * UX-1 (live UX test 69836a13, C-P1-4): a file that passed TManage's checks but no virus scanner
 * wears the same "Checked" label the Files lists use (with "not virus-scanned" written out for a
 * client), so the list and the viewer never disagree and nobody is told a file is unsafe.
 */
function scanBadge(manifest: FilePreviewManifest, t: ReturnType<typeof useT>, forClient: boolean) {
  const scan = manifest.version?.scanStatus;
  if (!scan) return null;
  if (scan === 'not_scanned') return <CheckedLabel withNote={forClient} />;
  return <Badge>{t(`Viewer.scan.${scan}`)}</Badge>;
}

/**
 * **R4 proofing viewer** (Figma batch A V-01 – V-06 and batch B V-10 – V-15).
 *
 * Opens one file — an image (with SVG / HEIC / TIFF previews) or a PDF — in a zoomable stage with
 * numbered pins and boxes, and the thread rail beside it. Every byte comes from the API origin with
 * the session cookie; nothing is shown that the download door would not serve. A file that has no
 * preview says why (checking, preparing, failed, blocked, no preview for this type) and keeps
 * Download original and general comments.
 *
 * Pins and boxes are stored relative to the artwork and never mirrored: the Arabic screen mirrors
 * the chrome (nav, rail, toolbar) and shows the artwork and its pins exactly as the English one.
 */
export function FileViewer({
  organizationSlug,
  organizationName,
  fileId,
  deliverableVersionId,
  initialThreadId,
  client,
  apiBase,
  door = 'studio',
  previewAsClient = false,
  teamName,
  backHref: backHrefProp,
  railTop,
  renderBanner,
  renderShell,
  onOpenFile,
}: FileViewerProps) {
  const t = useT();
  const describeError = useDescribeApiError();
  const locale = useActiveLocale();
  const direction = localeDirection(locale);
  const api = client ?? browserApiClient();
  const base = apiBase ?? apiBaseUrl();
  const queryClient = useQueryClient();
  // The routes the calls go through: a team member previewing the portal uses the team's own.
  const apiDoor: ReviewDoor = door === 'portal' && !previewAsClient ? 'portal' : 'studio';

  const manifestKey = filePreviewQueryKey(apiDoor, organizationSlug, fileId, deliverableVersionId);
  const manifestQuery = useQuery({
    queryKey: manifestKey,
    queryFn: () =>
      getFilePreviewManifest(api, organizationSlug, fileId, {
        door: apiDoor,
        ...(deliverableVersionId ? { deliverableVersionId } : {}),
      }),
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? PENDING_POLL_MS : false),
  });
  const manifestData = manifestQuery.data;
  // A client preview reads the team's manifest but may write nothing on it.
  const manifest = useMemo(
    () =>
      manifestData && previewAsClient
        ? {
            ...manifestData,
            capabilities: {
              ...manifestData.capabilities,
              canComment: false,
              canDraw: false,
              canResolve: false,
              canDecide: false,
              canUploadVersion: false,
              canRetry: false,
              canDelete: false,
            },
          }
        : manifestData,
    [manifestData, previewAsClient],
  );

  const threadsKey = ['review-threads', apiDoor, organizationSlug, fileId];
  const threadsQuery = useQuery({
    queryKey: threadsKey,
    queryFn: () => listReviewThreads(api, organizationSlug, fileId, { status: 'all' }, apiDoor),
    enabled: manifest !== undefined,
    refetchInterval: THREAD_POLL_MS,
  });
  const allThreads = useMemo(() => threadsQuery.data?.threads ?? [], [threadsQuery.data]);
  const chainThreads = useMemo(
    () => (previewAsClient ? threadsAsClientSees(allThreads) : allThreads),
    [allThreads, previewAsClient],
  );
  const onScreenVersionId = manifest?.version?.fileVersionId ?? null;
  const threads = useMemo(
    () => threadsForVersion(chainThreads, onScreenVersionId),
    [chainThreads, onScreenVersionId],
  );
  const hiddenTeamThreads =
    threadsForVersion(allThreads, onScreenVersionId).length - threads.length;

  // R4 slice 11 — each version's review state and decisions; the team's version notes.
  const decisionsKey = ['file-review-decisions', apiDoor, organizationSlug, fileId];
  const decisionsQuery = useQuery({
    queryKey: decisionsKey,
    queryFn: () => getFileReviewDecisions(api, organizationSlug, fileId, apiDoor),
    enabled: manifest !== undefined,
    retry: false,
  });
  const notesQuery = useQuery({
    queryKey: ['attachment-history', organizationSlug, fileId],
    queryFn: () => getAttachmentHistory(api, organizationSlug, fileId),
    enabled: manifest !== undefined && apiDoor === 'studio' && !previewAsClient,
    retry: false,
  });
  const notes = useMemo(() => {
    const map = new Map<string, string>();
    for (const version of notesQuery.data?.versions ?? []) {
      if (version.note) map.set(version.fileAssetId, version.note);
    }
    return map;
  }, [notesQuery.data]);
  const [compareWith, setCompareWith] = useState<{ left: string; right: string } | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [railTab, setRailTab] = useState<PanelTab | null>(null);
  const [formatDraft, setFormatDraft] = useState<FormatDraft | null>(null);

  const [tool, setTool] = useState<ViewerTool>('select');
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(initialThreadId ?? null);
  const [draft, setDraft] = useState<ViewerDraft | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [available, setAvailable] = useState<{ width: number; height: number } | null>(null);
  const [zoomChoice, setZoomChoice] = useState<number | 'fit'>('fit');
  const [pageNo, setPageNo] = useState(1);
  const [stageError, setStageError] = useState(false);
  const [strokes, setStrokes] = useState<readonly DrawStroke[]>([]);
  const [drawSettings, setDrawSettings] = useState<DrawSettings>({
    tool: 'pen',
    color: DEFAULT_DRAW_COLOUR,
    width: DEFAULT_DRAW_WIDTH,
  });
  const [drawLimit, setDrawLimit] = useState(false);

  const plan = manifest ? stageFor(manifest) : null;
  const isPdf = plan?.stage === 'pdf';
  const absolute = useCallback((path: string) => `${base}${path}`, [base]);
  const pdf = usePdfDocument(isPdf && plan?.src ? absolute(plan.src) : null);
  const pageCount = isPdf && pdf.status === 'ready' ? pdf.doc.numPages : (manifest?.pages ?? 1);
  const fitMode = isPdf ? 'width' : 'contain';
  const fitted = natural && available ? fitZoom(natural, available, fitMode) : 1;
  const zoom = zoomChoice === 'fit' ? fitted : clampZoom(zoomChoice);

  const invalidateThreads = useCallback(
    () => queryClient.invalidateQueries({ queryKey: threadsKey }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient, apiDoor, organizationSlug, fileId],
  );

  // Opening a thread (from the rail or a link) brings its page onto the stage.
  useEffect(() => {
    if (!selectedThreadId) return;
    const thread = threads.find((item) => item.id === selectedThreadId);
    if (thread?.pageNo && thread.pageNo !== pageNo && isPdf) setPageNo(thread.pageNo);
    // Page follows the selection only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedThreadId, threads, isPdf]);

  useEffect(() => {
    if (tool === 'select') setDraft(null);
    // Leaving the Draw tool drops the drawing that was not posted.
    if (tool !== 'draw') {
      setStrokes([]);
      setDrawLimit(false);
    }
  }, [tool]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && draft) setDraft(null);
      // Ctrl / ⌘ + Z takes back the last stroke while drawing (not while typing the comment).
      if (
        tool === 'draw' &&
        !draft &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'z'
      ) {
        event.preventDefault();
        setStrokes((current) => current.slice(0, -1));
        setDrawLimit(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft, tool]);

  const create = useMutation({
    mutationFn: (
      input: ComposerSubmit & {
        readonly draft: ViewerDraft | null;
        readonly format?: FormatDraft | null;
      },
    ) => {
      const placed = input.format;
      const anchor = placed
        ? placed.kind === 'time'
          ? { anchorKind: 'time' as const, anchor: { timeMs: placed.timeMs } }
          : { anchorKind: 'cell' as const, anchor: placed.cell }
        : input.draft
          ? input.draft.kind === 'box'
            ? { anchorKind: 'box' as const, anchor: input.draft.box }
            : input.draft.kind === 'draw'
              ? { anchorKind: 'draw' as const, anchor: toDrawAnchorInput(input.draft.strokes) }
              : { anchorKind: 'pin' as const, anchor: input.draft.point }
          : { anchorKind: 'none' as const, anchor: null };
      return createReviewThread(
        api,
        organizationSlug,
        fileId,
        {
          ...(manifest?.version ? { versionId: manifest.version.fileVersionId } : {}),
          ...anchor,
          pageNo: input.draft?.pageNo ?? null,
          // A client's comment is always seen by the team (the API refuses anything else).
          audience: apiDoor === 'portal' ? 'client_visible' : input.audience,
          body: input.body,
          mentions: input.mentions,
        },
        apiDoor,
      );
    },
    onSuccess: async (thread) => {
      setDraft(null);
      setFormatDraft(null);
      setStrokes([]);
      setTool('select');
      setSelectedThreadId(thread.id);
      await invalidateThreads();
    },
  });

  const move = useMutation({
    mutationFn: (input: { thread: ReviewThread; x: number; y: number }) =>
      moveReviewThread(
        api,
        organizationSlug,
        input.thread.id,
        {
          ...(manifest?.version ? { versionId: manifest.version.fileVersionId } : {}),
          anchor: { x: input.x, y: input.y },
          pageNo: input.thread.pageNo,
        },
        apiDoor,
      ),
    onSettled: () => invalidateThreads(),
  });

  const retry = useMutation({
    mutationFn: () => retryFilePreview(api, organizationSlug, fileId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: manifestKey }),
  });

  const decide = useMutation({
    mutationFn: (input: { decision: FileReviewDecision; note: string | null }) =>
      recordFileReviewDecision(
        api,
        organizationSlug,
        fileId,
        { decision: input.decision, ...(input.note ? { note: input.note } : {}) },
        apiDoor,
      ),
    onSuccess: (view) => queryClient.setQueryData(decisionsKey, view),
  });

  const downloadHref =
    manifest?.capabilities.canDownload && manifest.originalUrl
      ? absolute(
          `/v1/organizations/${encodeURIComponent(organizationSlug)}${apiDoor === 'portal' ? '/portal' : ''}/files/${encodeURIComponent(fileId)}/content`,
        )
      : null;

  const backHref =
    backHrefProp ??
    (manifest
      ? `/${organizationSlug}/projects/${encodeURIComponent(manifest.file.projectId)}`
      : `/${organizationSlug}`);
  const portalLook = door === 'portal';

  // FIX5 item 5 (B-N5): Delete, for the uploader, a project manager or the owner/admin. The file
  // is gone for everyone at once, so the viewer goes back to Files; the toast's Undo restores it.
  const filesHref = `/${organizationSlug}/files`;
  const fileDelete = useDeleteFile({
    api,
    organizationSlug,
    onDeleted: () => {
      void queryClient.invalidateQueries({ queryKey: ['project-files', organizationSlug] });
      (onOpenFile ?? ((href: string) => window.location.assign(href)))(filesHref);
    },
    onRestored: () => {
      void queryClient.invalidateQueries({ queryKey: ['project-files', organizationSlug] });
    },
  });
  const canDelete = !portalLook && manifest?.capabilities.canDelete === true;
  // UX-1: "Share" opens the share-with-client dialog (it was a grey button with no reason).
  const [sharing, setSharing] = useState(false);

  const currentVersion = manifest?.versions.versions.find(
    (version) => version.fileAssetId === manifest.file.id,
  );

  const header: ViewerHeader = {
    eyebrow: t('Viewer.eyebrow'),
    title: manifest?.file.name ?? t('Viewer.loadingTitle'),
    titleMeta: manifest ? (
      <span className="tm-viewer-head__badges">
        {currentVersion ? (
          <Badge mono>
            {t('Viewer.version.short').replace('{no}', String(currentVersion.versionNo))}
          </Badge>
        ) : null}
        {scanBadge(manifest, t, portalLook)}
      </span>
    ) : null,
    actions: (
      <span className="tm-viewer-head__actions">
        {portalLook || !manifest ? null : (
          <HelpTip tip={t('Viewer.shareTip')}>
            <button
              type="button"
              className="tm-button tm-button--ink tm-button--default"
              onClick={() => setSharing(true)}
            >
              {t('Viewer.shareWithClient')}
            </button>
          </HelpTip>
        )}
        {downloadHref ? (
          <a className="tm-button tm-button--outline tm-button--default" href={downloadHref}>
            <ViewerIcon name="download" />
            {t('Viewer.download')}
          </a>
        ) : null}
        {canDelete && manifest ? (
          <button
            type="button"
            className="tm-button tm-button--outline tm-button--default"
            onClick={() => fileDelete.ask({ id: manifest.file.id, name: manifest.file.name })}
          >
            {t('FileDelete.action')}
          </button>
        ) : null}
        {fileDelete.dialog}
        {sharing && manifest ? (
          <ShareFileDialog
            api={api}
            organizationSlug={organizationSlug}
            file={manifest.file}
            fromDeliverable={deliverableVersionId !== undefined}
            onClose={() => setSharing(false)}
          />
        ) : null}
      </span>
    ),
    topBar: (
      <Link className="tm-viewer-back" href={backHref}>
        <ViewerIcon name="back" className="tm-viewer-icon--flip" />
        {t('Viewer.back')}
      </Link>
    ),
  };

  let body;
  if (manifestQuery.isPending) {
    body = (
      <LoadingRegion label={t('Viewer.loading')}>
        <Skeleton height="480px" />
      </LoadingRegion>
    );
  } else if (manifestQuery.isError || !manifest || !plan) {
    const missing =
      manifestQuery.error instanceof ApiRequestError && manifestQuery.error.status === 404;
    body = missing ? (
      <InlineAlert tone="neutral" title={t('Viewer.unavailableTitle')} live>
        {t('Viewer.unavailableBody')}
      </InlineAlert>
    ) : (
      <InlineAlert tone="danger" title={t('Viewer.loadError')} live>
        {describeError(manifestQuery.error)}
      </InlineAlert>
    );
  } else {
    const caps = manifest.capabilities;
    const onCanvas = isCanvasStage(plan.stage);
    const stageReady = plan.stage === 'image' || (plan.stage === 'pdf' && pdf.status !== 'error');
    const canvasState: ViewerCanvasState | null =
      plan.state ??
      (stageError || (plan.stage === 'pdf' && pdf.status === 'error') ? 'failed' : null);
    const openOnScreen = threads.filter((thread) => thread.status === 'open');
    const downloadOriginal = downloadHref
      ? () => {
          window.location.assign(downloadHref);
        }
      : undefined;
    const startUpload = caps.canUploadVersion ? () => setUploadOpen(true) : undefined;
    const formatComposer =
      formatDraft && caps.canComment ? (
        <div
          className="tm-viewer-popover tm-viewer-popover--docked"
          dir={direction}
          role="dialog"
          aria-label={t('Viewer.composer.newTitle')}
        >
          <div className="tm-viewer-popover__head">
            <span className="tm-viewer-card-pin" data-state="draft" aria-hidden="true">
              {threads.reduce((max, thread) => Math.max(max, thread.number), 0) + 1}
            </span>
            <span className="tm-viewer-popover__title">{t('Viewer.composer.newTitle')}</span>
            <button
              type="button"
              className="tm-viewer-round tm-viewer-round--small"
              aria-label={t('Viewer.composer.close')}
              onClick={() => setFormatDraft(null)}
            >
              <ViewerIcon name="close" />
            </button>
          </div>
          <ThreadComposer
            api={api}
            organizationSlug={organizationSlug}
            projectId={manifest.file.projectId}
            label={t('Viewer.composer.newLabel')}
            submitLabel={t('Viewer.composer.post')}
            pendingLabel={t('Viewer.composer.posting')}
            audience={portalLook ? 'client_visible' : 'internal'}
            canChooseAudience={!portalLook}
            pending={create.isPending}
            focusOnOpen
            error={
              create.isError ? (
                <InlineAlert tone="danger" title={t('Viewer.composer.postError')} live>
                  {describeError(create.error)}
                </InlineAlert>
              ) : null
            }
            onSubmit={(input) => create.mutate({ ...input, draft: null, format: formatDraft })}
            onCancel={() => setFormatDraft(null)}
          />
        </div>
      ) : null;
    const commentAt = caps.canComment
      ? (timeMs: number) => {
          create.reset();
          setSelectedThreadId(null);
          setFormatDraft({ kind: 'time', timeMs });
        }
      : undefined;
    const pagePins = (page: number) => (
      <PinLayer
        threads={threadsOnStage(threads, manifest.version?.fileVersionId ?? null, page)}
        selectedThreadId={selectedThreadId}
        draft={null}
        draftNumber={0}
        sketchBox={null}
        allowMove={false}
        onSelect={setSelectedThreadId}
        onMove={() => undefined}
      />
    );
    const formatStage =
      plan.stage === 'video' && plan.src ? (
        manifest.media?.codecNotice ? (
          <MediaCodecNotice
            kind="video"
            media={manifest.media}
            durationMs={manifest.durationMs}
            sizeBytes={manifest.version?.sizeBytes ?? null}
            {...(downloadOriginal ? { onDownload: downloadOriginal } : {})}
            {...(startUpload ? { onUploadVersion: startUpload } : {})}
          />
        ) : (
          <VideoStage
            src={absolute(plan.src)}
            media={manifest.media}
            durationMs={manifest.durationMs}
            sizeBytes={manifest.version?.sizeBytes ?? null}
            threads={threads}
            fileVersionId={manifest.version?.fileVersionId ?? null}
            selectedThreadId={selectedThreadId}
            onSelectThread={setSelectedThreadId}
            {...(commentAt ? { onCommentAt: commentAt } : {})}
            {...(downloadOriginal ? { onDownload: downloadOriginal } : {})}
            {...(startUpload ? { onUploadVersion: startUpload } : {})}
          />
        )
      ) : plan.stage === 'audio' && plan.src ? (
        <AudioStage
          src={absolute(plan.src)}
          fileName={manifest.file.name}
          mimeType={manifest.version?.mimeType ?? null}
          media={manifest.media}
          durationMs={manifest.durationMs}
          sizeBytes={manifest.version?.sizeBytes ?? null}
          threads={threads}
          fileVersionId={manifest.version?.fileVersionId ?? null}
          selectedThreadId={selectedThreadId}
          onSelectThread={setSelectedThreadId}
          {...(commentAt ? { onCommentAt: commentAt } : {})}
          {...(downloadOriginal ? { onDownload: downloadOriginal } : {})}
          {...(startUpload ? { onUploadVersion: startUpload } : {})}
        />
      ) : plan.stage === 'office_docx' ? (
        <OfficeDocxStage
          src={plan.src ? absolute(plan.src) : null}
          office={manifest.office}
          threads={threads}
          selectedThreadId={selectedThreadId}
          onPageChange={setPageNo}
          renderPageOverlay={pagePins}
          {...(downloadOriginal ? { onDownload: downloadOriginal } : {})}
        />
      ) : plan.stage === 'office_pptx' ? (
        <OfficePptxStage
          src={plan.src ? absolute(plan.src) : null}
          office={manifest.office}
          threads={threads}
          selectedThreadId={selectedThreadId}
          onSlideChange={setPageNo}
          renderSlideOverlay={pagePins}
          {...(downloadOriginal ? { onDownload: downloadOriginal } : {})}
        />
      ) : plan.stage === 'office_xlsx' ? (
        <OfficeXlsxStage
          src={plan.src ? absolute(plan.src) : null}
          office={manifest.office}
          threads={threads}
          selectedThreadId={selectedThreadId}
          onSelectThread={setSelectedThreadId}
          draftCell={formatDraft?.kind === 'cell' ? formatDraft.cell : null}
          {...(caps.canComment
            ? {
                onCommentCell: (cell: CellRef) => {
                  create.reset();
                  setSelectedThreadId(null);
                  setFormatDraft({ kind: 'cell', cell });
                },
              }
            : {})}
          {...(downloadOriginal ? { onDownload: downloadOriginal } : {})}
        />
      ) : plan.stage === 'text' ? (
        <TextFileStage
          src={plan.src ? absolute(plan.src) : null}
          fileName={manifest.file.name}
          mimeType={manifest.version?.mimeType ?? null}
          view={
            textViewFor(manifest.file.name, manifest.version?.mimeType ?? null) ?? {
              view: 'code',
              language: 'plain',
            }
          }
          onDownload={downloadOriginal}
        />
      ) : plan.stage === 'desktop' ? (
        <DesktopFileStage
          src={plan.src ? absolute(plan.src) : null}
          fileName={manifest.file.name}
          mimeType={manifest.version?.mimeType ?? null}
          sizeBytes={manifest.version?.sizeBytes ?? null}
          onDownload={downloadOriginal}
        />
      ) : plan.stage === 'fig' ? (
        <FigFileStage
          organizationSlug={organizationSlug}
          fileAssetId={fileId}
          projectId={manifest.file.projectId}
          fileName={manifest.file.name}
          picture={plan.src ? absolute(plan.src) : null}
          fig={manifest.fig}
          door={apiDoor}
          canAttach={caps.canUploadVersion}
          client={api}
          onDownload={downloadOriginal}
        />
      ) : plan.stage === 'zip' && manifest.zip ? (
        <ZipList zip={manifest.zip} sizeBytes={manifest.version?.sizeBytes ?? null} />
      ) : plan.stage === 'unsupported' ? (
        <UnsupportedStage
          fileName={manifest.file.name}
          mimeType={manifest.version?.mimeType ?? null}
          sizeBytes={manifest.version?.sizeBytes ?? null}
          reason={unsupportedReasonFor(manifest.version?.mimeType ?? null)}
          {...(downloadOriginal ? { onDownload: downloadOriginal } : {})}
        />
      ) : null;
    const comparing =
      compareWith &&
      manifest.versions.versions.some((v) => v.fileAssetId === compareWith.left) &&
      manifest.versions.versions.some((v) => v.fileAssetId === compareWith.right)
        ? compareWith
        : null;
    const stagePage = isPdf ? pageNo : null;
    const onStage = threadsOnStage(threads, manifest.version?.fileVersionId ?? null, stagePage);
    const nextNumber = threads.reduce((max, thread) => Math.max(max, thread.number), 0) + 1;
    const openByPage = new Map<number, number>();
    for (const thread of threads) {
      if (thread.status === 'open' && thread.pageNo) {
        openByPage.set(thread.pageNo, (openByPage.get(thread.pageNo) ?? 0) + 1);
      }
    }
    const open = threads.filter((thread) => thread.status === 'open').length;

    const popover =
      draft && caps.canComment ? (
        <div
          className="tm-viewer-popover"
          dir={direction}
          role="dialog"
          aria-label={t('Viewer.composer.newTitle')}
        >
          <div className="tm-viewer-popover__head">
            <span className="tm-viewer-card-pin" data-state="draft" aria-hidden="true">
              {nextNumber}
            </span>
            <span className="tm-viewer-popover__title">{t('Viewer.composer.newTitle')}</span>
            <button
              type="button"
              className="tm-viewer-round tm-viewer-round--small"
              aria-label={t('Viewer.composer.close')}
              onClick={() => setDraft(null)}
            >
              <ViewerIcon name="close" />
            </button>
          </div>
          <ThreadComposer
            api={api}
            organizationSlug={organizationSlug}
            projectId={manifest.file.projectId}
            label={t('Viewer.composer.newLabel')}
            submitLabel={t('Viewer.composer.post')}
            pendingLabel={t('Viewer.composer.posting')}
            audience={portalLook ? 'client_visible' : 'internal'}
            canChooseAudience={!portalLook}
            pending={create.isPending}
            focusOnOpen
            error={
              create.isError ? (
                <InlineAlert tone="danger" title={t('Viewer.composer.postError')} live>
                  {describeError(create.error)}
                </InlineAlert>
              ) : null
            }
            onSubmit={(input) => create.mutate({ ...input, draft })}
            onCancel={() => setDraft(null)}
          />
        </div>
      ) : null;

    const stage = comparing ? (
      <CompareStage
        api={api}
        organizationSlug={organizationSlug}
        door={apiDoor}
        apiBase={base}
        versions={manifest.versions.versions}
        threads={chainThreads}
        review={decisionsQuery.data}
        leftId={comparing.left}
        rightId={comparing.right}
        selectedThreadId={selectedThreadId}
        onSelectThread={setSelectedThreadId}
        onPick={(side, picked) =>
          setCompareWith((current) => (current ? { ...current, [side]: picked } : current))
        }
        onExit={() => setCompareWith(null)}
      />
    ) : canvasState === null && formatStage ? (
      <div className="tm-viewer-format-stage">
        {formatStage}
        {formatComposer}
      </div>
    ) : canvasState !== null || !stageReady ? (
      <ViewerStatePanel
        state={canvasState ?? 'unsupported'}
        downloadHref={downloadHref}
        canComment={caps.canComment}
        {...(caps.canRetry && canvasState === 'failed' && !stageError
          ? { onRetry: () => retry.mutate(), retrying: retry.isPending }
          : {})}
      />
    ) : (
      <ViewerCanvas
        natural={natural}
        zoom={zoom}
        tool={caps.canComment ? tool : 'select'}
        threads={onStage}
        selectedThreadId={selectedThreadId}
        draft={draft}
        draftNumber={nextNumber}
        pageNo={stagePage}
        onDraft={(next) => {
          create.reset();
          setSelectedThreadId(null);
          setDraft(next);
        }}
        onSelect={(threadId) => {
          setDraft(null);
          setSelectedThreadId(threadId);
        }}
        onMove={(thread, point) => move.mutate({ thread, x: point.x, y: point.y })}
        onAvailableSize={setAvailable}
        onZoomStep={(direction) => setZoomChoice(stepZoom(zoom, direction))}
        popover={popover}
        drawing={{
          strokes,
          settings: drawSettings,
          onStroke: (stroke) => {
            setDrawLimit(false);
            setStrokes((current) => [...current, stroke]);
          },
          onLimit: () => setDrawLimit(true),
          toolbar: (
            <DrawToolbar
              settings={drawSettings}
              onSettings={setDrawSettings}
              canUndo={strokes.length > 0}
              onUndo={() => {
                setDrawLimit(false);
                setStrokes((current) => current.slice(0, -1));
              }}
              canFinish={strokes.length > 0}
              onDone={() => {
                create.reset();
                setSelectedThreadId(null);
                setDraft({
                  kind: 'draw',
                  strokes,
                  bbox: strokesBBox(strokes),
                  pageNo: stagePage,
                });
              }}
              limitReached={drawLimit}
            />
          ),
        }}
        overlay={
          manifest.embeddedPreview && plan.stage === 'image' ? (
            <EmbeddedPreviewChip />
          ) : isPdf ? (
            <span className="tm-viewer-stage__chip">
              {t('Viewer.page.of')
                .replace('{page}', String(pageNo))
                .replace('{count}', String(pageCount))}
            </span>
          ) : null
        }
      >
        {plan.stage === 'image' && plan.src ? (
          <ImageStage
            src={absolute(plan.src)}
            alt={manifest.file.name}
            onNaturalSize={setNatural}
            onError={() => setStageError(true)}
          />
        ) : null}
        {plan.stage === 'pdf' && pdf.status === 'ready' ? (
          <PdfStage
            doc={pdf.doc}
            pageNo={pageNo}
            zoom={zoom}
            label={t('Viewer.page.label')
              .replace('{page}', String(pageNo))
              .replace('{name}', manifest.file.name)}
            onNaturalSize={setNatural}
          />
        ) : null}
        {plan.stage === 'pdf' && pdf.status === 'loading' ? (
          <span className="tm-viewer-art__loading">{t('Viewer.page.loading')}</span>
        ) : null}
      </ViewerCanvas>
    );

    const banner = renderBanner ? renderBanner(hiddenTeamThreads) : null;
    const stateNotice =
      canvasState === 'checking' ? (
        <InlineAlert tone="warning">{t('Viewer.notice.checking')}</InlineAlert>
      ) : canvasState === 'blocked' ? (
        <InlineAlert tone="danger">{t('Viewer.notice.blocked')}</InlineAlert>
      ) : null;
    const formatNotice =
      canvasState === null && manifest.kind === 'psd' && plan.stage === 'image' ? (
        <PsdNotice approximate={manifest.psd?.approximate ?? false} />
      ) : canvasState === null && manifest.embeddedPreview && plan.stage === 'image' ? (
        <EmbeddedPreviewNotice />
      ) : null;
    const notice =
      banner || stateNotice || formatNotice ? (
        <>
          {banner}
          {stateNotice}
          {formatNotice}
        </>
      ) : null;

    const uploadDialog = uploadOpen ? (
      <UploadVersionDialog
        api={api}
        organizationSlug={organizationSlug}
        manifest={manifest}
        openThreads={openOnScreen}
        onClose={() => setUploadOpen(false)}
        onUploaded={(newFileId) => {
          setUploadOpen(false);
          setRailTab('versions');
          void queryClient.invalidateQueries({ queryKey: ['file-preview'] });
          void queryClient.invalidateQueries({ queryKey: ['file-review-decisions'] });
          (onOpenFile ?? ((href: string) => window.location.assign(href)))(
            portalLook
              ? `/${organizationSlug}/portal/files/${encodeURIComponent(newFileId)}`
              : `/${organizationSlug}/files/${encodeURIComponent(newFileId)}`,
          );
        }}
      />
    ) : null;

    body = (
      <>
        <ViewerShell
          toolbar={
            <>
              <ViewerTools
                tool={tool}
                onTool={(next) => {
                  setTool(next);
                  if (next !== 'select') setSelectedThreadId(null);
                }}
                canComment={caps.canComment && canvasState === null && onCanvas && !comparing}
              />
              <span className="tm-viewer-counter tm-viewer-counter--toolbar">
                {t('Viewer.counter')
                  .replace('{open}', String(open))
                  .replace('{resolved}', String(threads.length - open))}
              </span>
              {canvasState === null && onCanvas && !comparing ? (
                <ZoomControls
                  zoom={zoom}
                  fitted={zoomChoice === 'fit'}
                  fitMode={fitMode}
                  onStep={(direction) => setZoomChoice(stepZoom(zoom, direction))}
                  onFit={() => setZoomChoice('fit')}
                />
              ) : null}
            </>
          }
          notice={notice}
          stage={stage}
          strip={
            isPdf && pdf.status === 'ready' && canvasState === null && !comparing ? (
              <PageStrip
                pageCount={pageCount}
                pageNo={pageNo}
                onPage={(next) => {
                  setDraft(null);
                  setStrokes([]);
                  setNatural(null);
                  setPageNo(Math.min(pageCount, Math.max(1, next)));
                }}
                openByPage={openByPage}
                renderThumb={(page) => <PdfThumb doc={pdf.doc} pageNo={page} />}
              />
            ) : null
          }
          footnote={
            tool !== 'select' && caps.canComment && canvasState === null ? (
              <span aria-live="polite">
                {tool === 'pin'
                  ? t('Viewer.tool.pinHint')
                  : tool === 'box'
                    ? t('Viewer.tool.boxHint')
                    : t('Viewer.tool.drawHint')}
              </span>
            ) : null
          }
          rail={
            <RailStack top={railTop}>
              <ThreadPanel
                api={api}
                organizationSlug={organizationSlug}
                manifest={manifest}
                threads={threads}
                threadsLoading={threadsQuery.isPending}
                threadsError={threadsQuery.isError ? threadsQuery.error : null}
                selectedThreadId={selectedThreadId}
                pageNo={stagePage}
                stageAcceptsPins={canvasState === null && onCanvas && !comparing}
                naturalSize={isPdf ? null : natural}
                onSelect={setSelectedThreadId}
                onStartPin={() => {
                  setSelectedThreadId(null);
                  setTool('pin');
                }}
                onCreateGeneral={(input) => create.mutate({ ...input, draft: null })}
                creatingGeneral={create.isPending}
                createGeneralError={!draft && create.isError ? create.error : null}
                onChanged={invalidateThreads}
                requestedTab={railTab}
                versionsContent={
                  <VersionsTab
                    organizationSlug={organizationSlug}
                    manifest={manifest}
                    review={decisionsQuery.data}
                    reviewError={decisionsQuery.isError}
                    notes={notes}
                    {...(portalLook
                      ? {
                          hrefFor: (id: string) =>
                            `/${organizationSlug}/portal/files/${encodeURIComponent(id)}`,
                        }
                      : {})}
                    {...(startUpload ? { onUpload: startUpload } : {})}
                    onCompare={(older) => {
                      const here = manifest.versions.versions.find(
                        (v) => v.fileAssetId === manifest.file.id,
                      );
                      const other = manifest.versions.versions.find((v) => v.fileAssetId === older);
                      const olderFirst = !here || !other || other.versionNo < here.versionNo;
                      setDraft(null);
                      setFormatDraft(null);
                      setCompareWith(
                        olderFirst
                          ? { left: older, right: manifest.file.id }
                          : { left: manifest.file.id, right: older },
                      );
                    }}
                  />
                }
                commentsFooter={
                  railTop && manifest.decisionContext.kind === 'deliverable' ? null : (
                    <DecisionRail
                      organizationSlug={organizationSlug}
                      manifest={manifest}
                      review={decisionsQuery.data}
                      pending={decide.isPending}
                      error={decide.isError ? describeError(decide.error) : null}
                      onDecide={(decision, note) => decide.mutate({ decision, note })}
                      {...(startUpload ? { onUploadNext: startUpload } : {})}
                    />
                  )
                }
                layersContent={
                  manifest.psd && manifest.psd.layers.length > 0 ? (
                    <PsdLayersPanel psd={manifest.psd} />
                  ) : null
                }
              />
            </RailStack>
          }
        />
        {uploadDialog}
      </>
    );
  }

  const content = (
    <ReviewDoorProvider
      value={{ door: portalLook ? 'portal' : 'studio', teamName: teamName ?? null }}
    >
      {body}
    </ReviewDoorProvider>
  );
  if (renderShell) return <>{renderShell(header, content)}</>;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title={header.title}
      eyebrow={header.eyebrow}
      titleMeta={header.titleMeta}
      actions={header.actions}
      topBar={header.topBar}
    >
      {content}
    </AppShell>
  );
}

/** The rail with the portal's decision card above the comments; the bare rail otherwise. */
function RailStack({ top, children }: { readonly top?: ReactNode; readonly children: ReactNode }) {
  if (!top) return <>{children}</>;
  return (
    <div className="tm-viewer-rail-stack">
      {top}
      {children}
    </div>
  );
}
