'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import {
  addDocSubscription,
  getDocSubscriptionStatus,
  listDocSubscriptions,
  removeDocSubscription,
} from '../../lib/api/doc-subscriptions';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { appLocale } from '../../lib/i18n/app-locale';

export interface DocSubscriptionToggleProps {
  organizationSlug: string;
  documentId: string;
  client?: ApiClient;
}

/**
 * **DOC subscriptions (x312).**
 *
 * `22-SCREEN §Document view` — the per-document follow control that sits beside a document. It reads the
 * caller's current subscription status and toggles it: PUT to follow (idempotent), DELETE to unfollow.
 * On success it invalidates the caller's subscriptions list so the my-subscriptions section reflects the
 * change without a manual refresh. A read-side flag only — following dispatches no notifications.
 *
 * The control is `aria-pressed` so a screen reader announces the follow state, and it is disabled while
 * its own mutation is in flight.
 */
export function DocSubscriptionToggle({
  organizationSlug,
  documentId,
  client,
}: DocSubscriptionToggleProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const queryClient = useQueryClient();

  const status = useQuery({
    queryKey: ['doc-subscription', organizationSlug, documentId],
    queryFn: () => getDocSubscriptionStatus(api, organizationSlug, documentId),
  });

  const subscribed = status.data ?? false;

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['doc-subscription', organizationSlug, documentId],
      }),
      queryClient.invalidateQueries({ queryKey: ['doc-subscriptions', organizationSlug] }),
    ]);
  };

  const toggle = useMutation({
    mutationFn: async () => {
      if (subscribed) {
        await removeDocSubscription(api, organizationSlug, documentId);
      } else {
        await addDocSubscription(api, organizationSlug, documentId);
      }
    },
    onSuccess: invalidate,
  });

  return (
    <div className="tm-stack">
      <Button
        type="button"
        tone={subscribed ? 'ink' : 'outline'}
        size="accessible"
        aria-pressed={subscribed}
        loading={toggle.isPending}
        loadingLabel={
          subscribed
            ? t('DocSubscriptionsView.loadingUnfollow')
            : t('DocSubscriptionsView.loadingFollow')
        }
        disabled={status.isPending}
        onClick={() => toggle.mutate()}
      >
        {subscribed ? t('DocSubscriptionsView.stateFollowing') : t('DocSubscriptionsView.follow')}
      </Button>

      {toggle.isError ? (
        <InlineAlert tone="danger" title={t('DocSubscriptionsView.toggleErrorTitle')} live>
          {describeError(toggle.error, t)}
        </InlineAlert>
      ) : null}
    </div>
  );
}

export interface DocSubscriptionsViewProps {
  organizationSlug: string;
  /** When present, the follow/unfollow toggle for this document is shown above the list. */
  documentId?: string;
  client?: ApiClient;
}

/**
 * **DOC subscriptions (x312).**
 *
 * `22-SCREEN §Document view` — the caller's own follow list, optionally with the follow/unfollow toggle
 * for the document currently in view. The list reads the caller's own subscriptions (newest first), each
 * projected to a document the caller can still read; a document the caller has since lost access to is
 * dropped by the API, so no title leaks here.
 *
 * ## What it does, and what it cannot
 *
 * - **The list is the caller's own.** The API scopes it to the acting membership; there is no view of
 *   another member's subscriptions.
 * - **A subscription is a read-side flag.** Following a document does not send notifications this slice.
 */
export function DocSubscriptionsView({
  organizationSlug,
  documentId,
  client,
}: DocSubscriptionsViewProps) {
  const api = client ?? browserApiClient();
  const t = useT();

  const subscriptions = useQuery({
    queryKey: ['doc-subscriptions', organizationSlug],
    queryFn: () => listDocSubscriptions(api, organizationSlug),
  });

  const rows = subscriptions.data ?? [];

  return (
    <div className="tm-stack">
      {documentId ? (
        <DocSubscriptionToggle
          organizationSlug={organizationSlug}
          documentId={documentId}
          {...(client ? { client } : {})}
        />
      ) : null}

      <section className="tm-panel tm-stack" aria-labelledby="tm-subscriptions-heading">
        <h2 id="tm-subscriptions-heading" className="tm-eyebrow">
          {t('DocSubscriptionsView.heading')}
        </h2>

        {subscriptions.isError ? (
          <InlineAlert tone="danger" title={t('DocSubscriptionsView.loadErrorTitle')} live>
            {describeError(subscriptions.error, t)}
          </InlineAlert>
        ) : null}

        {subscriptions.isPending ? (
          <LoadingRegion label={t('DocSubscriptionsView.loadingSubscriptions')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!subscriptions.isPending && !subscriptions.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title={t('DocSubscriptionsView.emptyTitle')}>
            {t('DocSubscriptionsView.emptyBody')}
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
            aria-label={t('DocSubscriptionsView.heading')}
          >
            <table className="tm-table">
              <caption className="tm-visually-hidden">
                {t('DocSubscriptionsView.captionPrefix')} {rows.length}{' '}
                {t('DocSubscriptionsView.shownSuffix')}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t('DocSubscriptionsView.columnDocument')}</th>
                  <th scope="col">{t('DocSubscriptionsView.columnFollowedAt')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((subscription) => (
                  <tr key={subscription.id}>
                    <th scope="row" className="tm-table__title">
                      {subscription.title}
                    </th>
                    <td>{new Date(subscription.createdAt).toLocaleString(appLocale())}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function describeError(error: unknown, t: ReturnType<typeof useT>): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('DocSubscriptionsView.apiNoAnswer');
  return t('DocSubscriptionsView.genericError');
}
