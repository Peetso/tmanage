'use client';

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, Switch } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  readSecurityAlerts,
  removeSecurityAlert,
  setSecurityAlert,
} from '../../lib/api/admin-security-alerts';
import type { SecurityAlertsView as SecurityAlertsViewData } from '../../lib/api/admin-security-alerts';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';

export interface AdminSecurityAlertsViewProps {
  organizationSlug: string;
  client?: ApiClient | undefined;
}

/**
 * **Admin security-event alerts (Administration, security monitoring, x329).**
 *
 * `38-MODULE-MAP` §Administration (security monitoring); `04-SECURITY-PRIVACY` §Alerting. A security
 * admin turns an in-app alert on or off per security event-type key, and sees a read-only preview of
 * the tenant's own recent matching audit events. This is the config + read-side surface only — no
 * email/SMS dispatch is sent (Needs-Peter).
 *
 * A faithful reader of the API's config: it reads `GET .../admin/security-alerts` (behind
 * `org.security.manage`), toggles a key with `PUT` and clears one with `DELETE`. The allowlist of
 * event-type keys is the server's; a key off it is refused server-side, so the toggles only ever
 * offer keys the API will accept.
 */
export function AdminSecurityAlertsView({
  organizationSlug,
  client,
}: AdminSecurityAlertsViewProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const queryKey = useMemo(() => ['admin-security-alerts', organizationSlug], [organizationSlug]);

  const alerts = useQuery<SecurityAlertsViewData>({
    queryKey,
    queryFn: () => readSecurityAlerts(api, organizationSlug),
  });

  const toggle = useMutation({
    mutationFn: (input: { eventTypeKey: string; enabled: boolean }) =>
      setSecurityAlert(api, organizationSlug, input),
    onSuccess: (data) => queryClient.setQueryData(queryKey, data),
  });

  const clear = useMutation({
    mutationFn: (eventTypeKey: string) => removeSecurityAlert(api, organizationSlug, eventTypeKey),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  if (alerts.isLoading) {
    return (
      <LoadingRegion label={t('AdminSecurityAlertsView.loading')}>
        <Skeleton height="var(--row)" />
        <Skeleton height="var(--row)" />
      </LoadingRegion>
    );
  }

  if (alerts.isError) {
    const error = alerts.error;
    const message =
      error instanceof ApiRequestError || error instanceof NetworkError
        ? error.message
        : t('AdminSecurityAlertsView.loadError');
    return <InlineAlert tone="danger">{message}</InlineAlert>;
  }

  const view = alerts.data;
  if (!view) return null;

  const enabledFor = (eventTypeKey: string): boolean =>
    view.configs.find((c) => c.eventTypeKey === eventTypeKey)?.enabled ?? false;

  return (
    <section aria-label={t('AdminSecurityAlertsView.sectionLabel')}>
      <h2>{t('AdminSecurityAlertsView.heading')}</h2>
      <p>{t('AdminSecurityAlertsView.intro')}</p>

      {toggle.isError || clear.isError ? (
        <InlineAlert tone="danger">{t('AdminSecurityAlertsView.saveError')}</InlineAlert>
      ) : null}

      <ul>
        {view.allowedEventTypes.map((eventTypeKey) => {
          const enabled = enabledFor(eventTypeKey);
          return (
            <li key={eventTypeKey}>
              <Switch
                checked={enabled}
                onChange={(event) => toggle.mutate({ eventTypeKey, enabled: event.target.checked })}
                label={eventTypeKey}
                disabled={toggle.isPending}
              />
              {view.configs.some((c) => c.eventTypeKey === eventTypeKey) ? (
                <Button
                  tone="text"
                  onClick={() => clear.mutate(eventTypeKey)}
                  disabled={clear.isPending}
                >
                  {t('AdminSecurityAlertsView.clear')}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>

      <h3>{t('AdminSecurityAlertsView.recentMatchesHeading')}</h3>
      {view.recentMatches.length === 0 ? (
        <p>{t('AdminSecurityAlertsView.noMatches')}</p>
      ) : (
        <ul>
          {view.recentMatches.map((match) => (
            <li key={match.id}>
              <span>{match.eventTypeKey}</span> <span>{match.result}</span>{' '}
              <time dateTime={match.occurredAt}>{match.occurredAt}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
