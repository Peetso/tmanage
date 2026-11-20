'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
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
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
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
  const errorMessage = useDescribeApiError(OFFLINE_LINES);
  const t = useT();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);
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
      setFormError(t('HomeQuickLinksScreen.labelRequired'));
      return;
    }
    if (!isSafeInAppPath(trimmedPath)) {
      setFormError(t('HomeQuickLinksScreen.pathInvalid'));
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
      title={t('HomeQuickLinksScreen.title')}
      description={t('HomeQuickLinksScreen.description')}
    >
      {links.isPending ? (
        <LoadingRegion label={t('HomeQuickLinksScreen.loading')}>
          <Skeleton />
        </LoadingRegion>
      ) : links.isError ? (
        <InlineAlert tone="danger" title={t('HomeQuickLinksScreen.loadErrorTitle')}>
          {errorMessage(links.error)}
        </InlineAlert>
      ) : (
        <div className="tm-stack">
          <form
            noValidate
            ref={firstStep}
            className="tm-panel tm-stack"
            aria-labelledby="tm-quick-links-add-heading"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <h2 id="tm-quick-links-add-heading" className="tm-eyebrow">
              {t('HomeQuickLinksScreen.addHeading')}
            </h2>
            <Field
              label={t('HomeQuickLinksScreen.labelLabel')}
              value={label}
              maxLength={200}
              onChange={(event) => setLabel(event.target.value)}
            />
            <Field
              label={t('HomeQuickLinksScreen.pathLabel')}
              hint={t('HomeQuickLinksScreen.pathHint')}
              value={path}
              maxLength={512}
              onChange={(event) => setPath(event.target.value)}
            />
            {formError ? (
              <InlineAlert tone="danger" title={t('HomeQuickLinksScreen.checkTitle')}>
                {formError}
              </InlineAlert>
            ) : null}
            {add.isError ? (
              <InlineAlert tone="danger" title={t('HomeQuickLinksScreen.addErrorTitle')}>
                {errorMessage(add.error)}
              </InlineAlert>
            ) : null}
            {atCap ? (
              <InlineAlert tone="neutral" title={t('HomeQuickLinksScreen.capTitle')}>
                {t('HomeQuickLinksScreen.capPrefix')} {MAX_QUICK_LINKS}{' '}
                {t('HomeQuickLinksScreen.capSuffix')}
              </InlineAlert>
            ) : null}
            <div>
              <Button type="submit" disabled={add.isPending || atCap}>
                {add.isPending
                  ? t('HomeQuickLinksScreen.adding')
                  : t('HomeQuickLinksScreen.addButton')}
              </Button>
            </div>
          </form>

          <section className="tm-panel tm-stack" aria-labelledby="tm-quick-links-heading">
            <h2 id="tm-quick-links-heading" className="tm-eyebrow">
              {t('HomeQuickLinksScreen.listHeading')}
            </h2>
            {current.length === 0 ? (
              <TeachingEmptyState
                title={t('teachEmpty.homeQuickLinksTitle')}
                explanation={t('teachEmpty.homeQuickLinksBody')}
                action={
                  canUse('work.read') ? (
                    <Button
                      tone="lime"
                      size="accessible"
                      onClick={() => focusFirstField(firstStep.current)}
                    >
                      {t('teachEmpty.homeQuickLinksAction')}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <ul className="tm-stack" aria-label={t('HomeQuickLinksScreen.listLabel')}>
                {current.map((link, index) => (
                  <li className="tm-field tm-field--inline" key={link.id}>
                    <span className="tm-field__label">{link.label}</span>
                    <span className="tm-muted">{link.path}</span>
                    <Button
                      type="button"
                      tone="outline"
                      disabled={index === 0 || reorder.isPending}
                      aria-label={`${t('HomeQuickLinksScreen.moveLabel')} ${link.label} ${t('HomeQuickLinksScreen.upSuffix')}`}
                      onClick={() => move(index, -1)}
                    >
                      {t('HomeQuickLinksScreen.up')}
                    </Button>
                    <Button
                      type="button"
                      tone="outline"
                      disabled={index === current.length - 1 || reorder.isPending}
                      aria-label={`${t('HomeQuickLinksScreen.moveLabel')} ${link.label} ${t('HomeQuickLinksScreen.downSuffix')}`}
                      onClick={() => move(index, 1)}
                    >
                      {t('HomeQuickLinksScreen.down')}
                    </Button>
                    <Button
                      type="button"
                      tone="outline"
                      disabled={remove.isPending}
                      aria-label={`${t('HomeQuickLinksScreen.removeLabel')} ${link.label}`}
                      onClick={() => remove.mutate(link.id)}
                    >
                      {t('HomeQuickLinksScreen.remove')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {reorder.isError ? (
              <InlineAlert tone="danger" title={t('HomeQuickLinksScreen.reorderErrorTitle')}>
                {errorMessage(reorder.error)}
              </InlineAlert>
            ) : null}
            {remove.isError ? (
              <InlineAlert tone="danger" title={t('HomeQuickLinksScreen.removeErrorTitle')}>
                {errorMessage(remove.error)}
              </InlineAlert>
            ) : null}
          </section>
        </div>
      )}
    </AppShell>
  );
}
