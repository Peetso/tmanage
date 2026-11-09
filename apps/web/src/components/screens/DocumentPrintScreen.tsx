'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { getDocument } from '../../lib/api/documents';
import { useTOr } from '../../lib/i18n/use-t-or';
import { appDateLocale, appLocale } from '../../lib/i18n/app-locale';
import { DocMarkdown } from '../docs/DocMarkdown';
import { DocBodyView } from '../docs/editor/DocBodyView';
import '../docs/doc-print.css';

export interface DocumentPrintScreenProps {
  organizationSlug: string;
  documentId: string;
  client?: ApiClient;
  /** Tests pass `false`; the real route prints once the body has loaded. */
  autoPrint?: boolean;
}

/** jsdom implements `window.print` as a "not implemented" error; never call it there. */
function canPrint(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.print === 'function' &&
    !/jsdom/iu.test(window.navigator.userAgent)
  );
}

/**
 * **R5 PDF export — the print view (Figma 10b, 487:29340).** A bare A4 page of the document: the
 * title, a meta line, the body and a footer; `@page` CSS sets A4 and the page counter. Once the
 * document query resolves the browser's print dialog opens once ("Save as PDF" there) — free, no
 * converter. An `html` body renders through the read-only Tiptap view (schema-parsed, never
 * `dangerouslySetInnerHTML`); a legacy Markdown body through `DocMarkdown`.
 */
export function DocumentPrintScreen({
  organizationSlug,
  documentId,
  client,
  autoPrint = true,
}: DocumentPrintScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const printed = useRef(false);
  const document = useQuery({
    queryKey: ['document', organizationSlug, documentId],
    queryFn: () => getDocument(api, organizationSlug, documentId),
  });

  useEffect(() => {
    if (!autoPrint || !document.isSuccess || printed.current || !canPrint()) return undefined;
    printed.current = true;
    // One frame of grace so the read-only editor has laid out the body before the dialog opens.
    const timer = window.setTimeout(() => window.print(), 400);
    return () => window.clearTimeout(timer);
  }, [autoPrint, document.isSuccess]);

  if (document.isPending) {
    return <p className="tm-doc-print">{tOr('DocPrint.loading', 'Preparing the print view…')}</p>;
  }
  if (document.isError) {
    return <p className="tm-doc-print">{tOr('DocPrint.notFound', 'Document not found')}</p>;
  }

  const doc = document.data;
  // `bodyFormat` arrives with R5 slice 2; until then every body is Markdown.
  const format = (doc as { bodyFormat?: 'markdown' | 'html' }).bodyFormat ?? 'markdown';

  return (
    <article className="tm-doc-print" dir="auto">
      <div className="tm-doc-print__actions">
        <button
          type="button"
          className="tm-button tm-button--outline"
          onClick={() => {
            if (canPrint()) window.print();
          }}
        >
          {tOr('DocPrint.print', 'Print or save as PDF')}
        </button>
      </div>
      <h1 className="tm-doc-print__title" dir="auto">
        {doc.title}
      </h1>
      <p className="tm-doc-print__meta">
        {tOr('DocPrint.printed', 'Printed')}{' '}
        {new Date().toLocaleDateString(appDateLocale(appLocale(), appLocale()))}
      </p>
      <div className="tm-doc-print__body" dir="auto">
        {format === 'html' ? (
          <DocBodyView html={doc.body} />
        ) : (
          <DocMarkdown
            body={doc.body}
            doneLabel={tOr('DocPrint.done', 'Done')}
            openLabel={tOr('DocPrint.open', 'Not done')}
          />
        )}
      </div>
      <footer className="tm-doc-print__footer">
        {doc.title} · {tOr('DocPrint.brand', 'TManage')}
      </footer>
    </article>
  );
}
