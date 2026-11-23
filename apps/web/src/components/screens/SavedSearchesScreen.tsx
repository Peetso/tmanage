'use client';

import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import { appDateLocale, appLocale } from '../../lib/i18n/app-locale';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createSavedSearch,
  deleteSavedSearch,
  listRecentSearches,
  listSavedSearches,
} from '../../lib/api/saved-searches';
import type { SavedSearch } from '../../lib/api/saved-searches';
import { search } from '../../lib/api/search';
import type { SearchResultKind } from '../../lib/api/search';
import type { ApiClient } from '../../lib/api/client';
import { shortRef } from './SearchScreen';
import { useDescribeApiError } from '../../lib/api/describe-error';
import '../../styles/screens/search-ai.css';

export interface SavedSearchesScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Prefill the new-search form — how SR-02's "Save this search" hands over its query. */
  initialQuery?: string;
  client?: ApiClient;
}

const KIND_LABEL: Readonly<Record<SearchResultKind, string>> = {
  work_item: 'Work item',
  document: 'Document',
  meeting: 'Meeting',
  message: 'Message',
  decision: 'Decision',
  project: 'Project',
  invoice: 'Invoice',
  quote: 'Quote',
  expense: 'Expense',
  file: 'File',
};

/** "13 Aug" in English; the active locale's month names and digits elsewhere (C1). */
const DATE = {
  format(at: Date): string {
    const locale = appLocale();
    const tag = appDateLocale(locale);
    return new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short' }).format(at);
  },
};

/**
 * **SRCH saved & recent searches (x214)** — drawn as SR-04 Saved search: the saved list in a
 * paper column on the start side, and the selected search as a standing question on the right —
 * its name as the headline, its query as capsules and its current results in a table.
 *
 * Everything here is the caller's own: the API scopes each read, the delete and the recent prune by
 * tenant and owner, so the screen renders what it is given. The results table re-runs the saved
 * query through the same permission-filtered search endpoint SR-02 uses. The design's digest
 * schedule and sharing are not drawn: no endpoint stores either yet.
 */
