'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createDocCollection,
  listCollectionDocuments,
  listDocCollections,
} from '../../lib/api/doc-collections';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface DocCollectionsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **DOC collections (x264).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §"Docs and knowledge" (wiki / spaces), DOC-01 hub — group
 * documents into named collections. One panel lists and creates collections; choosing a collection
 * shows the documents it holds.
 *
 * ## What it does, and what it cannot
 *
 * - **Collections are named and created here.** A duplicate name is refused by the API (409), surfaced
 *   inline.
 * - **The document list is read-scoped.** The API projects a collection's documents to those the caller
 *   can still read, so no title the caller may not see leaks here.
 * - **Adding a document to a collection happens from the document itself.** This screen lists; the
 *   per-document control performs the add and remove.
 */
export function DocCollectionsScreen({
  organizationSlug,
  organizationName,
  client,
}: DocCollectionsScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const collections = useQuery({
    queryKey: ['doc-collections', organizationSlug],
    queryFn: () => listDocCollections(api, organizationSlug),
  });

  const [name, setName] = useState('');
  const [selectedId, setSelectedId] = useState('');

  const create = useMutation({
    mutationFn: () => createDocCollection(api, organizationSlug, name.trim()),
    onSuccess: async (collection) => {
      setName('');
      setSelectedId(collection.id);
      await queryClient.invalidateQueries({ queryKey: ['doc-collections', organizationSlug] });
    },
  });

  const documents = useQuery({
    queryKey: ['doc-collection-documents', organizationSlug, selectedId],
    queryFn: () => listCollectionDocuments(api, organizationSlug, selectedId),
    enabled: selectedId !== '',
  });

  const rows = collections.data ?? [];
  const memberRows = documents.data ?? [];
  const canCreate = name.trim() !== '' && !create.isPending;
  const selected = rows.find((collection) => collection.id === selectedId) ?? null;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="docs"
      title="Document collections"
      description="Group documents into named collections, like lightweight spaces or a team wiki."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-collection-new-heading">
        <h2 id="tm-collection-new-heading" className="tm-eyebrow">
          New collection
        </h2>
        <form
          className="tm-stack"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (canCreate) create.mutate();
          }}
        >
          <Field
            label="Name"
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            hint="A short name, such as Onboarding or Runbooks."
            required
          />
          {create.isError ? (
            <InlineAlert tone="danger" title="Could not create the collection" live>
              {describeError(create.error)}
            </InlineAlert>
          ) : null}
          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={create.isPending}
              loadingLabel="Creating"
              disabled={!canCreate}
            >
              Create collection
            </Button>
          </div>
        </form>
      </section>

      <section
        className="tm-panel tm-panel--quiet tm-stack"
        aria-labelledby="tm-collection-pick-heading"
      >
        <h2 id="tm-collection-pick-heading" className="tm-eyebrow">
          Collection
        </h2>

        {collections.isError ? (
          <InlineAlert tone="danger" title="Could not load your collections" live>
            {describeError(collections.error)}
          </InlineAlert>
        ) : null}

        {collections.isPending ? (
          <LoadingRegion label="Loading collections.">
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!collections.isPending && !collections.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title="No collections yet">
            Create a collection above to start grouping documents.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-collection-select">
              Show the documents in
            </label>
            <select
              id="tm-collection-select"
              className="tm-field__control"
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              <option value="">Choose a collection…</option>
              {rows.map((collection) => (
                <option key={collection.id} value={collection.id}>
                  {collection.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-collection-detail-heading">
        <h2 id="tm-collection-detail-heading" className="tm-eyebrow">
          {selected ? selected.name : 'Documents'}
        </h2>

        {selectedId === '' ? (
          <InlineAlert tone="neutral" title="Select a collection">
            Choose a collection above to see the documents it holds.
          </InlineAlert>
        ) : null}

        {documents.isError ? (
          <InlineAlert tone="danger" title="Could not load this collection" live>
            {describeError(documents.error)}
          </InlineAlert>
        ) : null}

        {selectedId !== '' && documents.isPending ? (
          <LoadingRegion label="Loading documents.">
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {selectedId !== '' &&
        !documents.isPending &&
        !documents.isError &&
        memberRows.length === 0 ? (
          <InlineAlert tone="neutral" title="No documents in this collection">
            Add a document from the document itself to see it here.
          </InlineAlert>
        ) : null}

        {memberRows.length > 0 ? (
          <div
            className="tm-table-scroll"
            // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
            // (WCAG 2.2 2.1.1), matching the other screens' tables.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label={`Documents in ${selected?.name ?? 'the collection'}`}
          >
            <table className="tm-table">
              <caption className="tm-visually-hidden">
                Documents in this collection, {memberRows.length} shown.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Document</th>
                  <th scope="col">Added</th>
                </tr>
              </thead>
              <tbody>
                {memberRows.map((document) => (
                  <tr key={document.id}>
                    <th scope="row" className="tm-table__title">
                      {document.title}
                    </th>
                    <td>{new Date(document.createdAt).toLocaleString()}</td>
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
