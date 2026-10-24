'use client';

import { useState } from 'react';
import { Button, InlineAlert, StateCapsule } from '@tmanage/ui';
import { downloadNotScannedFile } from '../../lib/api/download-scan-policy';
import { useT } from '../../lib/i18n/use-t';
import './download-scan-policy.css';

export interface NotScannedDownloadProps {
  /** The file's download route on the API origin. */
  readonly href: string;
  readonly fileName: string;
  /** Injected by tests; the browser's own fetch by default. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

/**
 * B5 (Figma 388:4149 / 388:4404) — the end of a file row for a file the virus scan has not
 * checked yet: the "Not scanned" label and Download. Under "Allow, marked Not scanned" the file is
 * saved as usual. When the owner chose "Block until scanned" the API refuses it; Download is then
 * disabled and the row says why. Render it inside a row that carries `tm-scan-row`.
 */
export function NotScannedDownload({ href, fileName, fetchImpl }: NotScannedDownloadProps) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'busy' | 'blocked' | 'failed'>('idle');

  const download = async () => {
    setState('busy');
    const result = await downloadNotScannedFile(href, fileName, fetchImpl);
    setState(result.kind === 'saved' ? 'idle' : result.kind);
  };

  return (
    <>
      <span className="tm-scan-row__actions">
        <StateCapsule state="waiting" className="tm-scan-capsule">
          {t('DownloadScan.notScanned')}
        </StateCapsule>
        <Button
          type="button"
          tone="outline"
          disabled={state === 'blocked'}
          loading={state === 'busy'}
          loadingLabel={t('DownloadScan.download')}
          onClick={() => void download()}
        >
          {t('DownloadScan.download')}
        </Button>
      </span>
      {state === 'blocked' ? (
        <InlineAlert tone="warning" live className="tm-scan-row__message">
          {t('DownloadScan.blocked')}
        </InlineAlert>
      ) : null}
      {state === 'failed' ? (
        <InlineAlert tone="danger" live className="tm-scan-row__message">
          {t('DownloadScan.downloadError')}
        </InlineAlert>
      ) : null}
    </>
  );
}
