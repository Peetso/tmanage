'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { apiBaseUrl, browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { ApiRequestError } from '../../lib/api/errors';
import {
  createFigmaFrameThread,
  figmaProblem,
  figmaSnapshotUrl,
  getFigmaLink,
  listFigmaFrameThreads,
  refreshFigmaSnapshots,
  type FigmaFrame,
  type FigmaLink,
} from '../../lib/api/figma';
import { sortThreadsForPanel, type ReviewDoor, type ReviewThread } from '../../lib/api/review';
import { localeDirection } from '../../lib/i18n/direction';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import { usePortalPreview } from '../../lib/portal-preview';
import { usePortalNames } from '../../lib/use-organization-names';
import {
  DEFAULT_DRAW_COLOUR,
  DEFAULT_DRAW_WIDTH,
  strokesBBox,
  toDrawAnchorInput,
  type DrawStroke,
} from '../../lib/review-anchors';
import type { DrawSettings } from './DrawLayer';
import { DrawToolbar } from './DrawToolbar';
import { THREAD_POLL_MS, PENDING_POLL_MS, threadsOnStage } from './FileViewer';
import { FIGMA_PROBLEM_KEYS } from './FigmaLinks';
import { ImageStage } from './ImageStage';
import type { ViewerDraft } from './PinLayer';
import { ThreadCard } from './ThreadCard';
import { ThreadComposer, type ComposerSubmit } from './ThreadComposer';
import { ThreadDetail } from './ThreadPanel';
import { ViewerCanvas, type ViewerTool } from './ViewerCanvas';
import { ViewerShell, ViewerTools } from './ViewerShell';
import { ZoomControls } from './ZoomControls';
import { ReviewDoorProvider } from './review-door';
import { clampZoom, fitZoom, stepZoom } from './viewer-geometry';
import { ViewerIcon } from './viewer-icons';
import './viewer.css';
import './viewer-versions.css';
import './figma-stage.css';

export type FigmaMode = 'snapshot' | 'live';
export type FigmaRailFilter = 'frame' | 'all' | 'resolved';

const FILTER_KEYS: Record<FigmaRailFilter, MessageKey> = {
  frame: 'Figma.viewer.filter.frame',
  all: 'Figma.viewer.filter.all',
  resolved: 'Figma.viewer.filter.resolved',
};

export interface FigmaStageProps {
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly linkId: string;
  /** A thread to open straight away (`?thread=`). */
  readonly initialThreadId?: string;
  readonly client?: ApiClient;
  readonly apiBase?: string;
  /** `portal`: the client's door — snapshots only, comments seen by the team. */
  readonly door?: ReviewDoor;
  /** A team member previewing the portal: the team's routes, nothing written. */
  readonly previewAsClient?: boolean;
  readonly teamName?: string;
  readonly backHref?: string;
  /** Replaces the studio `AppShell` (the portal shell). */
  readonly renderShell?: (header: FigmaHeader, body: ReactNode) => ReactNode;
}

export interface FigmaHeader {
  readonly title: string;
  readonly titleMeta: ReactNode;
  readonly actions: ReactNode;
  readonly topBar: ReactNode;
}

/** The frame a thread sits on, for the "All frames" list. */
export function frameOfThread(
  frames: readonly FigmaFrame[],
  thread: ReviewThread,
): FigmaFrame | null {
  return frames.find((frame) => frame.id === thread.subjectId) ?? null;
}

/**
 * "Frame changed since this comment": the frame was captured again at another size after the
 * comment was placed, so its pin may no longer point at the same thing.
 */
export function frameChangedSince(frame: FigmaFrame | null, thread: ReviewThread): boolean {
  if (!frame || !frame.sizeChanged || !frame.capturedAt) return false;
  return Date.parse(frame.capturedAt) > Date.parse(thread.createdAt);
}

