'use client';

import { Button } from '@tmanage/ui';
import { useT } from '../../lib/i18n/use-t';
import { FormatIcon } from './format-icons';
import './format-stages.css';

/**
 * R4 slice 10 — what an Office stage shows while the browser opens the file, and when it cannot:
 * a plain sentence and the download (the original is always the way to see the exact file).
 */
export function OfficeLoadState({
  state,
  onDownload,
}: {
  readonly state: 'loading' | 'failed';
  readonly onDownload?: (() => void) | undefined;
}) {
  const t = useT();
  if (state === 'loading') {
    return (
      <div className="tm-format-loading" role="status">
        {t('ViewerFormats.office.opening')}
      </div>
    );
  }
  return (
    <div className="tm-format-empty" role="group">
      <h2 className="tm-format-empty__title">{t('ViewerFormats.office.failedTitle')}</h2>
      <p className="tm-format-empty__body">{t('ViewerFormats.office.failedBody')}</p>
      {onDownload ? (
        <Button tone="ink" onClick={onDownload}>
          <FormatIcon name="download" />
          <span>{t('ViewerFormats.unsupported.download')}</span>
        </Button>
      ) : null}
    </div>
  );
}
