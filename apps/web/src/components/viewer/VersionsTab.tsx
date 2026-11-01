'use client';

import Link from 'next/link';
import { Badge, Button, InlineAlert, StateCapsule } from '@tmanage/ui';
import type { FilePreviewManifest } from '../../lib/api/file-preview';
import {
  capsuleStateFor,
  type FileReviewDecisions,
  type FileVersionReview,
} from '../../lib/api/file-review-decisions';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { useT } from '../../lib/i18n/use-t';
import { ViewerIcon } from './viewer-icons';
import './viewer-versions.css';

export interface VersionsTabProps {
  readonly organizationSlug: string;
  readonly manifest: FilePreviewManifest;
  /** The review state per version; `undefined` while it loads. */
  readonly review: FileReviewDecisions | undefined;
  readonly reviewError?: boolean;
  /** The version notes ("What changed in v3?") the team wrote, by file id. */
  readonly notes?: ReadonlyMap<string, string>;
  /** Where a version opens; the studio viewer by default. */
  readonly hrefFor?: (fileAssetId: string) => string;
  /** Shown to the team when the file takes new versions. */
  readonly onUpload?: () => void;
  /** Compare this (older) version with the one on screen. */
  readonly onCompare?: (fileAssetId: string) => void;
}

/** The review facts of one version, or a quiet default while they load. */
export function reviewOf(
  review: FileReviewDecisions | undefined,
  fileAssetId: string,
): FileVersionReview | null {
  return review?.versions?.find((entry) => entry.fileAssetId === fileAssetId) ?? null;
}

/**
 * R4 slice 11 — the Versions tab (Figma V-30 `461:21546`): "Upload new version" for the team, then
 * every version newest first as a card — `v3` with a Current badge and its state capsule (In review
 * · Approved · Changes requested · Shared), the day, the note, who decided and when, the open /
 * resolved / carried counts, and "Viewing now", or "Compare with v3" and "Open" on older ones.
 */
export function VersionsTab({
  organizationSlug,
  manifest,
  review,
  reviewError = false,
  notes,
  hrefFor,
  onUpload,
  onCompare,
}: VersionsTabProps) {
  const t = useT();
  const format = useDisplayFormatters();
  const versions = manifest.versions.versions;
  const here = versions.find((version) => version.fileAssetId === manifest.file.id);
  const href =
    hrefFor ??
    ((fileAssetId: string) => `/${organizationSlug}/files/${encodeURIComponent(fileAssetId)}`);

  return (
    <div className="tm-versions-tab">
      {onUpload ? (
        <>
          <Button
            type="button"
            tone="ink"
            size="accessible"
            className="tm-versions-tab__upload"
            onClick={onUpload}
          >
            <ViewerIcon name="plus" />
            {t('ViewerVersions.upload')}
          </Button>
          <p className="tm-viewer-rail__note">{t('ViewerVersions.helper')}</p>
        </>
      ) : null}
      {reviewError ? (
        <InlineAlert tone="neutral">{t('ViewerVersions.loadError')}</InlineAlert>
      ) : null}
      <ol className="tm-versions-tab__list">
        {versions.map((version, index) => {
          const isHere = version.fileAssetId === manifest.file.id;
          const facts = reviewOf(review, version.fileAssetId);
          const previous = versions[index + 1];
          const note = notes?.get(version.fileAssetId) ?? null;
          const decision = facts?.latestDecision ?? null;
          const who = decision?.decidedBy.displayName ?? t('ViewerVersions.someone');
          const counts = facts
            ? facts.carriedThreads > 0 && previous
              ? t('ViewerVersions.countsCarried')
                  .replace('{open}', String(facts.openThreads))
                  .replace('{carried}', String(facts.carriedThreads))
                  .replace('{from}', String(previous.versionNo))
              : t('ViewerVersions.counts')
                  .replace('{open}', String(facts.openThreads))
                  .replace('{resolved}', String(facts.resolvedThreads))
            : null;
          return (
            <li
              key={version.fileAssetId}
              className="tm-versions-card"
              data-here={isHere ? 'true' : undefined}
              aria-current={isHere ? 'page' : undefined}
            >
              <div className="tm-versions-card__head">
                <span className="tm-versions-card__no">
                  {t('Viewer.version.short').replace('{no}', String(version.versionNo))}
                </span>
                {version.current ? <Badge mono>{t('ViewerVersions.current')}</Badge> : null}
                {facts ? (
                  <StateCapsule
                    state={capsuleStateFor(facts.state)}
                    className="tm-versions-card__state"
                  >
                    {t(`ViewerVersions.state.${facts.state}`)}
                  </StateCapsule>
                ) : null}
              </div>
              <p className="tm-versions-card__meta">
                <span dir="auto">{version.fileName}</span>
                {' · '}
                {format.day(version.createdAt)}
              </p>
              {note ? (
                <p className="tm-versions-card__note" dir="auto">
                  {note}
                </p>
              ) : null}
              {decision ? (
                <p className="tm-versions-card__decision">
                  {t(
                    decision.decision === 'approved'
                      ? 'ViewerVersions.approvedLine'
                      : 'ViewerVersions.changesLine',
                  )
                    .replace('{name}', who)
                    .replace('{date}', format.day(decision.createdAt))}
                </p>
              ) : null}
              <div className="tm-versions-card__foot">
                {counts ? (
                  <span
                    className="tm-versions-card__counts"
                    data-open={facts && facts.openThreads > 0 ? 'true' : undefined}
                  >
                    {counts}
                  </span>
                ) : (
                  <span />
                )}
                {isHere ? (
                  <span className="tm-versions-card__here">{t('ViewerVersions.viewingNow')}</span>
                ) : (
                  <span className="tm-versions-card__actions">
                    {onCompare && here ? (
                      <button
                        type="button"
                        className="tm-versions-card__compare"
                        onClick={() => onCompare(version.fileAssetId)}
                      >
                        {t('ViewerVersions.compareWith').replace('{no}', String(here.versionNo))}
                      </button>
                    ) : null}
                    <Link
                      className="tm-button tm-button--outline tm-button--default"
                      href={href(version.fileAssetId)}
                      aria-label={t('ViewerVersions.openLabel').replace(
                        '{no}',
                        String(version.versionNo),
                      )}
                    >
                      {t('ViewerVersions.open')}
                    </Link>
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
