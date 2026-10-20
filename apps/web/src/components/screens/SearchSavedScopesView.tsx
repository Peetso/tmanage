'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { useT } from '../../lib/i18n/use-t';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createSearchScope,
  deleteSearchScope,
  listSearchScopes,
  type SearchScope,
} from '../../lib/api/saved-scopes';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

/** The current search filter set the view can save as a new scope. */
export interface CurrentScopeFilters {
  readonly objectTypes: readonly string[];
  readonly projectId?: string;
  readonly from?: string;
  readonly to?: string;
}

export interface SearchSavedScopesViewProps {
  organizationSlug: string;
  /** The filters currently applied on the search view, offered as "save current scope". */
  currentFilters?: CurrentScopeFilters;
  /** Called when the member picks a saved scope to apply — the search re-runs pre-filtered. */
  onApply?: (scope: SearchScope) => void;
  client?: ApiClient;
}

/**
 * **SRCH saved scopes (x334).**
 *
 * The saved-scope strip on the search view: a member's own named filter scopes as chips (click to
 * apply — the search re-runs pre-filtered), plus a save-current-scope control that names and stores
 * the filters currently applied. A scope is a reusable filter set, not a saved query; applying one
 * hands its filters back to the search read (the `onApply` callback).
 *
 * Every scope is the caller's own — the API scopes each read, the create and the delete by tenant and
 * owner — so this view renders what it is given without a second check, and a delete is idempotent
 * (a gone scope is simply absent on the next list).
 */
export function SearchSavedScopesView({
  organizationSlug,
  currentFilters,
  onApply,
  client,
}: SearchSavedScopesViewProps) {
  const t = useT();
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const scopesKey = ['search-scopes', organizationSlug];
  const [name, setName] = useState('');

  const scopes = useQuery({
    queryKey: scopesKey,
    queryFn: () => listSearchScopes(api, organizationSlug),
  });

  const save = useMutation({
    mutationFn: (scopeName: string) =>
      createSearchScope(api, organizationSlug, {
        name: scopeName,
        filters: currentFilters ?? { objectTypes: [] },
      }),
    onSuccess: () => {
      setName('');
      void queries.invalidateQueries({ queryKey: scopesKey });
    },
  });

  const remove = useMutation({
    mutationFn: (scopeId: string) => deleteSearchScope(api, organizationSlug, scopeId),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: scopesKey });
    },
  });

  const list = scopes.data ?? [];
  const trimmed = name.trim();

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-search-scopes">
      <h2 id="tm-search-scopes" className="tm-eyebrow">
        {t('SearchSavedScopesView.heading')}
      </h2>

      {scopes.isError ? (
        <InlineAlert tone="danger" title={t('SearchSavedScopesView.loadError')} live>
          {describeError(scopes.error)}
        </InlineAlert>
      ) : null}
      {scopes.isPending ? (
        <LoadingRegion label={t('SearchSavedScopesView.loading')}>
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}
      {!scopes.isPending && !scopes.isError && list.length === 0 ? (
        <InlineAlert tone="neutral" title={t('SearchSavedScopesView.emptyTitle')}>
          {t('SearchSavedScopesView.emptyBody')}
        </InlineAlert>
      ) : null}

      {list.length > 0 ? (
        <ul className="tm-row tm-wrap tm-chips" aria-label={t('SearchSavedScopesView.listAria')}>
          {list.map((scope) => (
            <li key={scope.id} className="tm-chip">
              <Button
                type="button"
                tone="outline"
                size="accessible"
                onClick={() => onApply?.(scope)}
              >
                {scope.name}
              </Button>{' '}
              <Button
                type="button"
                tone="text"
                size="accessible"
                aria-label={`${t('SearchSavedScopesView.deleteScopeAria')} ${scope.name}`}
                onClick={() => remove.mutate(scope.id)}
                disabled={remove.isPending}
              >
                ✕
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <form
        className="tm-row"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed.length > 0) save.mutate(trimmed);
        }}
      >
        <label className="tm-field">
          <span className="tm-label">{t('SearchSavedScopesView.saveCurrentLabel')}</span>
          <input
            className="tm-input"
            type="text"
            value={name}
            maxLength={300}
            placeholder={t('SearchSavedScopesView.namePlaceholder')}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <Button type="submit" size="accessible" disabled={trimmed.length === 0 || save.isPending}>
          {t('SearchSavedScopesView.saveScope')}
        </Button>
      </form>

      {save.isError ? (
        <InlineAlert tone="danger" title={t('SearchSavedScopesView.saveError')} live>
          {describeError(save.error)}
        </InlineAlert>
      ) : null}
      {remove.isError ? (
        <InlineAlert tone="danger" title={t('SearchSavedScopesView.deleteError')} live>
          {describeError(remove.error)}
        </InlineAlert>
      ) : null}
    </section>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
