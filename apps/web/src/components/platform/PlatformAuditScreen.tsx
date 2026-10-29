'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert } from '@tmanage/ui';
import { describe, formatMoment, Loading, PlatformGate } from './shared/platform-kit';
import type { ScreenProps } from './shared/platform-kit';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import type { ApiClient } from '../../lib/api/client';
import { listPlatformAudit } from '../../lib/api/platform-admin';

// ── Audit ───────────────────────────────────────────────────────────────────

export function PlatformAuditScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  return (
    <PlatformGate
      api={api}
      section="activity"
      crumbs={[t('PlatformAdminScreens.auditCrumb')]}
      title={t('PlatformAdminScreens.auditTitle')}
      description={t('PlatformAdminScreens.auditDescription')}
    >
      {() => <AuditBody api={api} />}
    </PlatformGate>
  );
}

function AuditBody({ api }: { api: ApiClient }) {
  const t = useT();
  const events = useQuery({
    queryKey: ['platform', 'audit'],
    queryFn: () => listPlatformAudit(api),
  });
  if (events.isPending) return <Loading label={t('PlatformAdminScreens.loadingAudit')} />;
  if (events.isError) {
    return (
      <InlineAlert tone="danger" title={t('PlatformAdminScreens.couldNotLoadAudit')} live>
        {describe(events.error, t)}
      </InlineAlert>
    );
  }
  if (events.data.length === 0) {
    return <InlineAlert tone="neutral">{t('PlatformAdminScreens.noActionsYet')}</InlineAlert>;
  }
  return (
    <section
      className="tm-cc-card tm-cc-card--flush"
      aria-label={t('PlatformAdminScreens.auditTitle')}
    >
      <table
        className="tm-table tm-cc-table"
        aria-label={t('PlatformAdminScreens.auditTableLabel')}
      >
        <thead>
          <tr>
            <th scope="col">{t('PlatformAdminScreens.colWhen')}</th>
            <th scope="col">{t('PlatformAdminScreens.colWho')}</th>
            <th scope="col">{t('PlatformAdminScreens.colAction')}</th>
            <th scope="col">{t('PlatformAdminScreens.colTarget')}</th>
            <th scope="col">{t('PlatformAdminScreens.colReason')}</th>
          </tr>
        </thead>
        <tbody>
          {events.data.map((event) => (
            <tr key={event.id}>
              <td>
                <span className="tm-cc-cell-sub">{formatMoment(event.occurredAt)}</span>
              </td>
              <td>
                <span className="tm-cc-cell-sub">{event.actorEmail}</span>
              </td>
              <td className="tm-cc-cell-mono">{event.action}</td>
              <td>
                <span className="tm-cc-cell-sub">{event.targetLabel ?? event.targetType}</span>
              </td>
              <td>
                <span className="tm-cc-cell-sub">{event.reason}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
