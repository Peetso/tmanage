'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/docs.css';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  getDocument,
  getDocumentSharing,
  getDocumentVersion,
  listDocumentVersions,
  restoreDocumentVersion,
  saveDocumentVersion,
} from '../../lib/api/documents';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';

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
 * - **People are shown by name.** "Saved by" resolves the editor's user id through the document's
 *   collaborators (`documents/:id/sharing`, names anchored on this tenant's memberships); an id the
 *   API could not name falls back to "A former member".
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
  const t = useT();

  const document = useQuery({
    queryKey: ['document', organizationSlug, documentId],
    queryFn: () => getDocument(api, organizationSlug, documentId),
  });

  const versions = useQuery({
    queryKey: ['document-versions', organizationSlug, documentId],
    queryFn: () => listDocumentVersions(api, organizationSlug, documentId),
  });

  // Collaborators carry the display names "Saved by" shows (same key as the read screen's top bar).
  const sharing = useQuery({
    queryKey: ['document-sharing', organizationSlug, documentId],
    queryFn: () => getDocumentSharing(api, organizationSlug, documentId),
  });
  const nameOf = (userId: string): string =>
    sharing.data?.collaborators?.find((person) => person.userId === userId)?.displayName ??
    (sharing.isPending ? '…' : t('DocumentEditorScreen.formerMember'));

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
  const data = document.data;
  const latest = rows[0];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="docs"
      eyebrow={t('DocumentEditorScreen.eyebrow')}
      title={
        data
          ? `${t('DocumentEditorScreen.editPrefix')}${data.title}`
          : t('DocumentEditorScreen.editFallback')
      }
      actions={
        <div className="tm-dx-topbar">
          <Link className="tm-dx-back" href={`/${organizationSlug}/docs/${documentId}`}>
            <span className="tm-dx-back__orb" aria-hidden="true">
              ←
            </span>
            {t('DocumentEditorScreen.backToDocument')}
          </Link>
          {data ? (
            <span className="tm-dx-stamp">
              {latest ? `${t('DocumentEditorScreen.versionPrefix')}${latest.versionNo} · ` : ''}
              {t('DocumentEditorScreen.saved')} {formatWhen(data.updatedAt)}
            </span>
          ) : null}
          <div className="tm-dx-topbar__end">
            <nav className="tm-segmented" aria-label={t('DocumentEditorScreen.documentViewsAria')}>
              <Link href={`/${organizationSlug}/docs/${documentId}`}>
                {t('DocumentEditorScreen.read')}
              </Link>
              <Link href={`/${organizationSlug}/docs/${documentId}/edit`} aria-current="page">
                {t('DocumentEditorScreen.editAndHistory')}
              </Link>
            </nav>
            {data ? (
              <Button
                type="submit"
                form="tm-doc-editor-form"
                tone="ink"
                size="default"
                loading={save.isPending}
                loadingLabel={t('DocumentEditorScreen.saving')}
                disabled={!canSave}
              >
                {t('DocumentEditorScreen.saveNewVersion')}
              </Button>
            ) : null}
          </div>
        </div>
      }
    >
      {document.isError ? (
        <InlineAlert tone="danger" title={t('DocumentEditorScreen.loadError')} live>
          {describeError(document.error)}
        </InlineAlert>
      ) : null}

      {document.isPending ? (
        <LoadingRegion label={t('DocumentEditorScreen.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      <div className="tm-dx-doc">
        <div className="tm-dx-doc__stage">
          {data ? (
            <section className="tm-dx-sheet" aria-labelledby="tm-doc-editor-heading">
              <header className="tm-dx-sheet__head">
                <h2 id="tm-doc-editor-heading" className="tm-dx-sheet__eyebrow">
                  {t('DocumentEditorScreen.editingPrefix')}
                  {data.title}
                </h2>
                {/* The shell's h1 names the screen for assistive technology; this is the title
                    on paper, hidden from the accessibility tree so it is not read twice. */}
                <p className="tm-dx-sheet__title" aria-hidden="true">
                  {data.title}
                </p>
              </header>
              <hr className="tm-dx-sheet__rule" />
              <form
                id="tm-doc-editor-form"
                className="tm-dx-sheet__editor"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  if (canSave) save.mutate();
                }}
              >
                <label className="tm-visually-hidden" htmlFor="tm-doc-body">
                  {t('DocumentEditorScreen.documentBody')}
                </label>
                <textarea
                  id="tm-doc-body"
                  name="body"
                  className="tm-dx-sheet__textarea"
                  rows={16}
                  value={body}
                  onChange={(event) => setDraft(event.target.value)}
                  aria-describedby="tm-doc-body-hint"
                />
                <span className="tm-dx-sheet__hint" id="tm-doc-body-hint">
                  {t('DocumentEditorScreen.bodyHint')}
                </span>

                {save.isError ? (
                  <InlineAlert tone="danger" title={t('DocumentEditorScreen.saveError')} live>
                    {describeError(save.error)}
                  </InlineAlert>
                ) : null}
              </form>
            </section>
          ) : null}
        </div>

        <section className="tm-dx-edge" aria-labelledby="tm-doc-history-heading">
          <h2 id="tm-doc-history-heading" className="tm-dx-edge__caption">
            {t('DocumentEditorScreen.versionHistory')}
            {rows.length > 0 ? ` · ${rows.length}` : ''}
          </h2>

          {versions.isError ? (
            <InlineAlert tone="danger" title={t('DocumentEditorScreen.loadHistoryError')} live>
              {describeError(versions.error)}
            </InlineAlert>
          ) : null}

          {versions.isPending ? (
            <LoadingRegion label={t('DocumentEditorScreen.loadingHistory')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {restore.isError ? (
            <InlineAlert tone="danger" title={t('DocumentEditorScreen.restoreError')} live>
              {describeError(restore.error)}
            </InlineAlert>
          ) : null}

          {!versions.isPending && !versions.isError && rows.length === 0 ? (
            <div className="tm-dx-empty">
              <p className="tm-dx-empty__title">{t('DocumentEditorScreen.emptyTitle')}</p>
              <p className="tm-dx-empty__body">{t('DocumentEditorScreen.emptyBody')}</p>
            </div>
          ) : null}

          {rows.length > 0 ? (
            <div
              // A scrollable region must be focusable or a keyboard cannot reach its overflow
              // (WCAG 2.2 2.1.1), matching the work screens' tables.
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
              tabIndex={0}
              role="region"
              aria-label={t('DocumentEditorScreen.savedVersionsAria')}
            >
              {/* Explicit roles keep the table's semantics while it is drawn as DOC-03's stack of
                  version cards. */}
              {/* eslint-disable jsx-a11y/no-redundant-roles */}
              <table className="tm-dx-versions" role="table">
                <caption className="tm-visually-hidden">
                  {t('DocumentEditorScreen.captionPrefix')} {rows.length}{' '}
                  {t('DocumentEditorScreen.captionSuffix')}
                </caption>
                <thead role="rowgroup">
                  <tr role="row">
                    <th scope="col" role="columnheader">
                      {t('DocumentEditorScreen.thVersion')}
                    </th>
                    <th scope="col" role="columnheader">
                      {t('DocumentEditorScreen.thSavedBy')}
                    </th>
                    <th scope="col" role="columnheader">
                      {t('DocumentEditorScreen.thWhen')}
                    </th>
                    <th scope="col" role="columnheader">
                      {t('DocumentEditorScreen.thActions')}
                    </th>
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  {rows.map((version) => (
                    <tr key={version.id} role="row">
                      <th scope="row" role="rowheader" className="tm-dx-versions__no">
                        {version.versionNo}
                      </th>
                      <td className="tm-dx-versions__who">{nameOf(version.editedByUserId)}</td>
                      <td className="tm-dx-versions__when">{formatWhen(version.createdAt)}</td>
                      <td className="tm-dx-versions__act">
                        <div>
                          <Button
                            type="button"
                            tone="outline"
                            size="compact"
                            aria-pressed={selectedVersion === version.versionNo}
                            onClick={() => setSelectedVersion(version.versionNo)}
                          >
                            {t('DocumentEditorScreen.compare')}
                          </Button>
                          <Button
                            type="button"
                            tone="outline"
                            size="compact"
                            loading={restore.isPending && restore.variables === version.versionNo}
                            loadingLabel={t('DocumentEditorScreen.restoring')}
                            onClick={() => restore.mutate(version.versionNo)}
                          >
                            {t('DocumentEditorScreen.restore')}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* eslint-enable jsx-a11y/no-redundant-roles */}
            </div>
          ) : null}

          {selectedVersion !== null ? (
            <section className="tm-dx-compare" aria-labelledby="tm-doc-compare-heading">
              <h3 id="tm-doc-compare-heading" className="tm-dx-edge__caption">
                {t('DocumentEditorScreen.comparePrefix')}
                {selectedVersion}
                {t('DocumentEditorScreen.compareSuffix')}
              </h3>
              {comparison.isPending ? (
                <LoadingRegion label={t('DocumentEditorScreen.loadingVersion')}>
                  <Skeleton height="var(--row)" />
                </LoadingRegion>
              ) : null}
              {comparison.isError ? (
                <InlineAlert tone="danger" title={t('DocumentEditorScreen.loadVersionError')} live>
                  {describeError(comparison.error)}
                </InlineAlert>
              ) : null}
              {comparison.data ? (
                <>
                  <pre
                    className="tm-doc-snapshot tm-dx-compare__block"
                    aria-label={`${t('DocumentEditorScreen.bodyOfVersionPrefix')}${selectedVersion}`}
                  >
                    {comparison.data.body}
                  </pre>
                  <p className="tm-dx-note">{t('DocumentEditorScreen.restoreNote')}</p>
                </>
              ) : null}
            </section>
          ) : null}
        </section>
      </div>
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
