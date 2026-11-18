'use client';

import { useState } from 'react';
import { Button, InlineAlert, Tooltip } from '@tmanage/ui';
import { apiBaseUrl } from '../../../lib/api/browser-client';
import { downloadRecordPdf } from '../../../lib/api/approval-records';

export interface PdfDownloadButtonProps {
  /** API path (`/v1/…/record.pdf`, `/v1/…/evidence.zip`); the API origin is added here. */
  path: string;
  fileName: string;
  label: string;
  busyLabel: string;
  failedLabel: string;
  tone?: 'ink' | 'outline';
  /** A hover/focus sentence saying what the download holds. */
  help?: string;
  fetchImpl?: typeof globalThis.fetch;
}

/** 52-19 / 52-26 — "Download PDF" (or the evidence ZIP) for a sealed record; the server checks who may have it. */
export function PdfDownloadButton({
  path,
  fileName,
  label,
  busyLabel,
  failedLabel,
  tone = 'outline',
  help,
  fetchImpl,
}: PdfDownloadButtonProps) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const download = async () => {
    setBusy(true);
    setFailed(false);
    const ok = await downloadRecordPdf(`${apiBaseUrl()}${path}`, fileName, fetchImpl);
    setBusy(false);
    setFailed(!ok);
  };
  const button = (
    <Button
      tone={tone}
      size="accessible"
      onClick={() => void download()}
      loading={busy}
      loadingLabel={busyLabel}
    >
      {label}
    </Button>
  );
  return (
    <>
      {help === undefined ? button : <Tooltip content={help}>{button}</Tooltip>}
      {failed ? (
        <InlineAlert tone="danger" live>
          {failedLabel}
        </InlineAlert>
      ) : null}
    </>
  );
}
