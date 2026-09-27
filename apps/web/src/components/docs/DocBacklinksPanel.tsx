'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { addDocLink, listDocBacklinks, listDocLinks, removeDocLink } from '../../lib/api/doc-links';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import type { DocLinkSummary } from '../../lib/api/doc-links';

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
          Links
        </h2>

        <form
          className="tm-stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed !== '') {
              add.mutate(trimmed);
            }
          }}
        >
          <label className="tm-field" htmlFor="tm-doc-link-target">
            <span className="tm-field__label">Link to a document</span>
            <input
              id="tm-doc-link-target"
              className="tm-input"
              value={targetDocId}
              onChange={(event) => setTargetDocId(event.target.value)}
              placeholder="Target document id"
              autoComplete="off"
            />
          </label>
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={add.isPending}
            loadingLabel="Linking"
            disabled={trimmed === ''}
          >
            Add link
          </Button>
        </form>

        {add.isError ? (
          <InlineAlert tone="danger" title="Could not add the link" live>
            {describeError(add.error)}
          </InlineAlert>
        ) : null}

        <LinkList
          label="Linked documents"
          caption="The documents this one links to, newest first."
          empty="No links yet. Add one above."
          query={links}
          removable
          onRemove={(target) => remove.mutate(target)}
          removePending={remove.isPending}
        />
        {remove.isError ? (
          <InlineAlert tone="danger" title="Could not remove the link" live>
            {describeError(remove.error)}
          </InlineAlert>
        ) : null}
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-doc-backlinks-heading">
        <h2 id="tm-doc-backlinks-heading" className="tm-eyebrow">
          Linked from
        </h2>
        <LinkList
          label="Documents linking here"
          caption="The documents that link to this one, newest first."
          empty="No documents link here yet."
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
  const rows = query.data ?? [];

  return (
    <>
      {query.isError ? (
        <InlineAlert tone="danger" title="Could not load the links" live>
          {describeError(query.error)}
        </InlineAlert>
      ) : null}

      {query.isPending ? (
        <LoadingRegion label="Loading links.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!query.isPending && !query.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="No links">
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
              {caption} {rows.length} shown.
            </caption>
            <thead>
              <tr>
                <th scope="col">Document</th>
                <th scope="col">Linked at</th>
                {removable ? <th scope="col">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((link) => (
                <tr key={link.id}>
                  <th scope="row" className="tm-table__title">
                    {link.title}
                  </th>
                  <td>{new Date(link.createdAt).toLocaleString()}</td>
                  {removable ? (
                    <td>
                      <Button
                        type="button"
                        tone="outline"
                        size="accessible"
                        disabled={removePending}
                        onClick={() => onRemove?.(link.docId)}
                      >
                        Remove
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

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