/** The rail's list for a filter: this frame's open threads, every frame's, or the resolved. */
export function threadsForRail(
  byFrame: ReadonlyMap<string, readonly ReviewThread[]>,
  frameId: string | null,
  filter: FigmaRailFilter,
): readonly ReviewThread[] {
  if (filter === 'frame') {
    return sortThreadsForPanel((frameId ? byFrame.get(frameId) : undefined) ?? []);
  }
  const every = [...byFrame.values()].flat();
  return sortThreadsForPanel(
    filter === 'resolved' ? every.filter((thread) => thread.status === 'resolved') : every,
  );
}

/** Whether the link still has frames whose snapshot is being made. */
export function hasPendingSnapshots(link: FigmaLink | undefined): boolean {
  return link?.frames.some((frame) => frame.snapshotStatus === 'pending') ?? false;
}

/**
 * **V-23 — a Figma link in the proofing viewer** (Figma `466:29543` snapshot, `466:29836` live).
 *
 * Snapshot mode shows the PNG TManage took of the chosen frame, with the numbered pins, boxes and
 * drawings placed on it, the frame strip (name, open comments, "Frame changed"), and the comments
 * rail filtered to this frame, every frame, or the resolved ones. Live mode embeds Figma's own
 * viewer for people whose Figma account can open the file; pins work in Snapshot mode only.
 * Clients see snapshots only, and the file's Figma address is never sent to them.
 */
