'use client';

import { useState } from 'react';
import { Button, InlineAlert } from '@tmanage/ui';
import { downloadRecordPdf } from '../../../lib/api/approval-records';
import { apiBaseUrl } from '../../../lib/api/browser-client';
import { useTOr } from '../../../lib/i18n/use-t-or';

/** One "Download PDF" on a detail screen: the button sits in the header, the failure under it. */
export interface DocumentPdf {
  readonly busy: boolean;
  readonly failed: boolean;
  readonly download: (path: string, fileName: string) => void;
}

/**
 * 52-10 — fetches an invoice or quote PDF with the session cookie (never a token in the URL) and
 * saves it under `fileName`; the API decides who may have it.
 */
export function useDocumentPdf(fetchImpl?: typeof globalThis.fetch): DocumentPdf {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const download = (path: string, fileName: string) => {
    setBusy(true);
    setFailed(false);
    void downloadRecordPdf(`${apiBaseUrl()}${path}`, fileName, fetchImpl).then((ok) => {
      setBusy(false);
      setFailed(!ok);
    });
  };
  return { busy, failed, download };
}

export function DocumentPdfButton({
  pdf,
  path,
  fileName,
}: {
  readonly pdf: DocumentPdf;
  readonly path: string;
  readonly fileName: string;
}) {
  const tOr = useTOr();
  const preparing = tOr('DocumentPdf.preparing', 'Preparing PDF…');
  return (
    <Button
      tone="outline"
      loading={pdf.busy}
      loadingLabel={preparing}
      onClick={() => pdf.download(path, fileName)}
    >
      {pdf.busy ? preparing : tOr('DocumentPdf.download', 'Download PDF')}
    </Button>
  );
}

export function DocumentPdfFailure({ pdf }: { readonly pdf: DocumentPdf }) {
  const tOr = useTOr();
  return pdf.failed ? (
    <InlineAlert tone="warning" live>
      {tOr('DocumentPdf.failed', 'We could not prepare the PDF. Nothing is lost — try again.')}
    </InlineAlert>
  ) : null;
}
