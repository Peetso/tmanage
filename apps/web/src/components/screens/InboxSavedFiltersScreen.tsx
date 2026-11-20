'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createInboxSavedFilter,
  deleteInboxSavedFilter,
  listInboxSavedFilters,
} from '../../lib/api/inbox-saved-filters';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';
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
  const describeError = useDescribeApiError();
  const t = useT();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const queryKey = ['inbox-saved-filters', organizationSlug];

  const [name, setName] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  // The empty state's action opens the form and takes the keyboard to its first field.
  const focusOnOpen = useRef(false);
  useEffect(() => {
    if (!dialogOpen || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    focusFirstField(firstStep.current);
  }, [dialogOpen]);

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
      title={t('InboxSavedFiltersScreen.title')}
      description={t('InboxSavedFiltersScreen.description')}
    >
      <section className="tm-card tm-inbox-panel" aria-labelledby="tm-inbox-filters-heading">
        <h2 id="tm-inbox-filters-heading" className="tm-card__title">
          {t('InboxSavedFiltersScreen.heading')}
        </h2>

        {filters.isError ? (
          <InlineAlert tone="danger" title={t('InboxSavedFiltersScreen.loadErrorTitle')} live>
            {describeError(filters.error)}
          </InlineAlert>
        ) : null}

        {create.isError ? (
          <InlineAlert tone="danger" title={t('InboxSavedFiltersScreen.saveErrorTitle')} live>
            {describeError(create.error)}
          </InlineAlert>
        ) : null}

        {filters.isPending ? (
          <LoadingRegion label={t('InboxSavedFiltersScreen.loading')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!filters.isPending && !filters.isError && rows.length === 0 ? (
          <TeachingEmptyState
            title={t('InboxSavedFiltersScreen.emptyTitle')}
            explanation={t('teachEmpty.inboxFiltersBody')}
            action={
              canUse('work.read') ? (
                <Button
                  tone="lime"
                  size="accessible"
                  onClick={() => {
                    focusOnOpen.current = true;
                    setDialogOpen(true);
                  }}
                >
                  {t('teachEmpty.inboxFiltersAction')}
                </Button>
              ) : undefined
            }
          />
        ) : null}

        {rows.length > 0 ? (
          <ul className="tm-chip-row" aria-label={t('InboxSavedFiltersScreen.listLabel')}>
            {rows.map((filter) => (
              <li key={filter.id} className="tm-chip">
                <span className="tm-chip__label">{filter.name}</span>
                <button
                  type="button"
                  className="tm-chip__remove"
                  onClick={() => remove.mutate(filter.id)}
                  disabled={remove.isPending}
                  aria-label={`${t('InboxSavedFiltersScreen.deletePrefix')} ${filter.name}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {dialogOpen ? (
          <form
            noValidate
            ref={firstStep}
            className="tm-stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim().length > 0) create.mutate();
            }}
          >
            <label className="tm-field">
              <span className="tm-field__label">{t('InboxSavedFiltersScreen.nameLabel')}</span>
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
                {t('InboxSavedFiltersScreen.saveButton')}
              </button>
              <button
                type="button"
                className="tm-button tm-button--outline"
                onClick={() => setDialogOpen(false)}
                disabled={create.isPending}
              >
                {t('InboxSavedFiltersScreen.cancel')}
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
              {t('InboxSavedFiltersScreen.saveCurrent')}
            </button>
          </div>
        )}
      </section>
    </AppShell>
  );
}
