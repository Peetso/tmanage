'use client';

import { useId, useState, type WheelEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, StateCapsule, Switch } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import {
  getFilePreviewManifest,
  previewPages,
  type FilePreviewManifest,
  type PreviewChainVersion,
  type PreviewDoor,
} from '../../lib/api/file-preview';
import { capsuleStateFor, type FileReviewDecisions } from '../../lib/api/file-review-decisions';
import type { ReviewThread } from '../../lib/api/review';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { useT } from '../../lib/i18n/use-t';
import { PinLayer } from './PinLayer';
import { reviewOf } from './VersionsTab';
import { clampZoom } from './viewer-geometry';
import './viewer-versions.css';

export type CompareMode = 'side' | 'overlay';

export interface CompareStageProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly door: PreviewDoor;
  /** The API origin the manifests' paths hang off. */
  readonly apiBase: string;
  /** The chain, newest first. */
  readonly versions: readonly PreviewChainVersion[];
  /** Every thread of the chain (each pane shows its own version's pins). */
  readonly threads: readonly ReviewThread[];
  readonly review: FileReviewDecisions | undefined;
  /** The older version (A, start side) and the newer one (B). */
  readonly leftId: string;
  readonly rightId: string;
  readonly onPick: (side: 'left' | 'right', fileAssetId: string) => void;
  readonly onSelectThread: (threadId: string) => void;
  readonly selectedThreadId: string | null;
  readonly onExit: () => void;
}

/** The picture a version shows in compare: its first preview page, or the image itself. */
export function comparePicture(manifest: FilePreviewManifest | undefined): string | null {
  if (!manifest || manifest.status !== 'ready') return null;
  const page = previewPages(manifest)[0];
  if (page) return page.url;
  return manifest.kind === 'image' ? manifest.originalUrl : null;
}

/** The pins a pane shows: the version's own pin / box / drawing threads on its first page. */
export function comparePins(
  threads: readonly ReviewThread[],
  manifest: FilePreviewManifest | undefined,
): readonly ReviewThread[] {
  const versionId = manifest?.version?.fileVersionId ?? null;
  if (!versionId) return [];
  return threads.filter(
    (thread) =>
      thread.fileVersionId === versionId &&
      (thread.anchorKind === 'pin' ||
        thread.anchorKind === 'box' ||
        thread.anchorKind === 'draw') &&
      (thread.pageNo ?? 1) === 1,
  );
}

/**
 * R4 slice 11 — compare two versions (Figma V-31: side by side `462:24047`, overlay `462:24395`,
 * phone swipe `462:26174`).
 *
 * The bar: Side by side · Overlay, "Comparing v2 with v3", Sync zoom and Exit compare. Side by
 * side: two panes, each with its version picker, its counts and its decision capsule, and its own
 * pins (never mirrored; the artwork is `dir="ltr"`); the newer pane has the strong border. Overlay:
 * the newer version over the older one with an onion-skin slider from "Only v2" to "Only v3".
 * On a phone one pane shows at a time, with A / B tabs. Ctrl / ⌘ + wheel zooms a pane; with Sync
 * zoom on, both.
 */
