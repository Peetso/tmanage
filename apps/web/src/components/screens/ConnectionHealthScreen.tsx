'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StatusDot } from '@tmanage/ui';
import type { StatusTone } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  listConnectionHealth,
  type ConnectionHealthIssue,
  type ConnectionHealthView,
} from '../../lib/api/connection-health';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';

export interface ConnectionHealthScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Automations connection health (module 17, x220).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Automations & integrations. This screen reads the
 * read-only health roll-up (`GET …/automations/connections/health`, `org.manage`) — a deterministic,
 * in-app validity verdict over the organization's recorded connections (x165).
 *
 * ## What it shows, and what it cannot
 *
 * - **No live probe.** The verdict is computed from data already in hand (is the catalog app still
 *   known, are the required non-secret config keys present, is the connection live). A real ping to
 *   the third party is out of scope (Needs-Peter); nothing here reaches the network beyond this API.
 * - **No secrets.** The verdict carries only the *names* of any missing required keys, never a
 *   stored config value — so this screen has no value to leak.
 */
export function ConnectionHealthScreen({
  organizationSlug,
  organizationName,
  client,
}: ConnectionHealthScreenProps) {
  const describeError = useDescribeApiError(OFFLINE_LINES);
  const api = client ?? browserApiClient();
  const t = useT();

  const health = useQuery({
    queryKey: ['connection-health', organizationSlug],
    queryFn: () => listConnectionHealth(api, organizationSlug),
  });

  const rows = health.data ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title={t('ConnectionHealthScreen.title')}
      description={t('ConnectionHealthScreen.description')}
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-health-heading">
        <h2 id="tm-health-heading" className="tm-eyebrow">
          {t('ConnectionHealthScreen.recordedConnections')}
        </h2>

        {health.isError ? (
          <InlineAlert tone="danger" title={t('ConnectionHealthScreen.loadError')} live>
            {describeError(health.error)}
          </InlineAlert>
        ) : null}

        {health.isPending ? (
          <LoadingRegion label={t('ConnectionHealthScreen.loadingLabel')}>
            <Skeleton />
          </LoadingRegion>
        ) : rows.length === 0 ? (
          <p className="tm-muted">{t('ConnectionHealthScreen.emptyList')}</p>
        ) : (
          <ul
            className="tm-grid tm-grid--cards"
            aria-label={t('ConnectionHealthScreen.connectionHealthAria')}
          >
            {rows.map((row) => (
              <li key={row.connectionId} className="tm-card tm-stack">
                <h3 className="tm-card__title">{row.label}</h3>
                <p className="tm-muted">{row.appId}</p>
                <StatusDot tone={healthTone(row)}>
                  {row.healthy
                    ? t('ConnectionHealthScreen.healthy')
                    : t('ConnectionHealthScreen.needsAttention')}
                </StatusDot>
                {row.issues.length > 0 ? (
                  <ul className="tm-stack" aria-label={t('ConnectionHealthScreen.issuesAria')}>
                    {row.issues.map((issue) => (
                      <li key={issue} className="tm-prose">
                        {describeIssue(issue, row.missingConfigKeys)}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}

/** A healthy connection is `success`; an unhealthy one is `warning` — never a bare dot. */
function healthTone(row: ConnectionHealthView): StatusTone {
  return row.healthy ? 'success' : 'warning';
}

/** Plain-language rendering of a machine-readable issue code. Names, never stored values. */
function describeIssue(issue: ConnectionHealthIssue, missingConfigKeys: readonly string[]): string {
  switch (issue) {
    case 'unknown_app':
      return 'This app is no longer in the catalog.';
    case 'missing_config':
      return `Missing required setting: ${missingConfigKeys.join(', ')}.`;
    case 'not_connected':
      return 'The connection is pending, not yet live.';
    default:
      return issue;
  }
}
