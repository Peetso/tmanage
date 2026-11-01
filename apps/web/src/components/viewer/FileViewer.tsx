'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { apiBaseUrl, browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { ApiRequestError } from '../../lib/api/errors';
import {
  getFilePreviewManifest,
  previewPages,
  retryFilePreview,
  type FilePreviewManifest,
} from '../../lib/api/file-preview';
import {
  createReviewThread,
  listReviewThreads,
  moveReviewThread,
  type ReviewThread,
} from '../../lib/api/review';
import { localeDirection } from '../../lib/i18n/direction';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useT } from '../../lib/i18n/use-t';
import { ImageStage } from './ImageStage';
import { PageStrip } from './PageStrip';
import { PdfStage, PdfThumb, usePdfDocument } from './PdfStage';
import type { ViewerDraft } from './PinLayer';
import { ThreadComposer, type ComposerSubmit } from './ThreadComposer';
import { ThreadPanel } from './ThreadPanel';
import { ViewerCanvas, type ViewerTool } from './ViewerCanvas';
import { ViewerShell, ViewerTools } from './ViewerShell';
import { ViewerStatePanel, type ViewerCanvasState } from './ViewerStatePanel';
import { ZoomControls } from './ZoomControls';
import { clampZoom, fitZoom, stepZoom } from './viewer-geometry';
import { ViewerIcon } from './viewer-icons';
import './viewer.css';

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
}

/** How often the open viewer re-reads the threads (no realtime topic yet). */
export const THREAD_POLL_MS = 10_000;
/** How often a file still being checked or prepared asks again. */
export const PENDING_POLL_MS = 5_000;

export type StageKind = 'image' | 'pdf' | 'none';

/** What the canvas shows for this manifest: an image, a PDF, or a state card. */
export function stageFor(manifest: FilePreviewManifest): {
  readonly stage: StageKind;
  readonly state: ViewerCanvasState | null;
  readonly src: string | null;
} {
  const scan = manifest.version?.scanStatus;
  if (scan === 'blocked') return { stage: 'none', state: 'blocked', src: null };
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
  if (manifest.kind === 'image' || manifest.kind === 'svg') {
    const page = previewPages(manifest)[0];
    const src = page?.url ?? (manifest.kind === 'image' ? manifest.originalUrl : null);
    if (src) return { stage: 'image', state: null, src };
  }
  return { stage: 'none', state: 'unsupported', src: null };
}

/** The threads anchored on what the stage shows: this version, this page, a pin or a box. */
export function threadsOnStage(
  threads: readonly ReviewThread[],
  fileVersionId: string | null,
  pageNo: number | null,
): readonly ReviewThread[] {
  return threads.filter(
    (thread) =>
      (thread.anchorKind === 'pin' || thread.anchorKind === 'box') &&
      (fileVersionId === null || thread.fileVersionId === fileVersionId) &&
      (pageNo === null || (thread.pageNo ?? 1) === pageNo),
  );
}