export function CompareStage({
  api,
  organizationSlug,
  door,
  apiBase,
  versions,
  threads,
  review,
  leftId,
  rightId,
  onPick,
  onSelectThread,
  selectedThreadId,
  onExit,
}: CompareStageProps) {
  const t = useT();
  const format = useDisplayFormatters();
  const id = useId();
  const [mode, setMode] = useState<CompareMode>('side');
  const [sync, setSync] = useState(true);
  const [zoom, setZoom] = useState<{ left: number; right: number }>({ left: 1, right: 1 });
  const [mix, setMix] = useState(50);
  const [phonePane, setPhonePane] = useState<'left' | 'right'>('right');

  const manifestFor = (fileAssetId: string) => ({
    queryKey: ['file-preview', door, organizationSlug, fileAssetId, ''],
    queryFn: () => getFilePreviewManifest(api, organizationSlug, fileAssetId, { door }),
  });
  const left = useQuery(manifestFor(leftId));
  const right = useQuery(manifestFor(rightId));

  const versionOf = (fileAssetId: string) =>
    versions.find((version) => version.fileAssetId === fileAssetId);
  const leftNo = versionOf(leftId)?.versionNo ?? 1;
  const rightNo = versionOf(rightId)?.versionNo ?? 1;
  const short = (no: number) => t('Viewer.version.short').replace('{no}', String(no));

  function onWheel(side: 'left' | 'right', event: WheelEvent) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const step = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    setZoom((current) => {
      const next = clampZoom(current[side] * step);
      return sync ? { left: next, right: next } : { ...current, [side]: next };
    });
  }

  function header(side: 'left' | 'right') {
    const fileAssetId = side === 'left' ? leftId : rightId;
    const facts = reviewOf(review, fileAssetId);
    return (
      <div className="tm-compare__pane-head">
        <label className="tm-compare__picker">
          <span className="tm-visually-hidden">
            {t(side === 'left' ? 'ViewerCompare.pickFirst' : 'ViewerCompare.pickSecond')}
          </span>
          <select
            value={fileAssetId}
            onChange={(event) => onPick(side, event.target.value)}
            className="tm-compare__select"
          >
            {versions.map((version) => (
              <option key={version.fileAssetId} value={version.fileAssetId}>
                {t('ViewerCompare.option')
                  .replace('{no}', short(version.versionNo))
                  .replace('{date}', format.day(version.createdAt))}
              </option>
            ))}
          </select>
        </label>
        {facts ? (
          <span className="tm-compare__counts">
            {t('ViewerCompare.open').replace('{open}', String(facts.openThreads))}
          </span>
        ) : null}
        {facts ? (
          <StateCapsule state={capsuleStateFor(facts.state)} className="tm-compare__capsule">
            {t(`ViewerVersions.state.${facts.state}`)}
          </StateCapsule>
        ) : null}
      </div>
    );
  }

  function art(side: 'left' | 'right', withPins: boolean) {
    const query = side === 'left' ? left : right;
    const picture = comparePicture(query.data);
    const no = side === 'left' ? leftNo : rightNo;
    if (query.isPending) {
      return <span className="tm-viewer-art__loading">{t('Viewer.loading')}</span>;
    }
    if (!picture) {
      return <p className="tm-compare__empty">{t('ViewerCompare.noPicture')}</p>;
    }
    return (
      <div
        className="tm-compare__art"
        dir="ltr"
        style={{ inlineSize: `${Math.round(zoom[side] * 100)}%` }}
      >
        <img
          className="tm-viewer-art__media"
          src={`${apiBase}${picture}`}
          alt={t('ViewerCompare.alt').replace('{no}', short(no))}
          crossOrigin="use-credentials"
          draggable={false}
        />
        {withPins ? (
          <PinLayer
            threads={comparePins(threads, query.data)}
            selectedThreadId={selectedThreadId}
            draft={null}
            draftNumber={0}
            sketchBox={null}
            allowMove={false}
            onSelect={onSelectThread}
            onMove={() => undefined}
          />
        ) : null}
      </div>
    );
  }

  return (
    <section className="tm-compare" aria-label={t('ViewerCompare.label')}>
      <div className="tm-compare__bar">
        <div className="tm-viewer-tools" role="group" aria-label={t('ViewerCompare.modeLabel')}>
          {(['side', 'overlay'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className="tm-viewer-tool"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {t(value === 'side' ? 'ViewerCompare.sideBySide' : 'ViewerCompare.overlay')}
            </button>
          ))}
        </div>
        <span className="tm-compare__caption">
          {t('ViewerCompare.comparing')
            .replace('{a}', short(leftNo))
            .replace('{b}', short(rightNo))}
        </span>
        <span className="tm-compare__spacer" />
        <Switch
          label={t('ViewerCompare.syncZoom')}
          checked={sync}
          onChange={(event) => setSync(event.target.checked)}
        />
        <Button type="button" tone="outline" size="accessible" onClick={onExit}>
          {t('ViewerCompare.exit')}
        </Button>
      </div>

      {mode === 'side' ? (
        <>
          <div className="tm-compare__tabs" role="tablist" aria-label={t('ViewerCompare.label')}>
            {(['left', 'right'] as const).map((side) => (
              <button
                key={side}
                type="button"
                role="tab"
                id={`${id}-tab-${side}`}
                aria-selected={phonePane === side}
                aria-controls={`${id}-pane-${side}`}
                className="tm-viewer-chip"
                onClick={() => setPhonePane(side)}
              >
                {t(side === 'left' ? 'ViewerCompare.tabA' : 'ViewerCompare.tabB').replace(
                  '{no}',
                  short(side === 'left' ? leftNo : rightNo),
                )}
              </button>
            ))}
          </div>
          <div className="tm-compare__panes">
            {(['left', 'right'] as const).map((side) => (
              <div
                key={side}
                id={`${id}-pane-${side}`}
                className="tm-compare__pane"
                data-side={side}
                data-phone-shown={phonePane === side ? 'true' : undefined}
              >
                {header(side)}
                <div
                  className="tm-compare__stage"
                  data-strong={side === 'right' ? 'true' : undefined}
                  onWheel={(event) => onWheel(side, event)}
                >
                  {art(side, true)}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="tm-compare__overlay">
          <div className="tm-compare__pane-heads">
            {header('left')}
            {header('right')}
          </div>
          <div className="tm-compare__stage" onWheel={(event) => onWheel('left', event)}>
            <div className="tm-compare__stack" dir="ltr">
              {art('left', false)}
              <div className="tm-compare__top" style={{ opacity: mix / 100 }}>
                {art('right', false)}
              </div>
            </div>
          </div>
          <div className="tm-compare__slider" dir="ltr">
            <span>{t('ViewerCompare.only').replace('{no}', short(leftNo))}</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={mix}
              aria-label={t('ViewerCompare.mixLabel')}
              aria-valuetext={`${mix}%`}
              onChange={(event) => setMix(Number(event.target.value))}
            />
            <span>{t('ViewerCompare.only').replace('{no}', short(rightNo))}</span>
            <span className="tm-compare__mix">{`${mix}%`}</span>
          </div>
        </div>
      )}
    </section>
  );
}