export function SavedSearchesScreen({
  organizationSlug,
  organizationName,
  initialQuery,
  client,
}: SavedSearchesScreenProps) {
  const describeError = useDescribeApiError();
  const t = useT();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const [name, setName] = useState('');
  const [query, setQuery] = useState(initialQuery ?? '');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composing, setComposing] = useState(initialQuery !== undefined && initialQuery !== '');

  const savedKey = ['saved-searches', organizationSlug];
  const recentKey = ['recent-searches', organizationSlug];

  const saved = useQuery({
    queryKey: savedKey,
    queryFn: () => listSavedSearches(api, organizationSlug),
  });
  const recent = useQuery({
    queryKey: recentKey,
    queryFn: () => listRecentSearches(api, organizationSlug),
  });

  const savedList = saved.data ?? [];
  const recentList = recent.data ?? [];
  const selected: SavedSearch | undefined =
    savedList.find((item) => item.id === selectedId) ?? savedList[0];
  const showForm = composing || (!saved.isPending && !saved.isError && savedList.length === 0);

  const results = useQuery({
    queryKey: ['search', organizationSlug, selected?.query ?? ''],
    queryFn: () => search(api, organizationSlug, { q: selected!.query }),
    enabled: selected !== undefined && selected.query.trim() !== '',
  });

  const create = useMutation({
    mutationFn: () =>
      createSavedSearch(api, organizationSlug, { name: name.trim(), query: query.trim() }),
    onSuccess: (created) => {
      setName('');
      setQuery('');
      setComposing(false);
      if (created?.id) setSelectedId(created.id);
      void queries.invalidateQueries({ queryKey: savedKey });
    },
  });

  const remove = useMutation({
    mutationFn: (savedSearchId: string) => deleteSavedSearch(api, organizationSlug, savedSearchId),
    onSuccess: () => {
      setSelectedId(null);
      void queries.invalidateQueries({ queryKey: savedKey });
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim() === '' || query.trim() === '') return;
    create.mutate();
  }

  const searchHref = (q: string) => `/${organizationSlug}/search?q=${encodeURIComponent(q)}`;
  const hits = results.data ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title={t('SavedSearchesScreen.title')}
    >
      <div className="tm-sa-saved tm-sa-headerless">
        <div className="tm-sa-saved__rail">
          <section className="tm-stack" aria-labelledby="tm-saved-list">
            <h2 id="tm-saved-list" className="tm-sa-eyebrow">
              {t('SavedSearchesScreen.savedListHeading')}
              {savedList.length > 0 ? ` · ${savedList.length}` : ''}
            </h2>
            {saved.isError ? (
              <InlineAlert tone="danger" title={t('SavedSearchesScreen.savedLoadError')} live>
                {describeError(saved.error)}
              </InlineAlert>
            ) : null}
            {saved.isPending ? (
              <LoadingRegion label={t('SavedSearchesScreen.savedLoading')}>
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}
            {!saved.isPending && !saved.isError && savedList.length === 0 ? (
              <TeachingEmptyState
                title={t('SavedSearchesScreen.savedEmptyTitle')}
                explanation={t('teachEmpty.savedSearchesBody')}
                action={
                  canUse('search.use') ? (
                    <Button
                      tone="lime"
                      size="accessible"
                      onClick={() => focusFirstField(firstStep.current)}
                    >
                      {t('teachEmpty.savedSearchesAction')}
                    </Button>
                  ) : undefined
                }
              />
            ) : null}
            {savedList.length > 0 ? (
              <ul className="tm-sa-saved__list" aria-label={t('SavedSearchesScreen.savedListAria')}>
                {savedList.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="tm-sa-saved-item"
                      aria-current={item.id === selected?.id ? 'true' : undefined}
                      onClick={() => {
                        setSelectedId(item.id);
                        setComposing(false);
                      }}
                    >
                      <span className="tm-sa-saved-item__name">{item.name}</span>
                      <span className="tm-sa-saved-item__meta">
                        “{item.query}”
                        {item.filters.length > 0
                          ? ` · ${item.filters.length} ${item.filters.length === 1 ? t('SavedSearchesScreen.filterSingular') : t('SavedSearchesScreen.filterPlural')}`
                          : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className="tm-stack" aria-labelledby="tm-recent-list">
            <h2 id="tm-recent-list" className="tm-sa-eyebrow">
              {t('SavedSearchesScreen.recentHeading')}
            </h2>
            {recent.isPending ? (
              <LoadingRegion label={t('SavedSearchesScreen.recentLoading')}>
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}
            {!recent.isPending && !recent.isError && recentList.length === 0 ? (
              <p className="tm-sa-saved-item__meta">{t('SavedSearchesScreen.recentEmpty')}</p>
            ) : null}
            {recentList.length > 0 ? (
              <ul
                className="tm-sa-saved__list"
                aria-label={t('SavedSearchesScreen.recentListAria')}
              >
                {recentList.map((item) => (
                  <li key={`${item.searchedAt}:${item.query}`}>
                    <Link href={searchHref(item.query)} className="tm-sa-saved-item">
                      <span className="tm-sa-saved-item__name">{item.query}</span>
                      <span className="tm-sa-saved-item__meta">
                        {DATE.format(new Date(item.searchedAt))}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <div className="tm-sa-saved__foot">
            <button
              type="button"
              className="tm-sa-capsule"
              aria-expanded={showForm}
              aria-controls="tm-saved-search-form"
              onClick={() => setComposing(true)}
            >
              {t('SavedSearchesScreen.newSavedSearch')}
            </button>
          </div>
        </div>

        <div className="tm-sa-saved__main">
          {showForm ? (
            <div className="tm-sa-saved__titles">
              <p className="tm-sa-saved__eyebrow">{t('SavedSearchesScreen.formEyebrow')}</p>
              <p className="tm-sa-saved__title" aria-hidden="true">
                {t('SavedSearchesScreen.newSavedSearch')}
              </p>
            </div>
          ) : null}
          {showForm ? (
            <section
              id="tm-saved-search-form"
              className="tm-sa-form"
              aria-labelledby="tm-saved-search-form-title"
            >
              <h2 id="tm-saved-search-form-title" className="tm-sa-eyebrow">
                {t('SavedSearchesScreen.formHeading')}
              </h2>
              <form noValidate ref={firstStep} className="tm-stack" onSubmit={onSubmit}>
                <div className="tm-sa-form__fields">
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-saved-name">
                      {t('SavedSearchesScreen.nameLabel')}
                    </label>
                    <input
                      id="tm-saved-name"
                      className="tm-field__control"
                      type="text"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder={t('SavedSearchesScreen.namePlaceholder')}
                    />
                  </div>
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-saved-query">
                      {t('SavedSearchesScreen.queryLabel')}
                    </label>
                    <input
                      id="tm-saved-query"
                      className="tm-field__control"
                      type="search"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder={t('SavedSearchesScreen.queryPlaceholder')}
                    />
                  </div>
                </div>
                <div className="tm-sa-form__actions">
                  <Button
                    type="submit"
                    tone="ink"
                    disabled={name.trim() === '' || query.trim() === '' || create.isPending}
                  >
                    {t('SavedSearchesScreen.saveSearch')}
                  </Button>
                  {savedList.length > 0 ? (
                    <Button type="button" tone="outline" onClick={() => setComposing(false)}>
                      {t('SavedSearchesScreen.cancel')}
                    </Button>
                  ) : null}
                </div>
                {create.isError ? (
                  <InlineAlert tone="danger" title={t('SavedSearchesScreen.saveError')} live>
                    {describeError(create.error)}
                  </InlineAlert>
                ) : null}
              </form>
            </section>
          ) : null}

          {selected && !showForm ? (
            <>
              <div className="tm-sa-saved__head">
                <div className="tm-sa-saved__titles">
                  <p className="tm-sa-saved__eyebrow">
                    {t('SavedSearchesScreen.savedOnPrefix')}{' '}
                    {DATE.format(new Date(selected.createdAt))}
                  </p>
                  <h2 className="tm-sa-saved__title">{selected.name}</h2>
                </div>
                <div className="tm-sa-saved__actions">
                  <button
                    type="button"
                    className="tm-sa-capsule"
                    onClick={() => remove.mutate(selected.id)}
                    disabled={remove.isPending}
                  >
                    {t('SavedSearchesScreen.delete')}
                  </button>
                  <Link
                    href={searchHref(selected.query)}
                    className="tm-sa-capsule tm-sa-capsule--ink"
                  >
                    {t('SavedSearchesScreen.openInSearch')}
                  </Link>
                </div>
              </div>

              {remove.isError ? (
                <InlineAlert tone="danger" title={t('SavedSearchesScreen.deleteError')} live>
                  {describeError(remove.error)}
                </InlineAlert>
              ) : null}

              <div className="tm-sa-query">
                <p id="tm-saved-query-label" className="tm-sa-eyebrow">
                  {t('SavedSearchesScreen.queryEyebrow')}
                </p>
                <ul className="tm-sa-query" aria-labelledby="tm-saved-query-label">
                  <li className="tm-sa-query__chip">“{selected.query}”</li>
                  {selected.filters.map((filter) => (
                    <li key={`${filter.field}:${filter.value}`} className="tm-sa-query__chip">
                      {filter.field} = {filter.value}
                    </li>
                  ))}
                </ul>
              </div>

              <section
                className="tm-sa-table"
                aria-label={t('SavedSearchesScreen.currentResultsAria')}
              >
                {results.isPending ? (
                  <LoadingRegion label={t('SavedSearchesScreen.runningSearch')}>
                    <Skeleton height="var(--row)" />
                    <Skeleton height="var(--row)" />
                  </LoadingRegion>
                ) : null}
                {results.isError ? (
                  <InlineAlert tone="danger" title={t('SavedSearchesScreen.runError')} live>
                    {describeError(results.error)}
                  </InlineAlert>
                ) : null}
                {!results.isPending && !results.isError && hits.length === 0 ? (
                  <div className="tm-sa-empty">
                    <p className="tm-sa-empty__title">{t('SavedSearchesScreen.noMatchTitle')}</p>
                    <p className="tm-sa-empty__body">
                      {t('SavedSearchesScreen.noMatchBodyBefore')}“{selected.query}”
                      {t('SavedSearchesScreen.noMatchBodyAfter')}
                    </p>
                  </div>
                ) : null}
                {hits.length > 0 ? (
                  <table className="tm-sa-table__grid">
                    <thead>
                      <tr>
                        <th scope="col">{t('SavedSearchesScreen.itemCol')}</th>
                        <th scope="col">{t('SavedSearchesScreen.typeCol')}</th>
                        <th scope="col">{t('SavedSearchesScreen.referenceCol')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {hits.map((hit) => (
                        <tr key={`${hit.kind}:${hit.id}`}>
                          <td className="tm-sa-table__item">
                            {hit.kind === 'work_item' ? (
                              <Link href={`/${organizationSlug}/work/${hit.id}`}>{hit.title}</Link>
                            ) : (
                              hit.title
                            )}
                          </td>
                          <td>{KIND_LABEL[hit.kind]}</td>
                          <td className="tm-sa-table__mono">{shortRef(hit.id)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
                <div className="tm-sa-table__foot">
                  <span>
                    {hits.length}{' '}
                    {hits.length === 1
                      ? t('SavedSearchesScreen.matchSingular')
                      : t('SavedSearchesScreen.matchPlural')}{' '}
                    {t('SavedSearchesScreen.filteredSuffix')}
                  </span>
                  <Link href={searchHref(selected.query)} className="tm-sa-link">
                    {t('SavedSearchesScreen.refineInSearch')}
                  </Link>
                </div>
              </section>
            </>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}
