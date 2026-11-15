'use client';

import { useState } from 'react';
import { Button, InlineAlert } from '@tmanage/ui';
import { apiBaseUrl } from '../../../lib/api/browser-client';
import { downloadRecordPdf } from '../../../lib/api/approval-records';

export interface PdfDownloadButtonProps {
  /** API path (`/v1/…/record.pdf`); the API origin is added here. */
  path: string;
  fileName: string;
  label: string;
  busyLabel: string;
  failedLabel: string;
  tone?: 'ink' | 'outline';
  fetchImpl?: typeof globalThis.fetch;
}

/** 52-19 / 52-26 — "Download PDF" for a sealed record; the server checks who may have it. */
export function PdfDownloadButton({
  path,
  fileName,
  label,
  busyLabel,
  failedLabel,
  tone = 'outline',
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
  return (
    <>
      <Button
        tone={tone}
        size="accessible"
        onClick={() => void download()}
        loading={busy}
        loadingLabel={busyLabel}
      >
        {label}
      </Button>
      {failed ? (
        <InlineAlert tone="danger" live>
          {failedLabel}
        </InlineAlert>
      ) : null}
    </>
  );
}
