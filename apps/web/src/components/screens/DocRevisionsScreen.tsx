'use client';

import { useRef, useState, type FormEvent } from 'react';
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
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { appIntlLocale } from '../../lib/i18n/app-locale';

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
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);

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
      title={t('DocRevisionsScreen.title')}
      description={t('DocRevisionsScreen.description')}
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-rev-new-heading">
        <h2 id="tm-rev-new-heading" className="tm-eyebrow">
          {t('DocRevisionsScreen.captureHeading')}
        </h2>
        <form
          ref={firstStep}
          className="tm-stack"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (canCapture) capture.mutate();
          }}
        >
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-rev-body">
              {t('DocRevisionsScreen.snapshotLabel')}
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
              {t('DocRevisionsScreen.snapshotHint')}
            </span>
          </div>

          {capture.isError ? (
            <InlineAlert tone="danger" title={t('DocRevisionsScreen.captureError')} live>
              {describeError(capture.error)}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={capture.isPending}
              loadingLabel={t('DocRevisionsScreen.capturing')}
              disabled={!canCapture}
            >
              {t('DocRevisionsScreen.captureButton')}
            </Button>
          </div>
        </form>
      </section>

      <section
        className="tm-panel tm-panel--quiet tm-stack"
        aria-labelledby="tm-rev-history-heading"
      >
        <h2 id="tm-rev-history-heading" className="tm-eyebrow">
          {document.data ? document.data.title : t('DocRevisionsScreen.historyHeading')}
        </h2>

        {restore.isError ? (
          <InlineAlert tone="danger" title={t('DocRevisionsScreen.restoreError')} live>
            {describeError(restore.error)}
          </InlineAlert>
        ) : null}

        {revisions.isError ? (
          <InlineAlert tone="danger" title={t('DocRevisionsScreen.loadError')} live>
            {describeError(revisions.error)}
          </InlineAlert>
        ) : null}

        {revisions.isPending ? (
          <LoadingRegion label={t('DocRevisionsScreen.loading')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!revisions.isPending && !revisions.isError && rows.length === 0 ? (
          <TeachingEmptyState
            title={t('DocRevisionsScreen.emptyTitle')}
            explanation={t('teachEmpty.docRevisionsBody')}
            action={
              canUse('doc.write') ? (
                <Button
                  tone="lime"
                  size="accessible"
                  onClick={() => focusFirstField(firstStep.current)}
                >
                  {t('teachEmpty.docRevisionsAction')}
                </Button>
              ) : undefined
            }
          />
        ) : null}

        {rows.length > 0 ? (
          <div
            className="tm-table-scroll"
            // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
            // (WCAG 2.2 2.1.1), matching the other screens' tables.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label={t('DocRevisionsScreen.tableAria')}
          >
            <table className="tm-table">
              <caption className="tm-visually-hidden">
                {t('DocRevisionsScreen.captionPrefix')} {rows.length}{' '}
                {t('DocRevisionsScreen.captionSuffix')}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t('DocRevisionsScreen.thRevision')}</th>
                  <th scope="col">{t('DocRevisionsScreen.thSavedBy')}</th>
                  <th scope="col">{t('DocRevisionsScreen.thSavedAt')}</th>
                  <th scope="col">{t('DocRevisionsScreen.thActions')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((revision) => (
                  <tr key={revision.id}>
                    <th scope="row" className="tm-table__title">
                      #{revision.revNo}
                    </th>
                    <td>{revision.savedBy}</td>
                    <td>{new Date(revision.savedAt).toLocaleString(appIntlLocale())}</td>
                    <td>
                      <Button
                        type="button"
                        tone="outline"
                        size="accessible"
                        loading={restore.isPending && restore.variables === revision.id}
                        loadingLabel={t('DocRevisionsScreen.restoring')}
                        onClick={() => restore.mutate(revision.id)}
                      >
                        {t('DocRevisionsScreen.restore')}
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
