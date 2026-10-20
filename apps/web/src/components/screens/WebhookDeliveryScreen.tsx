'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ControlCenterSections } from '../admin/ControlCenterShell';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/automations.css';
import { browserApiClient } from '../../lib/api/browser-client';
import { listWebhookDeliveries, type WebhookDeliveryView } from '../../lib/api/webhook-deliveries';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';

export interface WebhookDeliveryScreenProps {
  organizationSlug: string;
  organizationName: string;
  endpointId: string;
  client?: ApiClient;
}

/**
 * **Automations webhook delivery log (module 17, x221).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Automations & integrations ("webhooks"); audit rank
 * #2. The read/history surface for one webhook endpoint: its recorded delivery attempts, newest
 * first, each with a status badge, the HTTP response code (when one was received), and when it was
 * attempted. Gated on `org.manage` by the API, so a caller without the capability sees the API's
 * refusal rather than a blank page.
 *
 * A delivery record carries only the outcome — never the endpoint's signing secret or any request /
 * response body — so none of those are shown. Dispatch itself (the outbound POST that produces these
 * rows) is a later slice; this screen reads the log back.
 */
export function WebhookDeliveryScreen({
  organizationSlug,
  organizationName,
  endpointId,
  client,
}: WebhookDeliveryScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();

  const [rows, setRows] = useState<readonly WebhookDeliveryView[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const page = useQuery({
    queryKey: ['webhook-deliveries', organizationSlug, endpointId, cursor ?? 'first'],
    queryFn: async () => {
      const result = await listWebhookDeliveries(api, organizationSlug, endpointId, {
        ...(cursor !== undefined ? { before: cursor } : {}),
      });
      setRows((existing) =>
        cursor === undefined ? result.deliveries : [...existing, ...result.deliveries],
      );
      return result;
    },
  });

  const nextCursor = page.data?.nextCursor ?? null;
  const failures = rows.filter((row) => row.status !== 'success').length;
  const lastFailure = rows.find((row) => row.status !== 'success');

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      contextRail={
        <ControlCenterSections organizationSlug={organizationSlug} section="integrations" />
      }
      eyebrow={t('WebhookDeliveryScreen.eyebrow')}
      title={t('WebhookDeliveryScreen.title')}
      {...(rows.length > 0
        ? {
            titleMeta: `${rows.length} ${t('WebhookDeliveryScreen.shown')} · ${failures} ${t('WebhookDeliveryScreen.failed')}`,
          }
        : {})}
      description={t('WebhookDeliveryScreen.description')}
      actions={
        <Link href={`/${organizationSlug}/admin/automations/webhooks`} className="tm-aut-btn">
          {t('WebhookDeliveryScreen.allEndpoints')}
        </Link>
      }
    >
      <div className="tm-aut">
        <div className="tm-aut-split">
          <section className="tm-aut-col" aria-labelledby="tm-webhook-deliveries-heading">
            <h2 id="tm-webhook-deliveries-heading" className="tm-visually-hidden">
              {t('WebhookDeliveryScreen.deliveryAttempts')}
            </h2>

            {page.isError ? (
              <InlineAlert tone="danger" title={t('WebhookDeliveryScreen.loadError')} live>
                {describeError(page.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-aut-tablecard">
              {page.isPending && rows.length === 0 ? (
                <div className="tm-aut-pad">
                  <LoadingRegion label={t('WebhookDeliveryScreen.loading')}>
                    <Skeleton height="var(--row)" />
                    <Skeleton height="var(--row)" />
                  </LoadingRegion>
                </div>
              ) : null}

              {!page.isPending && !page.isError && rows.length === 0 ? (
                <div className="tm-aut-empty">
                  <p className="tm-aut-empty__title">{t('WebhookDeliveryScreen.emptyTitle')}</p>
                  <p className="tm-aut-empty__body">{t('WebhookDeliveryScreen.emptyBody')}</p>
                </div>
              ) : null}

              {rows.length > 0 ? (
                <table
                  className="tm-aut-table tm-aut-table--compact"
                  aria-label={t('WebhookDeliveryScreen.tableLabel')}
                >
                  <thead>
                    <tr>
                      <th scope="col">{t('WebhookDeliveryScreen.colAttempted')}</th>
                      <th scope="col">{t('WebhookDeliveryScreen.colResponse')}</th>
                      <th scope="col" className="tm-aut-end">
                        {t('WebhookDeliveryScreen.colStatus')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr
                        key={row.id}
                        className={row.status === 'success' ? undefined : 'is-failed'}
                      >
                        <td className="tm-aut-mono">{formatAttempt(row.attemptedAt)}</td>
                        <td className="tm-aut-mono">{row.responseCode ?? '—'}</td>
                        <td className="tm-aut-end">
                          <span
                            className={`tm-aut-state ${row.status === 'success' ? 'tm-aut-state--live' : 'tm-aut-state--danger'}`}
                          >
                            {row.status === 'success'
                              ? t('WebhookDeliveryScreen.success')
                              : t('WebhookDeliveryScreen.failure')}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>

            {nextCursor !== null ? (
              <div className="tm-aut-actions">
                <Button
                  type="button"
                  tone="outline"
                  size="accessible"
                  loading={page.isFetching}
                  loadingLabel={t('WebhookDeliveryScreen.loadingMore')}
                  onClick={() => setCursor(nextCursor)}
                >
                  {t('WebhookDeliveryScreen.loadOlder')}
                </Button>
              </div>
            ) : null}
          </section>

          <aside
            className={`tm-aut-card ${lastFailure ? 'tm-aut-card--danger' : ''}`}
            aria-labelledby="tm-webhook-delivery-summary"
          >
            <p className={`tm-aut-eyebrow ${lastFailure ? 'tm-aut-eyebrow--danger' : ''}`}>
              <span className="tm-aut-eyebrow__square" aria-hidden="true" />
              {lastFailure
                ? t('WebhookDeliveryScreen.latestFailure')
                : t('WebhookDeliveryScreen.deliveryHealth')}
            </p>
            <h2
              id="tm-webhook-delivery-summary"
              className="tm-aut-card__title tm-aut-card__title--section"
            >
              {page.isError && rows.length === 0
                ? t('WebhookDeliveryScreen.summaryUnavailable')
                : rows.length === 0
                  ? t('WebhookDeliveryScreen.summaryNothing')
                  : failures === 0
                    ? t('WebhookDeliveryScreen.summaryAllDelivered')
                    : `${failures} ${t('WebhookDeliveryScreen.of')} ${rows.length} ${t('WebhookDeliveryScreen.shownAttemptsFailed')}`}
            </h2>
            <p className="tm-aut-card__body">
              {lastFailure
                ? `${t('WebhookDeliveryScreen.recentFailurePrefix')} ${formatAttempt(lastFailure.attemptedAt).toLowerCase()} ${t('WebhookDeliveryScreen.recentFailureWithResponse')} ${lastFailure.responseCode ?? t('WebhookDeliveryScreen.none')}.`
                : t('WebhookDeliveryScreen.bodyEachAttempt')}
            </p>
            <p className="tm-aut-card__foot">{t('WebhookDeliveryScreen.foot')}</p>
          </aside>
        </div>
      </div>
    </AppShell>
  );
}

/** AUT-04's mono stamp in UTC, e.g. `18 OCT 09:12`. */
function formatAttempt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = date
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    .toUpperCase();
  return `${day} ${date.toISOString().slice(11, 16)} UTC`;
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
