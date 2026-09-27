'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  MAX_QUICK_LINKS,
  addHomeQuickLink,
  getHomeQuickLinks,
  isSafeInAppPath,
  removeHomeQuickLink,
  reorderHomeQuickLinks,
} from '../../lib/api/home-quick-links';
import type { HomeQuickLinksView } from '../../lib/api/home-quick-links';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface HomeQuickLinksScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Home quick links (module 4 Home / My Day, HOME-05 "Saved/pinned context", x273).**
 *
 * `38-MODULE-MAP` §Home / My Day names recent context and quick capture; this is the personal
 * quick-links row that lets a member keep a small, ordered list of shortcuts (a label + an in-app
 * path) on My Day. A member reads their own list, adds a link, reorders and removes — everything
 * persists behind `work.read`, scoped to the caller's own membership by the server. The path is
 * validated as a relative in-app path on both sides (an open-redirect guard); the count is capped at
 * {@link MAX_QUICK_LINKS} by the server.
 */
export function HomeQuickLinksScreen({
  organizationSlug,
  organizationName,
  client,
}: HomeQuickLinksScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const queryKey = ['home-quick-links', organizationSlug];

  const links = useQuery({
    queryKey,
    queryFn: () => getHomeQuickLinks(api, organizationSlug),
  });

  const [label, setLabel] = useState('');
  const [path, setPath] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const onSuccess = (result: HomeQuickLinksView): void => {
    queries.setQueryData(queryKey, result);
  };

  const add = useMutation({
    mutationFn: (): Promise<HomeQuickLinksView> =>
      addHomeQuickLink(api, organizationSlug, { label: label.trim(), path: path.trim() }),
    onSuccess: (result) => {
      onSuccess(result);
      setLabel('');
      setPath('');
      setFormError(null);
    },
  });

  const reorder = useMutation({
    mutationFn: (ids: readonly string[]): Promise<HomeQuickLinksView> =>
      reorderHomeQuickLinks(api, organizationSlug, ids),
    onSuccess,
  });

  const remove = useMutation({
    mutationFn: (id: string): Promise<HomeQuickLinksView> =>
      removeHomeQuickLink(api, organizationSlug, id),
    onSuccess,
  });

  const current = links.data?.links ?? [];
  const atCap = current.length >= MAX_QUICK_LINKS;

  const submit = (): void => {
    const trimmedLabel = label.trim();
    const trimmedPath = path.trim();
    if (trimmedLabel.length === 0) {
      setFormError('Enter a label for the link.');
      return;
    }
    if (!isSafeInAppPath(trimmedPath)) {
      setFormError('Enter an in-app path that begins with "/" (no web address).');
      return;
    }
    setFormError(null);
    add.mutate();
  };

  const move = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= current.length) return;
    const ids = current.map((l) => l.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(target, 0, moved!);
    reorder.mutate(ids);
  };

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Quick links"
      description="Your personal shortcuts on Home — saved to your account."
    >
      {links.isPending ? (
        <LoadingRegion label="Loading your quick links">
          <Skeleton />
        </LoadingRegion>
      ) : links.isError ? (
        <InlineAlert tone="danger" title="We could not load your quick links">
          {errorMessage(links.error)}
        </InlineAlert>
      ) : (
        <div className="tm-stack">
          <form
            className="tm-panel tm-stack"
            aria-labelledby="tm-quick-links-add-heading"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <h2 id="tm-quick-links-add-heading" className="tm-eyebrow">
              Add a quick link
            </h2>
            <Field
              label="Label"
              value={label}
              maxLength={200}
              onChange={(event) => setLabel(event.target.value)}
            />
            <Field
              label="In-app path"
              hint='A path within the app, e.g. "/work/inbox".'
              value={path}
              maxLength={512}
              onChange={(event) => setPath(event.target.value)}
            />
            {formError ? (
              <InlineAlert tone="danger" title="Check the link">
                {formError}
              </InlineAlert>
            ) : null}
            {add.isError ? (
              <InlineAlert tone="danger" title="We could not add the link">
                {errorMessage(add.error)}
              </InlineAlert>
            ) : null}
            {atCap ? (
              <InlineAlert tone="neutral" title="You have reached the limit">
                You can keep at most {MAX_QUICK_LINKS} quick links. Remove one to add another.
              </InlineAlert>
            ) : null}
            <div>
              <Button type="submit" disabled={add.isPending || atCap}>
                {add.isPending ? 'Adding…' : 'Add link'}
              </Button>
            </div>
          </form>

          <section className="tm-panel tm-stack" aria-labelledby="tm-quick-links-heading">
            <h2 id="tm-quick-links-heading" className="tm-eyebrow">
              Your quick links
            </h2>
            {current.length === 0 ? (
              <p className="tm-muted">You have not added any quick links yet.</p>
            ) : (
              <ul className="tm-stack" aria-label="Quick links">
                {current.map((link, index) => (
                  <li className="tm-field tm-field--inline" key={link.id}>
                    <span className="tm-field__label">{link.label}</span>
                    <span className="tm-muted">{link.path}</span>
                    <Button
                      type="button"
                      tone="outline"
                      disabled={index === 0 || reorder.isPending}
                      aria-label={`Move ${link.label} up`}
                      onClick={() => move(index, -1)}
                    >
                      Up
                    </Button>
                    <Button
                      type="button"
                      tone="outline"
                      disabled={index === current.length - 1 || reorder.isPending}
                      aria-label={`Move ${link.label} down`}
                      onClick={() => move(index, 1)}
                    >
                      Down
                    </Button>
                    <Button
                      type="button"
                      tone="outline"
                      disabled={remove.isPending}
                      aria-label={`Remove ${link.label}`}
                      onClick={() => remove.mutate(link.id)}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {reorder.isError ? (
              <InlineAlert tone="danger" title="We could not reorder your links">
                {errorMessage(reorder.error)}
              </InlineAlert>
            ) : null}
            {remove.isError ? (
              <InlineAlert tone="danger" title="We could not remove the link">
                {errorMessage(remove.error)}
              </InlineAlert>
            ) : null}
          </section>
        </div>
      )}
    </AppShell>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