function scanBadge(manifest: FilePreviewManifest, t: ReturnType<typeof useT>) {
  const scan = manifest.version?.scanStatus;
  if (!scan) return null;
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
}: FileViewerProps) {
  const t = useT();
  const describeError = useDescribeApiError();
  const locale = useActiveLocale();
  const direction = localeDirection(locale);
  const api = client ?? browserApiClient();
  const base = apiBase ?? apiBaseUrl();
  const queryClient = useQueryClient();

  const manifestKey = ['file-preview', organizationSlug, fileId, deliverableVersionId ?? ''];
  const manifestQuery = useQuery({
    queryKey: manifestKey,
    queryFn: () =>
      getFilePreviewManifest(api, organizationSlug, fileId, {
        ...(deliverableVersionId ? { deliverableVersionId } : {}),
      }),
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? PENDING_POLL_MS : false),
  });
  const manifest = manifestQuery.data;

  const threadsKey = ['review-threads', organizationSlug, fileId];
  const threadsQuery = useQuery({
    queryKey: threadsKey,
    queryFn: () => listReviewThreads(api, organizationSlug, fileId, { status: 'all' }),
    enabled: manifest !== undefined,
    refetchInterval: THREAD_POLL_MS,
  });
  const threads = useMemo(() => threadsQuery.data?.threads ?? [], [threadsQuery.data]);

  const [tool, setTool] = useState<ViewerTool>('select');
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(initialThreadId ?? null);
  const [draft, setDraft] = useState<ViewerDraft | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [available, setAvailable] = useState<{ width: number; height: number } | null>(null);
  const [zoomChoice, setZoomChoice] = useState<number | 'fit'>('fit');
  const [pageNo, setPageNo] = useState(1);
  const [stageError, setStageError] = useState(false);

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
    [queryClient, organizationSlug, fileId],
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
  }, [tool]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && draft) setDraft(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft]);

  const create = useMutation({
    mutationFn: (input: ComposerSubmit & { readonly draft: ViewerDraft | null }) => {
      const anchor = input.draft
        ? input.draft.kind === 'box'
          ? { anchorKind: 'box' as const, anchor: input.draft.box }
          : { anchorKind: 'pin' as const, anchor: input.draft.point }
        : { anchorKind: 'none' as const, anchor: null };
      return createReviewThread(api, organizationSlug, fileId, {
        ...(manifest?.version ? { versionId: manifest.version.fileVersionId } : {}),
        ...anchor,
        pageNo: input.draft?.pageNo ?? null,
        audience: input.audience,
        body: input.body,
        mentions: input.mentions,
      });
    },
    onSuccess: async (thread) => {
      setDraft(null);
      setTool('select');
      setSelectedThreadId(thread.id);
      await invalidateThreads();
    },
  });

  const move = useMutation({
    mutationFn: (input: { thread: ReviewThread; x: number; y: number }) =>
      moveReviewThread(api, organizationSlug, input.thread.id, {
        ...(manifest?.version ? { versionId: manifest.version.fileVersionId } : {}),
        anchor: { x: input.x, y: input.y },
        pageNo: input.thread.pageNo,
      }),
    onSettled: () => invalidateThreads(),
  });

  const retry = useMutation({
    mutationFn: () => retryFilePreview(api, organizationSlug, fileId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: manifestKey }),
  });

  const downloadHref =
    manifest?.capabilities.canDownload && manifest.originalUrl
      ? absolute(
          `/v1/organizations/${encodeURIComponent(organizationSlug)}/files/${encodeURIComponent(fileId)}/content`,
        )
      : null;

  const backHref = manifest
    ? `/${organizationSlug}/projects/${encodeURIComponent(manifest.file.projectId)}`
    : `/${organizationSlug}`;

  const currentVersion = manifest?.versions.versions.find(
    (version) => version.fileAssetId === manifest.file.id,
  );

  const header = {
    eyebrow: t('Viewer.eyebrow'),
    title: manifest?.file.name ?? t('Viewer.loadingTitle'),
    titleMeta: manifest ? (
      <span className="tm-viewer-head__badges">
        {currentVersion ? (
          <Badge mono>
            {t('Viewer.version.short').replace('{no}', String(currentVersion.versionNo))}
          </Badge>
        ) : null}
        {scanBadge(manifest, t)}
      </span>
    ) : null,
    actions: (
      <span className="tm-viewer-head__actions">
        <button type="button" className="tm-viewer-share" disabled>
          {t('Viewer.share')}
        </button>
        {downloadHref ? (
          <a className="tm-button tm-button--outline tm-button--default" href={downloadHref}>
            <ViewerIcon name="download" />
            {t('Viewer.download')}
          </a>
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
    const stageReady = plan.stage === 'image' || (plan.stage === 'pdf' && pdf.status !== 'error');
    const canvasState: ViewerCanvasState | null =
      plan.state ??
      (stageError || (plan.stage === 'pdf' && pdf.status === 'error') ? 'failed' : null);
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
            audience="internal"
            canChooseAudience
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

    const stage =
      canvasState !== null || !stageReady ? (
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
          overlay={
            isPdf ? (
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

    const notice =
      canvasState === 'checking' ? (
        <InlineAlert tone="warning">{t('Viewer.notice.checking')}</InlineAlert>
      ) : canvasState === 'blocked' ? (
        <InlineAlert tone="danger">{t('Viewer.notice.blocked')}</InlineAlert>
      ) : null;

    body = (
      <ViewerShell
        toolbar={
          <>
            <ViewerTools
              tool={tool}
              onTool={(next) => {
                setTool(next);
                if (next !== 'select') setSelectedThreadId(null);
              }}
              canComment={caps.canComment && canvasState === null}
            />
            <span className="tm-viewer-counter tm-viewer-counter--toolbar">
              {t('Viewer.counter')
                .replace('{open}', String(open))
                .replace('{resolved}', String(threads.length - open))}
            </span>
            {canvasState === null ? (
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
          isPdf && pdf.status === 'ready' && canvasState === null ? (
            <PageStrip
              pageCount={pageCount}
              pageNo={pageNo}
              onPage={(next) => {
                setDraft(null);
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
              {tool === 'pin' ? t('Viewer.tool.pinHint') : t('Viewer.tool.boxHint')}
            </span>
          ) : null
        }
        rail={
          <ThreadPanel
            api={api}
            organizationSlug={organizationSlug}
            manifest={manifest}
            threads={threads}
            threadsLoading={threadsQuery.isPending}
            threadsError={threadsQuery.isError ? threadsQuery.error : null}
            selectedThreadId={selectedThreadId}
            pageNo={stagePage}
            stageAcceptsPins={canvasState === null}
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
          />
        }
      />
    );
  }

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
      {body}
    </AppShell>
  );
}
