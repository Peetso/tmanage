'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createInboxSavedFilter,
  deleteInboxSavedFilter,
  listInboxSavedFilters,
} from '../../lib/api/inbox-saved-filters';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/inbox.css';

export interface InboxSavedFiltersScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The current inbox filter facets to save (source / project / kind), serialized by the caller. */
  currentFilter?: string;
  client?: ApiClient;
}

/**
 * **INBOX saved filters (IN-02 "All inbox", x261).**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Inbox — a member's own named inbox filter sets, shown as
 * chips above the inbox with a save-current-filter dialog. Reads the caller's own saved filters
 * (newest first); saving is scoped to the acting membership by the API, and a duplicate name is
 * refused (409). Applying a saved filter is the parent inbox's concern; this screen manages the set.
 */
export function InboxSavedFiltersScreen({
  organizationSlug,
  organizationName,
  currentFilter,
  client,
}: InboxSavedFiltersScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const queryKey = ['inbox-saved-filters', organizationSlug];

  const [name, setName] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);

  const filters = useQuery({
    queryKey,
    queryFn: () => listInboxSavedFilters(api, organizationSlug),
  });

  const create = useMutation({
    mutationFn: () =>
      createInboxSavedFilter(api, organizationSlug, {
        name: name.trim(),
        filter: currentFilter ?? '',
      }),
    onSuccess: async () => {
      setName('');
      setDialogOpen(false);
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const remove = useMutation({
    mutationFn: (savedFilterId: string) =>
      deleteInboxSavedFilter(api, organizationSlug, savedFilterId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const rows = filters.data ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="inbox"
      title="Saved inbox filters"
      description="Your saved inbox filter sets. Save the current filter under a name, then apply it as a chip above the inbox."
    >
      <section className="tm-card tm-inbox-panel" aria-labelledby="tm-inbox-filters-heading">
        <h2 id="tm-inbox-filters-heading" className="tm-card__title">
          Your saved filters
        </h2>

        {filters.isError ? (
          <InlineAlert tone="danger" title="Could not load your saved filters" live>
            {describeError(filters.error)}
          </InlineAlert>
        ) : null}

        {create.isError ? (
          <InlineAlert tone="danger" title="Could not save the filter" live>
            {describeError(create.error)}
          </InlineAlert>
        ) : null}

        {filters.isPending ? (
          <LoadingRegion label="Loading your saved filters.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!filters.isPending && !filters.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title="No saved filters yet">
            Save the current inbox filter under a name to keep it here and apply it in one click.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <ul className="tm-chip-row" aria-label="Saved inbox filters">
            {rows.map((filter) => (
              <li key={filter.id} className="tm-chip">
                <span className="tm-chip__label">{filter.name}</span>
                <button
                  type="button"
                  className="tm-chip__remove"
                  onClick={() => remove.mutate(filter.id)}
                  disabled={remove.isPending}
                  aria-label={`Delete saved filter ${filter.name}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {dialogOpen ? (
          <form
            className="tm-stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim().length > 0) create.mutate();
            }}
          >
            <label className="tm-field">
              <span className="tm-field__label">Filter name</span>
              <input
                className="tm-input"
                type="text"
                value={name}
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
            <div className="tm-actions">
              <button
                type="submit"
                className="tm-button tm-button--ink"
                disabled={create.isPending || name.trim().length === 0}
              >
                Save filter
              </button>
              <button
                type="button"
                className="tm-button tm-button--outline"
                onClick={() => setDialogOpen(false)}
                disabled={create.isPending}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="tm-actions">
            <button
              type="button"
              className="tm-button tm-button--ink"
              onClick={() => setDialogOpen(true)}
            >
              Save current filter
            </button>
          </div>
        )}
      </section>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
