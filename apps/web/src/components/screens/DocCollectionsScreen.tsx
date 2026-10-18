'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/docs.css';
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
  const [pickedId, setSelectedId] = useState('');

  const create = useMutation({
    mutationFn: () => createDocCollection(api, organizationSlug, name.trim()),
    onSuccess: async (collection) => {
      setName('');
      setSelectedId(collection.id);
      await queryClient.invalidateQueries({ queryKey: ['doc-collections', organizationSlug] });
    },
  });

  const rows = collections.data ?? [];
  // The first collection opens when none was picked, so the screen shows a collection's
  // documents rather than an empty chooser whenever one exists.
  const selectedId = pickedId !== '' ? pickedId : (rows[0]?.id ?? '');

  const documents = useQuery({
    queryKey: ['doc-collection-documents', organizationSlug, selectedId],
    queryFn: () => listCollectionDocuments(api, organizationSlug, selectedId),
    enabled: selectedId !== '',
  });

  const memberRows = documents.data ?? [];
  const canCreate = name.trim() !== '' && !create.isPending;
  const selected = rows.find((collection) => collection.id === selectedId) ?? null;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="docs"
      eyebrow="Docs · Collections"
      title="Collections"
      actions={
        <Link className="tm-dx-back" href={`/${organizationSlug}/docs`}>
          <span className="tm-dx-back__orb" aria-hidden="true">
            ←
          </span>
          Back to Docs
        </Link>
      }
    >
      <div className="tm-dx tm-dx-split">
        <div className="tm-dx-split__main">
          <section className="tm-dx" aria-labelledby="tm-collection-pick-heading">
            <h2 id="tm-collection-pick-heading" className="tm-dx-caption">
              Collection{rows.length > 0 ? ` · ${rows.length}` : ''}
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
              <div className="tm-dx-empty">
                <p className="tm-dx-empty__title">No collections yet</p>
                <p className="tm-dx-empty__body">
                  Create a collection with the form beside this list to start grouping documents.
                </p>
              </div>
            ) : null}

            {rows.length > 0 ? (
              <div className="tm-dx-chips" role="group" aria-label="Show the documents in">
                {rows.map((collection) => (
                  <button
                    key={collection.id}
                    type="button"
                    className="tm-chip"
                    aria-pressed={collection.id === selectedId}
                    onClick={() => setSelectedId(collection.id)}
                  >
                    {collection.name}
                  </button>
                ))}
              </div>
            ) : null}
          </section>

          {selectedId !== '' ? (
            <section className="tm-dx" aria-labelledby="tm-collection-detail-heading">
              <h2 id="tm-collection-detail-heading" className="tm-dx-caption">
                {selected ? selected.name : 'Documents'}
                {memberRows.length > 0 ? ` · ${memberRows.length}` : ''}
              </h2>

              {documents.isError ? (
                <InlineAlert tone="danger" title="Could not load this collection" live>
                  {describeError(documents.error)}
                </InlineAlert>
              ) : null}

              {documents.isPending ? (
                <LoadingRegion label="Loading documents.">
                  <Skeleton height="var(--row)" />
                </LoadingRegion>
              ) : null}

              {!documents.isPending && !documents.isError && memberRows.length === 0 ? (
                <div className="tm-dx-empty">
                  <p className="tm-dx-empty__title">No documents in this collection</p>
                  <p className="tm-dx-empty__body">
                    Add a document from the document itself to see it here.
                  </p>
                </div>
              ) : null}

              {memberRows.length > 0 ? (
                <div
                  className="tm-dx-table-card"
                  // A scrollable region must be focusable or a keyboard cannot reach its overflow
                  // columns (WCAG 2.2 2.1.1), matching the other screens' tables.
                  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                  tabIndex={0}
                  role="region"
                  aria-label={`Documents in ${selected?.name ?? 'the collection'}`}
                >
                  <table className="tm-dx-table">
                    <caption className="tm-visually-hidden">
                      Documents in this collection, {memberRows.length} shown.
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Document</th>
                        <th scope="col" className="tm-dx-table__end">
                          Added
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {memberRows.map((document) => (
                        <tr key={document.id}>
                          <th scope="row" className="tm-dx-table__title">
                            <Link href={`/${organizationSlug}/docs/${document.id}`}>
                              {document.title}
                            </Link>
                          </th>
                          <td className="tm-dx-table__end tm-dx-table__mono">
                            {new Date(document.createdAt).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>

        <aside className="tm-dx-split__side" aria-label="Create a collection">
          <section
            className="tm-dx-card tm-dx-card--dashed"
            aria-labelledby="tm-collection-new-heading"
          >
            <h2 id="tm-collection-new-heading" className="tm-dx-card__title">
              New collection
            </h2>
            <form
              className="tm-dx-form"
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
              <Button
                type="submit"
                tone="ink"
                size="default"
                loading={create.isPending}
                loadingLabel="Creating"
                disabled={!canCreate}
              >
                Create collection
              </Button>
            </form>
          </section>

          <div className="tm-dx-info">
            <span className="tm-dx-info__orb" aria-hidden="true">
              i
            </span>
            <p>
              A collection only lists the documents you can still read. Documents are added from the
              document itself.
            </p>
          </div>
        </aside>
      </div>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
