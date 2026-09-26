'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { DocumentExportButton } from './DocumentExportButton';
import { browserApiClient } from '../../lib/api/browser-client';
import { getDocument } from '../../lib/api/documents';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { formatInstant } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';

export interface DocumentViewScreenProps {
  organizationSlug: string;
  organizationName: string;
  documentId: string;
  client?: ApiClient;
}

/**
 * **DOC-03 Document view (read side).**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Docs DOC-03: "Document view/history." This is the read
 * side — a document's title, body and metadata, read-only. History (versions), compare/restore
 * and the client projection are the write/history half, deferred (DOC-03 write, DOC-02 editor).
 *
 * ## Not-found is the interesting state (Known trap)
 *
 * The route names the document by id. The API resolves that id **tenant-scoped before the
 * relation check** (x91), so an id in another tenant, a document in a project the caller is not a
 * member of, and an id that simply does not exist all answer the **same** 404 — never a 403 that
 * would confirm the document exists, and never a 500. This screen renders that 404 as a plain
 * "not found" state and does not try to tell the three apart, which is exactly what keeps a
 * non-member from probing which documents a studio keeps. Any other failure is shown as an error,
 * not as not-found, so a transient outage is not misread as "deleted".
 */
export function DocumentViewScreen({
  organizationSlug,
  organizationName,
  documentId,
  client,
}: DocumentViewScreenProps) {
  const api = client ?? browserApiClient();

  const document = useQuery({
    queryKey: ['document', organizationSlug, documentId],
    queryFn: () => getDocument(api, organizationSlug, documentId),
  });

  // A 404 is the not-found state; every other refusal is an error. The API answers unknown,
  // cross-tenant and non-member ids all with 404, so this one branch covers the whole trap.
  const notFound = useMemo(
    () =>
      document.isError &&
      document.error instanceof ApiRequestError &&
      document.error.status === 404,
    [document.isError, document.error],
  );

  const data = document.data;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="docs"
      title={data ? data.title : 'Document'}
      description={data ? 'A document in this project.' : undefined}
      actions={
        <>
          {/* DOC export (x131): a Markdown download of the current version, shown once the document
              has loaded so the control never links to an id the caller cannot read. */}
          {data ? (
            <DocumentExportButton organizationSlug={organizationSlug} documentId={documentId} />
          ) : null}
          <Link className="tm-button tm-button--outline" href={`/${organizationSlug}/docs`}>
            Back to Docs
          </Link>
        </>
      }
    >
      {document.isPending ? (
        <LoadingRegion label="Loading the document.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {notFound ? (
        <InlineAlert tone="neutral" title="Document not found" live>
          This document does not exist, or you do not have access to it.
        </InlineAlert>
      ) : null}

      {document.isError && !notFound ? (
        <InlineAlert tone="danger" title="Could not load the document" live>
          {describeError(document.error)}
        </InlineAlert>
      ) : null}

      {data ? (
        <>
          <section className="tm-panel tm-stack" aria-labelledby="tm-document-meta">
            <h2 id="tm-document-meta" className="tm-eyebrow">
              Details
            </h2>
            <dl className="tm-detail-list">
              <div className="tm-detail-list__pair">
                <dt>Created</dt>
                <dd>{formatInstant(data.createdAt)}</dd>
              </div>
              <div className="tm-detail-list__pair">
                <dt>Last updated</dt>
                <dd>{formatInstant(data.updatedAt)}</dd>
              </div>
            </dl>
          </section>

          <section className="tm-panel tm-stack" aria-labelledby="tm-document-body">
            <h2 id="tm-document-body" className="tm-eyebrow">
              Document
            </h2>
            {toParagraphs(data.body).map((line, index) => (
              // Plain-text body from a TEXT column: React escapes it, and each author line is its
              // own paragraph so the reading preserves the breaks without interpreting markup.
              <p key={index} className="tm-prose">
                {line}
              </p>
            ))}
          </section>
        </>
      ) : null}
    </AppShell>
  );
}

/** Split a plain-text body into paragraphs on line breaks, dropping blank lines. */
function toParagraphs(body: string): readonly string[] {
  const lines = body.split(/\r?\n/).filter((line) => line.trim() !== '');
  return lines.length > 0 ? lines : [body];
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
