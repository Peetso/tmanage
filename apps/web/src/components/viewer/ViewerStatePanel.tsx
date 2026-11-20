'use client';

import { Button, StateCapsule } from '@tmanage/ui';
import type { PreviewBlockedReason } from '../../lib/api/file-preview';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import { ViewerIcon } from './viewer-icons';

export type ViewerCanvasState = 'checking' | 'preparing' | 'failed' | 'blocked' | 'unsupported';

export interface ViewerStatePanelProps {
  readonly state: ViewerCanvasState;
  /** The original's download link, or `null` while it may not be downloaded. */
  readonly downloadHref: string | null;
  /** "Try again" (failed only, team only). */
  readonly onRetry?: () => void;
  readonly retrying?: boolean;
  /** Whether comments without a pin can still be left. */
  readonly canComment: boolean;
  /** QA-FIX S9. Why a blocked file was refused; the body names the real cause. */
  readonly blockedReason?: PreviewBlockedReason | null;
}

/**
 * QA-FIX S9: every refusal used to say "The virus check found a problem", also for a file the type
 * check refused before any scan. One sentence per cause; an unknown cause gets the neutral one.
 */
const BLOCKED_BODY: Record<PreviewBlockedReason | 'unknown', MessageKey> = {
  malware: 'Viewer.state.blockedBody',
  file_type: 'Viewer.state.blockedBodyFileType',
  content: 'Viewer.state.blockedBodyContent',
  damaged: 'Viewer.state.blockedBodyDamaged',
  unknown: 'Viewer.state.blockedBodyUnknown',
};

/**
 * V-05 — what the canvas says when there is no normal preview: checking (virus check), preparing,
 * failed (with "Try again" for the team), blocked, and no preview for this file type. Download
 * original stays on every card except blocked (QA-FIX S6: nothing can be done with a blocked file);
 * it is disabled, with its reason, while checking.
 */
export function ViewerStatePanel({
  state,
  downloadHref,
  onRetry,
  retrying = false,
  canComment,
  blockedReason = null,
}: ViewerStatePanelProps) {
  const t = useT();
  const copy = {
    checking: {
      capsule: <StateCapsule state="waiting">{t('Viewer.state.checkingCapsule')}</StateCapsule>,
      title: t('Viewer.state.checkingTitle'),
      body: t('Viewer.state.checkingBody'),
    },
    preparing: {
      capsule: <StateCapsule state="waiting">{t('Viewer.state.preparingCapsule')}</StateCapsule>,
      title: t('Viewer.state.preparingTitle'),
      body: t('Viewer.state.preparingBody'),
    },
    failed: {
      capsule: <StateCapsule state="blocked">{t('Viewer.state.failedCapsule')}</StateCapsule>,
      title: t('Viewer.state.failedTitle'),
      body: t('Viewer.state.failedBody'),
    },
    blocked: {
      capsule: <StateCapsule state="blocked">{t('Viewer.state.blockedCapsule')}</StateCapsule>,
      title: t('Viewer.state.blockedTitle'),
      body: t(BLOCKED_BODY[blockedReason ?? 'unknown']),
    },
    unsupported: {
      capsule: <StateCapsule state="neutral">{t('Viewer.state.unsupportedCapsule')}</StateCapsule>,
      title: t('Viewer.state.unsupportedTitle'),
      body: t('Viewer.state.unsupportedBody'),
    },
  }[state];

  const downloadDisabled = downloadHref === null || state === 'checking' || state === 'blocked';
  const icon = state === 'failed' ? 'refresh' : state === 'unsupported' ? 'download' : 'eye';

  return (
    <div className="tm-viewer-stage tm-viewer-stage--state" role="status">
      <div className="tm-viewer-state">
        <span className="tm-viewer-state__icon" data-state={state} aria-hidden="true">
          {state === 'checking' || state === 'preparing' ? (
            <span className="tm-viewer-state__spinner" />
          ) : (
            <ViewerIcon name={state === 'blocked' ? 'close' : icon} />
          )}
        </span>
        {copy.capsule}
        <h2 className="tm-viewer-state__title">{copy.title}</h2>
        <p className="tm-viewer-state__body">{copy.body}</p>
        <div className="tm-viewer-state__actions">
          {state === 'failed' && onRetry ? (
            <Button
              type="button"
              tone="ink"
              loading={retrying}
              loadingLabel={t('Viewer.state.retrying')}
              onClick={onRetry}
            >
              <ViewerIcon name="refresh" />
              {t('Viewer.state.retry')}
            </Button>
          ) : null}
          {state === 'blocked' ? null : downloadDisabled ? (
            <Button type="button" tone="outline" disabled>
              <ViewerIcon name="download" />
              {t('Viewer.download')}
            </Button>
          ) : (
            <a
              className={`tm-button tm-button--${state === 'unsupported' ? 'ink' : 'outline'} tm-button--default`}
              href={downloadHref}
            >
              <ViewerIcon name="download" />
              {t('Viewer.download')}
            </a>
          )}
        </div>
        {state === 'checking' ? (
          <p className="tm-viewer-state__note">{t('Viewer.state.checkingDownload')}</p>
        ) : null}
        {state === 'blocked' ? (
          <p className="tm-viewer-state__note">{t('Viewer.state.blockedNoActions')}</p>
        ) : null}
        {state === 'unsupported' && canComment ? (
          <p className="tm-viewer-state__note">{t('Viewer.state.generalComments')}</p>
        ) : null}
      </div>
    </div>
  );
}
