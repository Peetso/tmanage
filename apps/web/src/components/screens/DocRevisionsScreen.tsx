'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { getDocument } from '../../lib/api/documents';
import {
  captureDocRevision,
  listDocRevisions,
  restoreDocRevision,
} from '../../lib/api/doc-revisions';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface DocRevisionsScreenProps {
  organizationSlug: string;
  organizationName: string;
  documentId: string;
  client?: ApiClient;
}

/**
 * **DOC revision history (x241).**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Docs — a document's snapshot trail beside the editor. It
 * lists the revisions newest-first, captures the current body as a new revision, and restores a prior
 * revision. Restore is forward-append: the API writes a NEW revision equal to the chosen snapshot and
 * bumps the current body, so nothing in the history is rewritten.
 *
 * ## What it does, and what it cannot
 *
 * - **People are shown by id.** No endpoint resolves a member id to a display name here, the honesty
 *   the editor and templates screens apply to the same gap.
 * - **Capture takes the body typed here.** This panel is a distinct history surface, not the editor;
 *   it captures whatever body the person enters, and the editor seeds its own draft elsewhere.
 */
export function DocRevisionsScreen({
  organizationSlug,
  organizationName,
  documentId,
  client,
}: DocRevisionsScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const document = useQuery({
    queryKey: ['document', organizationSlug, documentId],
    queryFn: () => getDocument(api, organizationSlug, documentId),
  });

  const revisions = useQuery({
    queryKey: ['doc-revisions', organizationSlug, documentId],
    queryFn: () => listDocRevisions(api, organizationSlug, documentId),
  });

  const [snapshot, setSnapshot] = useState('');

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['doc-revisions', organizationSlug, documentId] });

  const capture = useMutation({
    mutationFn: () => captureDocRevision(api, organizationSlug, documentId, snapshot),
    onSuccess: async () => {
      setSnapshot('');
      await invalidate();
    },
  });

  const restore = useMutation({
    mutationFn: (revisionId: string) =>
      restoreDocRevision(api, organizationSlug, documentId, revisionId),
    onSuccess: async () => {
      await invalidate();
    },
  });

  const rows = revisions.data ?? [];
  const canCapture = snapshot.trim() !== '' && !capture.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="docs"
      title="Revision history"
      description="Every saved snapshot of this document. Restore a prior revision to bring its text back — the history is kept intact."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-rev-new-heading">
        <h2 id="tm-rev-new-heading" className="tm-eyebrow">
          Capture a revision
        </h2>
        <form
          className="tm-stack"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (canCapture) capture.mutate();
          }}
        >
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-rev-body">
              Snapshot text
              <span className="tm-field__required" aria-hidden="true">
                *
              </span>
            </label>
            <textarea
              id="tm-rev-body"
              name="bodySnapshot"
              className="tm-field__control tm-field__control--multiline"
              rows={10}
              value={snapshot}
              onChange={(event) => setSnapshot(event.target.value)}
              aria-describedby="tm-rev-body-hint"
              required
            />
            <span className="tm-field__hint" id="tm-rev-body-hint">
              Captures this text as a new revision and updates the document&rsquo;s current body.
            </span>
          </div>

          {capture.isError ? (
            <InlineAlert tone="danger" title="Could not capture the revision" live>
              {describeError(capture.error)}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={capture.isPending}
              loadingLabel="Capturing"
              disabled={!canCapture}
            >
              Capture revision
            </Button>
          </div>
        </form>
      </section>

      <section
        className="tm-panel tm-panel--quiet tm-stack"
        aria-labelledby="tm-rev-history-heading"
      >
        <h2 id="tm-rev-history-heading" className="tm-eyebrow">
          {document.data ? document.data.title : 'History'}
        </h2>

        {restore.isError ? (
          <InlineAlert tone="danger" title="Could not restore that revision" live>
            {describeError(restore.error)}
          </InlineAlert>
        ) : null}

        {revisions.isError ? (
          <InlineAlert tone="danger" title="Could not load the revisions" live>
            {describeError(revisions.error)}
          </InlineAlert>
        ) : null}

        {revisions.isPending ? (
          <LoadingRegion label="Loading the revision history.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!revisions.isPending && !revisions.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title="No revisions yet">
            Capture a revision above. Each capture snapshots the document&rsquo;s body so you can
            restore it later.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <div
            className="tm-table-scroll"
            // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
            // (WCAG 2.2 2.1.1), matching the other screens' tables.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Document revisions"
          >
            <table className="tm-table">
              <caption className="tm-visually-hidden">
                This document&rsquo;s revisions, newest first, {rows.length} shown.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Revision</th>
                  <th scope="col">Saved by</th>
                  <th scope="col">Saved at</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((revision) => (
                  <tr key={revision.id}>
                    <th scope="row" className="tm-table__title">
                      #{revision.revNo}
                    </th>
                    <td>{revision.savedBy}</td>
                    <td>{new Date(revision.savedAt).toLocaleString()}</td>
                    <td>
                      <Button
                        type="button"
                        tone="outline"
                        size="accessible"
                        loading={restore.isPending && restore.variables === revision.id}
                        loadingLabel="Restoring"
                        onClick={() => restore.mutate(revision.id)}
                      >
                        Restore
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
