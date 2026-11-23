'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import { addDocLink, listDocBacklinks, listDocLinks, removeDocLink } from '../../lib/api/doc-links';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import type { DocLinkSummary } from '../../lib/api/doc-links';
import { appIntlLocale } from '../../lib/i18n/app-locale';

export interface DocBacklinksPanelProps {
  organizationSlug: string;
  documentId: string;
  client?: ApiClient;
}

/**
 * **DOC links + backlinks (x296).**
 *
 * `22-SCREEN-INVENTORY` DOC document detail — the two relation panels beside a document. "Links" shows
 * the documents this one points at (an author adds/removes them, `doc.write`); "Linked from" is the
 * read-only backlinks list of documents that point here (`doc.read`). Both are projected by the API to
 * documents the caller can still read, so neither leaks a title the caller may not see.
 *
 * The add-link picker takes the target document's id: the API resolves it tenant-scoped and readable
 * before it links (a cross-tenant or unreadable target is a not-found refusal), and a self-link is
 * refused. On any change the two lists are invalidated so both reflect it without a manual refresh.
 */
export function DocBacklinksPanel({
  organizationSlug,
  documentId,
  client,
}: DocBacklinksPanelProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const queryClient = useQueryClient();
  const [targetDocId, setTargetDocId] = useState('');

  const links = useQuery({
    queryKey: ['doc-links', organizationSlug, documentId],
    queryFn: () => listDocLinks(api, organizationSlug, documentId),
  });
  const backlinks = useQuery({
    queryKey: ['doc-backlinks', organizationSlug, documentId],
    queryFn: () => listDocBacklinks(api, organizationSlug, documentId),
  });

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['doc-links', organizationSlug, documentId] }),
      queryClient.invalidateQueries({ queryKey: ['doc-backlinks', organizationSlug, documentId] }),
    ]);
  };

  const add = useMutation({
    mutationFn: async (target: string) => addDocLink(api, organizationSlug, documentId, target),
    onSuccess: async () => {
      setTargetDocId('');
      await invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: async (target: string) => removeDocLink(api, organizationSlug, documentId, target),
    onSuccess: invalidate,
  });

  const trimmed = targetDocId.trim();

  return (
    <div className="tm-stack">
      <section className="tm-panel tm-stack" aria-labelledby="tm-doc-links-heading">
        <h2 id="tm-doc-links-heading" className="tm-eyebrow">
          {t('DocBacklinksPanel.linksHeading')}
        </h2>

        <form
          noValidate
          className="tm-stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed !== '') {
              add.mutate(trimmed);
            }
          }}
        >
          <label className="tm-field" htmlFor="tm-doc-link-target">
            <span className="tm-field__label">{t('DocBacklinksPanel.linkToDocument')}</span>
            <input
              id="tm-doc-link-target"
              className="tm-input"
              value={targetDocId}
              onChange={(event) => setTargetDocId(event.target.value)}
              placeholder={t('DocBacklinksPanel.targetPlaceholder')}
              autoComplete="off"
            />
          </label>
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={add.isPending}
            loadingLabel={t('DocBacklinksPanel.linkingLabel')}
            disabled={trimmed === ''}
          >
            {t('DocBacklinksPanel.addLink')}
          </Button>
        </form>

        {add.isError ? (
          <InlineAlert tone="danger" title={t('DocBacklinksPanel.addErrorTitle')} live>
            {describeError(add.error, t)}
          </InlineAlert>
        ) : null}

        <LinkList
          label={t('DocBacklinksPanel.linkedDocumentsLabel')}
          caption={t('DocBacklinksPanel.linkedCaption')}
          empty={t('DocBacklinksPanel.linkedEmpty')}
          query={links}
          removable
          onRemove={(target) => remove.mutate(target)}
          removePending={remove.isPending}
        />
        {remove.isError ? (
          <InlineAlert tone="danger" title={t('DocBacklinksPanel.removeErrorTitle')} live>
            {describeError(remove.error, t)}
          </InlineAlert>
        ) : null}
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-doc-backlinks-heading">
        <h2 id="tm-doc-backlinks-heading" className="tm-eyebrow">
          {t('DocBacklinksPanel.linkedFromHeading')}
        </h2>
        <LinkList
          label={t('DocBacklinksPanel.backlinksLabel')}
          caption={t('DocBacklinksPanel.backlinksCaption')}
          empty={t('DocBacklinksPanel.backlinksEmpty')}
          query={backlinks}
        />
      </section>
    </div>
  );
}

interface LinkListProps {
  label: string;
  caption: string;
  empty: string;
  query: {
    isPending: boolean;
    isError: boolean;
    error: unknown;
    data: readonly DocLinkSummary[] | undefined;
  };
  removable?: boolean;
  onRemove?: (targetDocId: string) => void;
  removePending?: boolean;
}

function LinkList({
  label,
  caption,
  empty,
  query,
  removable = false,
  onRemove,
  removePending = false,
}: LinkListProps) {
  const t = useT();
  const rows = query.data ?? [];

  return (
    <>
      {query.isError ? (
        <InlineAlert tone="danger" title={t('DocBacklinksPanel.loadErrorTitle')} live>
          {describeError(query.error, t)}
        </InlineAlert>
      ) : null}

      {query.isPending ? (
        <LoadingRegion label={t('DocBacklinksPanel.loadingLinks')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!query.isPending && !query.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title={t('DocBacklinksPanel.noLinksTitle')}>
          {empty}
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
          aria-label={label}
        >
          <table className="tm-table">
            <caption className="tm-visually-hidden">
              {caption} {rows.length} {t('DocBacklinksPanel.shownSuffix')}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('DocBacklinksPanel.columnDocument')}</th>
                <th scope="col">{t('DocBacklinksPanel.columnLinkedAt')}</th>
                {removable ? <th scope="col">{t('DocBacklinksPanel.columnActions')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((link) => (
                <tr key={link.id}>
                  <th scope="row" className="tm-table__title">
                    {link.title}
                  </th>
                  <td>{new Date(link.createdAt).toLocaleString(appIntlLocale())}</td>
                  {removable ? (
                    <td>
                      <Button
                        type="button"
                        tone="outline"
                        size="accessible"
                        disabled={removePending}
                        onClick={() => onRemove?.(link.docId)}
                      >
                        {t('DocBacklinksPanel.remove')}
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

function describeError(error: unknown, t: ReturnType<typeof useT>): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('DocBacklinksPanel.apiNoAnswer');
  return t('DocBacklinksPanel.genericError');
}
