'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  getDocument,
  getDocumentVersion,
  listDocumentVersions,
  restoreDocumentVersion,
  saveDocumentVersion,
} from '../../lib/api/documents';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface DocumentEditorScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The document being edited — its id arrives in the route path. */
  documentId: string;
  client?: ApiClient;
}

/**
 * **DOC-02 editor + DOC-03 version history / compare / restore.**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Docs DOC-02 (editor) and DOC-03 (version history,
 * compare, restore). This screen is the *write* half of the docs module: it edits a document's body
 * and saves each edit as an immutable version, lists the versions newest-first, shows one snapshot
 * side-by-side for compare, and restores a prior one. It is disjoint from the DOC-01 hub/read
 * screens (x106): those own the document record and its current-body read; this owns the editor and
 * the version trail.
 *
 * ## What it does, and what it cannot
 *
 * - **A save is a new version, never a rewrite.** The API appends a snapshot and bumps the current
 *   body in one transaction; the editor shows the newest version at the top after each save.
 * - **Restore is forward-append.** Restoring version *n* writes a new version equal to it — history
 *   is never mutated, so the trail only ever grows.
 * - **People are shown by id.** No endpoint resolves an arbitrary member's id to a display name
 *   here, so "saved by" is the id — the honesty `WorkWorkloadScreen` applies to the same gap.
 * - **Compare is a read of one snapshot**, not a three-way diff: rendering a diff is deferred
 *   (NEXT-SCOPES-9). The pane shows the selected version's body beside the editor.
 */
export function DocumentEditorScreen({
  organizationSlug,
  organizationName,
  documentId,
  client,
}: DocumentEditorScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const document = useQuery({
    queryKey: ['document', organizationSlug, documentId],
    queryFn: () => getDocument(api, organizationSlug, documentId),
  });

  const versions = useQuery({
    queryKey: ['document-versions', organizationSlug, documentId],
    queryFn: () => listDocumentVersions(api, organizationSlug, documentId),
  });

  // `null` means "not yet edited" — the textarea then shows the document's current body. Once the
  // person types, the draft is what they typed; a restore clears it back to `null` so the restored
  // body shows through.
  const [draft, setDraft] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);

  const body = draft ?? document.data?.body ?? '';

  const comparison = useQuery({
    queryKey: ['document-version', organizationSlug, documentId, selectedVersion],
    queryFn: () => getDocumentVersion(api, organizationSlug, documentId, selectedVersion as number),
    enabled: selectedVersion !== null,
  });

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['document', organizationSlug, documentId] }),
      queryClient.invalidateQueries({
        queryKey: ['document-versions', organizationSlug, documentId],
      }),
    ]);
  };

  const save = useMutation({
    mutationFn: () => saveDocumentVersion(api, organizationSlug, documentId, body),
    onSuccess: async () => {
      setDraft(null);
      await invalidate();
    },
  });

  const restore = useMutation({
    mutationFn: (versionNo: number) =>
      restoreDocumentVersion(api, organizationSlug, documentId, versionNo),
    onSuccess: async () => {
      setDraft(null);
      setSelectedVersion(null);
      await invalidate();
    },
  });

  const rows = versions.data ?? [];
  const canSave = body.trim() !== '' && !document.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="docs"
      title="Edit document"
      description="Edit the document and save each change as a version you can compare and restore."
    >
      {document.isError ? (
        <InlineAlert tone="danger" title="Could not load the document" live>
          {describeError(document.error)}
        </InlineAlert>
      ) : null}

      {document.isPending ? (
        <LoadingRegion label="Loading the document.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {document.data ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-doc-editor-heading">
          <h2 id="tm-doc-editor-heading" className="tm-eyebrow">
            {document.data.title}
          </h2>
          <form
            className="tm-stack"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (canSave) save.mutate();
            }}
          >
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-doc-body">
                Document body
              </label>
              <textarea
                id="tm-doc-body"
                name="body"
                className="tm-field__control tm-field__control--multiline"
                rows={12}
                value={body}
                onChange={(event) => setDraft(event.target.value)}
                aria-describedby="tm-doc-body-hint"
              />
              <span className="tm-field__hint" id="tm-doc-body-hint">
                Saving keeps the previous text as a version you can always return to.
              </span>
            </div>

            {save.isError ? (
              <InlineAlert tone="danger" title="Could not save this version" live>
                {describeError(save.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={save.isPending}
                loadingLabel="Saving"
                disabled={!canSave}
              >
                Save new version
              </Button>
            </div>
          </form>
        </section>
      ) : null}

      <section
        className="tm-panel tm-panel--quiet tm-stack"
        aria-labelledby="tm-doc-history-heading"
      >
        <h2 id="tm-doc-history-heading" className="tm-eyebrow">
          Version history
        </h2>

        {versions.isError ? (
          <InlineAlert tone="danger" title="Could not load the version history" live>
            {describeError(versions.error)}
          </InlineAlert>
        ) : null}

        {versions.isPending ? (
          <LoadingRegion label="Loading the version history.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {restore.isError ? (
          <InlineAlert tone="danger" title="Could not restore that version" live>
            {describeError(restore.error)}
          </InlineAlert>
        ) : null}

        {!versions.isPending && !versions.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title="No versions yet">
            Save an edit above to create the first version. Every save you make appears here.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <div
            className="tm-table-scroll"
            // A scrollable region must be focusable or a keyboard cannot reach its overflow
            // columns (WCAG 2.2 2.1.1), matching the work screens' tables.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Saved versions"
          >
            <table className="tm-table">
              <caption className="tm-visually-hidden">
                This document&rsquo;s versions, newest first, {rows.length} shown.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">Saved by</th>
                  <th scope="col">When</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((version) => (
                  <tr key={version.id}>
                    <th scope="row" className="tm-table__title">
                      {version.versionNo}
                    </th>
                    <td>{version.editedByUserId}</td>
                    <td>{formatWhen(version.createdAt)}</td>
                    <td>
                      <div className="tm-row">
                        <Button
                          type="button"
                          tone="outline"
                          size="accessible"
                          onClick={() => setSelectedVersion(version.versionNo)}
                        >
                          Compare
                        </Button>
                        <Button
                          type="button"
                          tone="outline"
                          size="accessible"
                          loading={restore.isPending && restore.variables === version.versionNo}
                          loadingLabel="Restoring"
                          onClick={() => restore.mutate(version.versionNo)}
                        >
                          Restore
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {selectedVersion !== null ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-doc-compare-heading">
          <h2 id="tm-doc-compare-heading" className="tm-eyebrow">
            Version {selectedVersion}
          </h2>
          {comparison.isPending ? (
            <LoadingRegion label="Loading the version.">
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}
          {comparison.isError ? (
            <InlineAlert tone="danger" title="Could not load that version" live>
              {describeError(comparison.error)}
            </InlineAlert>
          ) : null}
          {comparison.data ? (
            <pre className="tm-doc-snapshot" aria-label={`Body of version ${selectedVersion}`}>
              {comparison.data.body}
            </pre>
          ) : null}
        </section>
      ) : null}
    </AppShell>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(0, 16).replace('T', ' ');
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