export function FigmaStage({
  organizationSlug,
  organizationName,
  linkId,
  initialThreadId,
  client,
  apiBase,
  door = 'studio',
  previewAsClient = false,
  teamName,
  backHref: backHrefProp,
  renderShell,
}: FigmaStageProps) {
  const t = useT();
  const describeError = useDescribeApiError();
  const format = useDisplayFormatters();
  const direction = localeDirection(useActiveLocale());
  const api = client ?? browserApiClient();
  const base = apiBase ?? apiBaseUrl();
  const queryClient = useQueryClient();
  const railId = useId();
  const apiDoor: ReviewDoor = door === 'portal' && !previewAsClient ? 'portal' : 'studio';
  const portalLook = door === 'portal';

  const linkKey = ['figma-link', apiDoor, organizationSlug, linkId];
  const linkQuery = useQuery({
    queryKey: linkKey,
    queryFn: () => getFigmaLink(api, organizationSlug, linkId, apiDoor),
    refetchInterval: (query) => (hasPendingSnapshots(query.state.data) ? PENDING_POLL_MS : false),
  });
  const link = linkQuery.data;
  const caps = useMemo(
    () =>
      link && (previewAsClient || portalLook)
        ? {
            ...link.capabilities,
            canComment: previewAsClient ? false : link.capabilities.canComment,
            canRefresh: false,
            canRemove: false,
            canLive: false,
          }
        : link?.capabilities,
    [link, previewAsClient, portalLook],
  );

  const [frameId, setFrameId] = useState<string | null>(null);
  const frames = useMemo(() => link?.frames ?? [], [link]);
  const frame = frames.find((item) => item.id === frameId) ?? frames[0] ?? null;
  const [mode, setMode] = useState<FigmaMode>('snapshot');
  const [filter, setFilter] = useState<FigmaRailFilter>('frame');
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(initialThreadId ?? null);
  const [tool, setTool] = useState<ViewerTool>('select');
  const [draft, setDraft] = useState<ViewerDraft | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [available, setAvailable] = useState<{ width: number; height: number } | null>(null);
  const [zoomChoice, setZoomChoice] = useState<number | 'fit'>('fit');
  const [stageError, setStageError] = useState(false);
  const [writingGeneral, setWritingGeneral] = useState(false);
  const [strokes, setStrokes] = useState<readonly DrawStroke[]>([]);
  const [drawSettings, setDrawSettings] = useState<DrawSettings>({
    tool: 'pen',
    color: DEFAULT_DRAW_COLOUR,
    width: DEFAULT_DRAW_WIDTH,
  });
  const [drawLimit, setDrawLimit] = useState(false);

  // Every frame's threads: the one on screen is polled; the others are read for "All frames".
  const threadQueries = useQueries({
    queries: frames.map((item) => ({
      queryKey: ['figma-frame-threads', apiDoor, organizationSlug, item.id],
      queryFn: () =>
        listFigmaFrameThreads(api, organizationSlug, item.id, { status: 'all' as const }, apiDoor),
      enabled: item.id === frame?.id || filter !== 'frame' || selectedThreadId !== null,
      refetchInterval: item.id === frame?.id ? THREAD_POLL_MS : false,
    })),
  });
  const byFrame = useMemo(() => {
    const map = new Map<string, readonly ReviewThread[]>();
    frames.forEach((item, index) => {
      const data = threadQueries[index]?.data;
      if (data) {
        map.set(
          item.id,
          previewAsClient
            ? data.threads.filter((thread) => thread.audience === 'client_visible')
            : data.threads,
        );
      }
    });
    return map;
  }, [frames, threadQueries, previewAsClient]);
  const frameThreads = useMemo(
    () => (frame ? (byFrame.get(frame.id) ?? []) : []),
    [byFrame, frame],
  );
  const currentIndex = frame ? frames.findIndex((item) => item.id === frame.id) : -1;
  const threadsState = currentIndex >= 0 ? threadQueries[currentIndex] : undefined;

  // A thread opened from a link: bring its frame onto the stage.
  useEffect(() => {
    if (!selectedThreadId) return;
    for (const [id, threads] of byFrame) {
      if (threads.some((thread) => thread.id === selectedThreadId) && id !== frame?.id) {
        setFrameId(id);
        return;
      }
    }
    // Follow the selection only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedThreadId, byFrame]);

  useEffect(() => {
    setNatural(null);
    setStageError(false);
    setDraft(null);
    setStrokes([]);
    setZoomChoice('fit');
  }, [frame?.id]);

  useEffect(() => {
    if (tool === 'select') setDraft(null);
    if (tool !== 'draw') {
      setStrokes([]);
      setDrawLimit(false);
    }
  }, [tool]);

  useEffect(() => {
    if (mode === 'live') {
      setTool('select');
      setDraft(null);
    }
  }, [mode]);

  const invalidateThreads = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['figma-frame-threads', apiDoor] }),
    [queryClient, apiDoor],
  );

  const create = useMutation({
    mutationFn: (input: ComposerSubmit & { readonly draft: ViewerDraft | null }) => {
      if (!frame) throw new Error('no frame');
      const anchor = input.draft
        ? input.draft.kind === 'box'
          ? { anchorKind: 'box' as const, anchor: input.draft.box }
          : input.draft.kind === 'draw'
            ? { anchorKind: 'draw' as const, anchor: toDrawAnchorInput(input.draft.strokes) }
            : { anchorKind: 'pin' as const, anchor: input.draft.point }
        : { anchorKind: 'none' as const, anchor: null };
      return createFigmaFrameThread(
        api,
        organizationSlug,
        frame.id,
        {
          ...anchor,
          audience: apiDoor === 'portal' ? 'client_visible' : input.audience,
          body: input.body,
          mentions: input.mentions,
        },
        apiDoor,
      );
    },
    onSuccess: async (thread) => {
      setDraft(null);
      setStrokes([]);
      setTool('select');
      setWritingGeneral(false);
      setSelectedThreadId(thread.id);
      await invalidateThreads();
    },
  });

  const refresh = useMutation({
    mutationFn: () => refreshFigmaSnapshots(api, organizationSlug, linkId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: linkKey }),
  });

  const fitted = natural && available ? fitZoom(natural, available, 'contain') : 1;
  const zoom = zoomChoice === 'fit' ? fitted : clampZoom(zoomChoice);
  const backHref =
    backHrefProp ??
    (link
      ? `/${organizationSlug}/projects/${encodeURIComponent(link.projectId)}`
      : `/${organizationSlug}`);
  const title = link?.fileName ?? t('Figma.viewer.untitled');
  const liveAllowed = Boolean(caps?.canLive && frame?.embedUrl);
  const showLive = mode === 'live' && liveAllowed;

  const header: FigmaHeader = {
    title,
    titleMeta: link ? (
      <span className="tm-viewer-head__badges">
        {frame && frames.length > 1 ? (
          <Badge mono>
            {t('Figma.viewer.framePill')
              .replace('{index}', String(currentIndex + 1))
              .replace('{count}', String(frames.length))}
          </Badge>
        ) : null}
        <StateCapsule state="neutral">{t('Figma.viewer.linked')}</StateCapsule>
      </span>
    ) : null,
    actions: (
      <span className="tm-viewer-head__actions">
        {link && caps?.canRefresh ? (
          <Button
            type="button"
            tone="outline"
            loading={refresh.isPending}
            loadingLabel={t('Figma.viewer.refreshing')}
            onClick={() => refresh.mutate()}
          >
            <ViewerIcon name="refresh" />
            {t('Figma.viewer.refresh')}
          </Button>
        ) : null}
        {link?.openUrl ? (
          <a
            className="tm-button tm-button--outline tm-button--default"
            href={link.openUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('Figma.viewer.open')}
          </a>
        ) : null}
        {portalLook ? null : (
          <button type="button" className="tm-viewer-share" disabled>
            {t('Viewer.share')}
          </button>
        )}
      </span>
    ),
    topBar: (
      <Link className="tm-viewer-back" href={backHref}>
        <ViewerIcon name="back" className="tm-viewer-icon--flip" />
        {t('Viewer.back')}
      </Link>
    ),
  };

  let body: ReactNode;
  if (linkQuery.isPending) {
    body = (
      <LoadingRegion label={t('Figma.viewer.loading')}>
        <Skeleton height="480px" />
      </LoadingRegion>
    );
  } else if (linkQuery.isError || !link || !caps) {
    const missing = linkQuery.error instanceof ApiRequestError && linkQuery.error.status === 404;
    body = missing ? (
      <InlineAlert tone="neutral" title={t('Figma.viewer.unavailableTitle')} live>
        {t('Figma.viewer.unavailableBody')}
      </InlineAlert>
    ) : (
      <InlineAlert tone="danger" title={t('Figma.viewer.loadError')} live>
        {describeError(linkQuery.error)}
      </InlineAlert>
    );
  } else {
    const nextNumber = frameThreads.reduce((max, thread) => Math.max(max, thread.number), 0) + 1;
    const onStage = threadsOnStage(frameThreads, null, null);
    const open = frameThreads.filter((thread) => thread.status === 'open').length;
    const snapshotReady = frame?.snapshotStatus === 'ready' && frame.snapshotPath !== null;
    const onCanvas = !showLive && snapshotReady && !stageError;
    const canPin = caps.canComment && onCanvas;

    const composer = (onCancel: () => void, placed: ViewerDraft | null) => (
      <ThreadComposer
        api={api}
        organizationSlug={organizationSlug}
        projectId={link.projectId}
        label={t('Viewer.composer.newLabel')}
        submitLabel={t('Viewer.composer.post')}
        pendingLabel={t('Viewer.composer.posting')}
        audience={portalLook || link.audience === 'client_visible' ? 'client_visible' : 'internal'}
        canChooseAudience={!portalLook && link.audience === 'client_visible'}
        pending={create.isPending}
        focusOnOpen
        error={
          create.isError ? (
            <InlineAlert tone="danger" title={t('Viewer.composer.postError')} live>
              {describeError(create.error)}
            </InlineAlert>
          ) : null
        }
        onSubmit={(input) => create.mutate({ ...input, draft: placed })}
        onCancel={onCancel}
      />
    );

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
          {composer(() => setDraft(null), draft)}
        </div>
      ) : null;

    const stage = !frame ? (
      <div className="tm-figma-state">
        <p className="tm-figma-state__title">{t('Figma.viewer.noFrames')}</p>
      </div>
    ) : showLive && frame.embedUrl ? (
      <div className="tm-figma-live">
        <iframe
          className="tm-figma-live__frame"
          src={frame.embedUrl}
          title={t('Figma.viewer.liveTitle').replace('{name}', frame.name)}
          allowFullScreen
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        />
      </div>
    ) : !snapshotReady || stageError ? (
      <div className="tm-figma-state" role="status">
        <p className="tm-figma-state__title">
          {stageError || frame.snapshotStatus === 'failed'
            ? t('Figma.viewer.snapshotFailedTitle')
            : t('Figma.viewer.snapshotPendingTitle')}
        </p>
        <p className="tm-figma-state__body">
          {stageError || frame.snapshotStatus === 'failed'
            ? caps.canRefresh
              ? t('Figma.viewer.snapshotFailedBodyRefresh')
              : t('Figma.viewer.snapshotFailedBody')
            : t('Figma.viewer.snapshotPendingBody')}
        </p>
      </div>
    ) : (
      <ViewerCanvas
        natural={natural}
        zoom={zoom}
        tool={canPin ? tool : 'select'}
        threads={onStage}
        selectedThreadId={selectedThreadId}
        draft={draft}
        draftNumber={nextNumber}
        pageNo={null}
        onDraft={(next) => {
          create.reset();
          setSelectedThreadId(null);
          setDraft(next);
        }}
        onSelect={(threadId) => {
          setDraft(null);
          setSelectedThreadId(threadId);
        }}
        onMove={() => undefined}
        onAvailableSize={setAvailable}
        onZoomStep={(step) => setZoomChoice(stepZoom(zoom, step))}
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
                setDraft({ kind: 'draw', strokes, bbox: strokesBBox(strokes), pageNo: null });
              }}
              limitReached={drawLimit}
            />
          ),
        }}
        overlay={
          <span className="tm-viewer-stage__chip" dir="ltr">
            {frame.name} · {frame.width}×{frame.height}
          </span>
        }
      >
        <ImageStage
          src={figmaSnapshotUrl(base, organizationSlug, frame.snapshotPath!)}
          alt={frame.name}
          onNaturalSize={setNatural}
          onError={() => setStageError(true)}
        />
      </ViewerCanvas>
    );

    const subline = frame ? (
      <p className="tm-figma-subline">
        {frame.capturedAt
          ? t('Figma.viewer.takenAt').replace(
              '{when}',
              format.dateTime(frame.capturedAt, {
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              }),
            )
          : t('Figma.viewer.notTakenYet')}
        <span aria-hidden="true"> · </span>
        <span dir="ltr">
          {frame.name} · {frame.width}×{frame.height}
        </span>
      </p>
    ) : null;

    const notice = (
      <>
        {subline}
        {showLive ? <InlineAlert tone="neutral">{t('Figma.viewer.liveNotice')}</InlineAlert> : null}
        {refresh.isError ? (
          <InlineAlert tone="danger" title={t('Figma.viewer.refreshError')} live>
            {figmaProblem(refresh.error)
              ? t(FIGMA_PROBLEM_KEYS[figmaProblem(refresh.error)!].body)
              : describeError(refresh.error)}
          </InlineAlert>
        ) : refresh.isSuccess ? (
          <InlineAlert tone="neutral" live>
            {t('Figma.viewer.refreshQueued')}
          </InlineAlert>
        ) : null}
      </>
    );

    const modeToggle = liveAllowed ? (
      <div className="tm-figma-mode" role="group" aria-label={t('Figma.viewer.modeLabel')}>
        {(['live', 'snapshot'] as const).map((value) => (
          <button
            key={value}
            type="button"
            className="tm-figma-mode__option"
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
          >
            {t(value === 'live' ? 'Figma.viewer.mode.live' : 'Figma.viewer.mode.snapshot')}
          </button>
        ))}
      </div>
    ) : null;

    const strip =
      frames.length > 0 ? (
        <div className="tm-figma-strip" role="group" aria-label={t('Figma.viewer.framesLabel')}>
          {frames.map((item) => {
            const openCount =
              byFrame.get(item.id)?.filter((thread) => thread.status === 'open').length ??
              item.openThreads;
            return (
              <button
                key={item.id}
                type="button"
                className="tm-figma-strip__frame"
                aria-pressed={item.id === frame?.id}
                onClick={() => {
                  setSelectedThreadId(null);
                  setFrameId(item.id);
                }}
              >
                <span className="tm-figma-strip__name" dir="auto">
                  {item.name}
                </span>
                <span className="tm-figma-strip__meta">
                  {openCount > 0 ? (
                    <span
                      className="tm-figma-strip__count"
                      aria-label={t('Figma.viewer.openCount').replace('{count}', String(openCount))}
                    >
                      {openCount}
                    </span>
                  ) : null}
                  {item.sizeChanged ? (
                    <StateCapsule state="waiting">{t('Figma.viewer.frameChanged')}</StateCapsule>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null;

    const listed = threadsForRail(byFrame, frame?.id ?? null, filter);
    const selected = selectedThreadId
      ? ([...byFrame.values()].flat().find((thread) => thread.id === selectedThreadId) ?? null)
      : null;
    const everyThread = [...byFrame.values()].flat();
    const counts: Record<FigmaRailFilter, number> = {
      frame: frameThreads.length,
      all: everyThread.length,
      resolved: everyThread.filter((thread) => thread.status === 'resolved').length,
    };

    const rail = (
      <aside className="tm-viewer-rail" aria-label={t('Viewer.rail.label')}>
        <div className="tm-viewer-rail__handle" aria-hidden="true" />
        <div className="tm-viewer-rail__title-row">
          <h2 className="tm-viewer-rail__title">{t('Viewer.tab.comments')}</h2>
        </div>
        <div className="tm-viewer-rail__body">
          {selected ? (
            <ThreadDetail
              key={selected.id}
              api={api}
              organizationSlug={organizationSlug}
              projectId={link.projectId}
              thread={selected}
              canComment={caps.canComment}
              onBack={() => setSelectedThreadId(null)}
              onChanged={invalidateThreads}
            />
          ) : (
            <>
              <div className="tm-viewer-chips" role="group" aria-label={t('Viewer.filter.label')}>
                {(['frame', 'all', 'resolved'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="tm-viewer-chip"
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >
                    {t(FILTER_KEYS[value])}
                    <span className="tm-viewer-chip__count">{counts[value]}</span>
                  </button>
                ))}
              </div>
              {threadsState?.isError ? (
                <InlineAlert tone="danger" title={t('Viewer.threads.loadError')} live>
                  {describeError(threadsState.error)}
                </InlineAlert>
              ) : null}
              {threadsState?.isPending && filter === 'frame' ? (
                <p className="tm-viewer-rail__note">{t('Viewer.threads.loading')}</p>
              ) : listed.length === 0 ? (
                <div className="tm-viewer-empty">
                  <p className="tm-viewer-empty__title">{t('Viewer.threads.emptyTitle')}</p>
                  <p className="tm-viewer-rail__note">
                    {canPin ? t('Figma.viewer.emptyPins') : t('Viewer.threads.emptyBodyGeneral')}
                  </p>
                </div>
              ) : (
                <ul
                  className="tm-viewer-list"
                  role="listbox"
                  aria-label={t('Viewer.threads.label')}
                >
                  {listed.map((thread, index) => {
                    const on = frameOfThread(frames, thread);
                    const changed = frameChangedSince(on, thread);
                    return (
                      <ThreadCard
                        key={thread.id}
                        thread={thread}
                        selected={false}
                        optionId={`${railId}-thread-${index}`}
                        active={false}
                        onOpen={(id) => {
                          if (on) setFrameId(on.id);
                          setSelectedThreadId(id);
                        }}
                        extra={
                          filter !== 'frame' || changed ? (
                            <p className="tm-figma-card-extra">
                              {filter !== 'frame' && on ? (
                                <span className="tm-figma-card-extra__frame" dir="auto">
                                  {on.name}
                                </span>
                              ) : null}
                              {changed ? (
                                <span className="tm-figma-card-extra__changed">
                                  {t('Figma.viewer.changedSince')}
                                </span>
                              ) : null}
                            </p>
                          ) : null
                        }
                      />
                    );
                  })}
                </ul>
              )}
              {caps.canComment && frame ? (
                <div className="tm-viewer-rail__foot">
                  {writingGeneral ? (
                    composer(() => setWritingGeneral(false), null)
                  ) : (
                    <>
                      <p className="tm-viewer-rail__note">
                        {canPin ? t('Viewer.rail.hintPins') : t('Figma.viewer.hintSnapshot')}
                      </p>
                      <Button
                        type="button"
                        tone="ink"
                        size="accessible"
                        className="tm-viewer-rail__add"
                        onClick={() => {
                          create.reset();
                          if (canPin) {
                            setSelectedThreadId(null);
                            setTool('pin');
                          } else {
                            setWritingGeneral(true);
                          }
                        }}
                      >
                        <ViewerIcon name={canPin ? 'pin' : 'comment'} />
                        {t('Viewer.rail.addComment')}
                      </Button>
                    </>
                  )}
                </div>
              ) : null}
              {portalLook ? (
                <p className="tm-viewer-rail__note tm-viewer-rail__note--team">
                  {t('Viewer.portal.railNote').replace(
                    '{team}',
                    teamName || t('Viewer.portal.teamFallback'),
                  )}
                </p>
              ) : null}
            </>
          )}
        </div>
      </aside>
    );

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
              canComment={canPin}
            />
            {modeToggle}
            <span className="tm-viewer-counter tm-viewer-counter--toolbar">
              {t('Viewer.counter')
                .replace('{open}', String(open))
                .replace('{resolved}', String(frameThreads.length - open))}
            </span>
            {onCanvas ? (
              <ZoomControls
                zoom={zoom}
                fitted={zoomChoice === 'fit'}
                fitMode="contain"
                onStep={(step) => setZoomChoice(stepZoom(zoom, step))}
                onFit={() => setZoomChoice('fit')}
              />
            ) : null}
          </>
        }
        notice={notice}
        stage={stage}
        strip={strip}
        footnote={
          tool !== 'select' && canPin ? (
            <span aria-live="polite">
              {tool === 'pin'
                ? t('Viewer.tool.pinHint')
                : tool === 'box'
                  ? t('Viewer.tool.boxHint')
                  : t('Viewer.tool.drawHint')}
            </span>
          ) : null
        }
        rail={rail}
      />
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
      eyebrow={t('Figma.viewer.eyebrow')}
      titleMeta={header.titleMeta}
      actions={header.actions}
      topBar={header.topBar}
    >
      {content}
    </AppShell>
  );
}

export interface PortalFigmaStageProps {
  readonly organizationSlug: string;
  readonly linkId: string;
  readonly initialThreadId?: string;
  readonly clientName: string;
  readonly providerName: string;
  readonly client?: ApiClient;
  readonly apiBase?: string;
  readonly preview?: boolean;
}

/** V-23 in the client portal: snapshots and the comments the team shares with the client. */
export function PortalFigmaStage({
  organizationSlug,
  linkId,
  initialThreadId,
  clientName: passedClientName,
  providerName: passedProviderName,
  client,
  apiBase,
  preview: previewProp,
}: PortalFigmaStageProps) {
  const t = useT();
  const sessionPreview = usePortalPreview(organizationSlug);
  const preview = previewProp ?? sessionPreview;
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
  const backHref = `/${organizationSlug}/portal/files`;
  return (
    <FigmaStage
      organizationSlug={organizationSlug}
      organizationName={providerName}
      linkId={linkId}
      door="portal"
      previewAsClient={preview}
      teamName={providerName}
      backHref={backHref}
      {...(client ? { client } : {})}
      {...(apiBase ? { apiBase } : {})}
      {...(initialThreadId ? { initialThreadId } : {})}
      renderShell={(header, body) => (
        <ClientPortalShell
          organizationSlug={organizationSlug}
          clientName={clientName}
          providerName={providerName}
          activeNavigationId="files"
          title={header.title}
          eyebrow={
            <nav className="tm-viewer-crumbs" aria-label={t('Viewer.portal.breadcrumb')}>
              <Link href={backHref} className="tm-viewer-crumbs__link">
                {t('nav.files')}
              </Link>
              <span aria-hidden="true">›</span>
              <span>{header.title}</span>
            </nav>
          }
          description={header.titleMeta}
          headerAside={header.actions}
          {...(previewProp === undefined ? {} : { preview: previewProp })}
        >
          <div className="tm-viewer-portal">{body}</div>
        </ClientPortalShell>
      )}
    />
  );
}
