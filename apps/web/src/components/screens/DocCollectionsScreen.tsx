'use client';

import { useRef, useState } from 'react';
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
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { appLocale } from '../../lib/i18n/app-locale';

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
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);

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
      eyebrow={t('DocCollectionsScreen.eyebrow')}
      title={t('DocCollectionsScreen.title')}
      actions={
        <Link className="tm-dx-back" href={`/${organizationSlug}/docs`}>
          <span className="tm-dx-back__orb" aria-hidden="true">
            ←
          </span>
          {t('DocCollectionsScreen.backToDocs')}
        </Link>
      }
    >
      <div className="tm-dx tm-dx-split">
        <div className="tm-dx-split__main">
          <section className="tm-dx" aria-labelledby="tm-collection-pick-heading">
            <h2 id="tm-collection-pick-heading" className="tm-dx-caption">
              {t('DocCollectionsScreen.collectionHeading')}
              {rows.length > 0 ? ` · ${rows.length}` : ''}
            </h2>

            {collections.isError ? (
              <InlineAlert
                tone="danger"
                title={t('DocCollectionsScreen.loadCollectionsError')}
                live
              >
                {describeError(collections.error)}
              </InlineAlert>
            ) : null}

            {collections.isPending ? (
              <LoadingRegion label={t('DocCollectionsScreen.loadingCollections')}>
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {!collections.isPending && !collections.isError && rows.length === 0 ? (
              <TeachingEmptyState
                title={t('DocCollectionsScreen.emptyCollectionsTitle')}
                explanation={t('teachEmpty.docCollectionsBody')}
                action={
                  canUse('doc.write') ? (
                    <Button
                      tone="lime"
                      size="accessible"
                      onClick={() => focusFirstField(firstStep.current)}
                    >
                      {t('teachEmpty.docCollectionsAction')}
                    </Button>
                  ) : undefined
                }
              />
            ) : null}

            {rows.length > 0 ? (
              <div
                className="tm-dx-chips"
                role="group"
                aria-label={t('DocCollectionsScreen.showDocsAria')}
              >
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
                {selected ? selected.name : t('DocCollectionsScreen.documentsHeading')}
                {memberRows.length > 0 ? ` · ${memberRows.length}` : ''}
              </h2>

              {documents.isError ? (
                <InlineAlert
                  tone="danger"
                  title={t('DocCollectionsScreen.loadCollectionError')}
                  live
                >
                  {describeError(documents.error)}
                </InlineAlert>
              ) : null}

              {documents.isPending ? (
                <LoadingRegion label={t('DocCollectionsScreen.loadingDocuments')}>
                  <Skeleton height="var(--row)" />
                </LoadingRegion>
              ) : null}

              {!documents.isPending && !documents.isError && memberRows.length === 0 ? (
                <div className="tm-dx-empty">
                  <p className="tm-dx-empty__title">{t('DocCollectionsScreen.emptyDocsTitle')}</p>
                  <p className="tm-dx-empty__body">{t('DocCollectionsScreen.emptyDocsBody')}</p>
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
                  aria-label={`${t('DocCollectionsScreen.documentsInAria')}${selected?.name ?? t('DocCollectionsScreen.theCollection')}`}
                >
                  <table className="tm-dx-table">
                    <caption className="tm-visually-hidden">
                      {t('DocCollectionsScreen.captionPrefix')} {memberRows.length}{' '}
                      {t('DocCollectionsScreen.captionSuffix')}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('DocCollectionsScreen.thDocument')}</th>
                        <th scope="col" className="tm-dx-table__end">
                          {t('DocCollectionsScreen.thAdded')}
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
                            {new Date(document.createdAt).toLocaleString(appLocale())}
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

        <aside className="tm-dx-split__side" aria-label={t('DocCollectionsScreen.createAsideAria')}>
          <section
            className="tm-dx-card tm-dx-card--dashed"
            aria-labelledby="tm-collection-new-heading"
          >
            <h2 id="tm-collection-new-heading" className="tm-dx-card__title">
              {t('DocCollectionsScreen.newCollection')}
            </h2>
            <form
              ref={firstStep}
              className="tm-dx-form"
              noValidate
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                if (canCreate) create.mutate();
              }}
            >
              <Field
                label={t('DocCollectionsScreen.name')}
                name="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                hint={t('DocCollectionsScreen.nameHint')}
                required
              />
              {create.isError ? (
                <InlineAlert tone="danger" title={t('DocCollectionsScreen.createError')} live>
                  {describeError(create.error)}
                </InlineAlert>
              ) : null}
              <Button
                type="submit"
                tone="ink"
                size="default"
                loading={create.isPending}
                loadingLabel={t('DocCollectionsScreen.creating')}
                disabled={!canCreate}
              >
                {t('DocCollectionsScreen.createCollection')}
              </Button>
            </form>
          </section>

          <div className="tm-dx-info">
            <span className="tm-dx-info__orb" aria-hidden="true">
              i
            </span>
            <p>{t('DocCollectionsScreen.infoNote')}</p>
          </div>
        </aside>
      </div>
    </AppShell>
  );
}
