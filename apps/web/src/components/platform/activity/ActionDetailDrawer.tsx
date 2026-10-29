'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import { fetchPlatformActionDetail } from '../../../lib/api/platform-activity';
import { useT } from '../../../lib/i18n/use-t';
import { PlatformPageState } from '../shared/PlatformPageState';
import { PlatformDialog, PlatformDialogActions } from '../shared/ReasonDialog';
import { ACTIVITY_KEY, filterHref, moment } from './ActivityFrame';

/**
 * C2 · Action detail (platform-admin v2 · PA-09): who (and the role at the time, or the Support
 * session it was taken in), what changed field by field (redacted fields carry no values), the
 * request (IP, device, correlation id — only with `platform.activity.detail`), and the other
 * events of the same request. Opening it is itself recorded (`platform.action_detail_viewed`).
 */
export function ActionDetailDrawer({
  api,
  organizationId,
  eventId,
  onClose,
}: {
  api: ApiClient;
  organizationId: string;
  eventId: string;
  onClose: () => void;
}) {
  const t = useT();
  const detail = useQuery({
    queryKey: [...ACTIVITY_KEY, 'action', organizationId, eventId],
    queryFn: () => fetchPlatformActionDetail(api, organizationId, eventId),
    staleTime: 60_000,
  });

  return (
    <PlatformDialog
      eyebrow={t('PlatformActivity.detailEyebrow')}
      title={detail.data ? detail.data.action.actionLabel : t('PlatformActivity.detailTitle')}
      width={640}
      onClose={onClose}
    >
      {detail.isPending ? <PlatformPageState state="loading" /> : null}
      {detail.isError ? (
        <PlatformPageState
          state="error"
          error={detail.error}
          onRetry={() => void detail.refetch()}
        />
      ) : null}
      {detail.isSuccess ? (
        <div className="tm-stack">
          <section className="tm-cc-card tm-cc-card--quiet" aria-labelledby="pa-detail-who">
            <h3 id="pa-detail-who" className="tm-cc-eyebrow">
              {t('PlatformActivity.detailWho')}
            </h3>
            <p className="tm-cc-cell-title">
              {detail.data.action.actorName ??
                detail.data.action.actorEmail ??
                t('PlatformActivity.system')}
            </p>
            <p className="tm-cc-cell-sub">
              {detail.data.action.actorEmail ?? ''}
              {detail.data.actorRole
                ? ` · ${t('PlatformActivity.roleAtTime')} ${detail.data.actorRole}`
                : ''}
            </p>
            {detail.data.supportSession ? (
              <InlineAlert tone="warning" title={t('PlatformActivity.viaSupportTitle')}>
                {detail.data.supportSession.adminEmail} ·{' '}
                {moment(detail.data.supportSession.startedAt)}
                {detail.data.supportSession.reason
                  ? ` · “${detail.data.supportSession.reason}”`
                  : ''}
              </InlineAlert>
            ) : null}
          </section>

          <section className="tm-cc-card tm-cc-card--quiet" aria-labelledby="pa-detail-what">
            <h3 id="pa-detail-what" className="tm-cc-eyebrow">
              {t('PlatformActivity.detailWhat')}
            </h3>
            <p className="tm-cc-cell-sub">
              <span className="tm-cc-cell-mono">{detail.data.action.action}</span> ·{' '}
              {detail.data.action.objectType}
              {detail.data.action.objectId ? ` · ${detail.data.action.objectId}` : ''} ·{' '}
              {detail.data.action.organizationName} · {moment(detail.data.action.occurredAt)}
            </p>
            {detail.data.changes.length === 0 ? (
              <p className="tm-cc-note">{t('PlatformActivity.noChanges')}</p>
            ) : (
              <table
                className="tm-table tm-cc-table"
                aria-label={t('PlatformActivity.changesLabel')}
              >
                <thead>
                  <tr>
                    <th scope="col">{t('PlatformActivity.colField')}</th>
                    <th scope="col">{t('PlatformActivity.colBefore')}</th>
                    <th scope="col">{t('PlatformActivity.colAfter')}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.changes.map((change) => (
                    <tr key={change.field}>
                      <td className="tm-cc-cell-mono">{change.field}</td>
                      <td>
                        {change.redacted ? t('PlatformActivity.redacted') : (change.before ?? '—')}
                      </td>
                      <td>
                        {change.redacted ? t('PlatformActivity.redacted') : (change.after ?? '—')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="tm-cc-card tm-cc-card--quiet" aria-labelledby="pa-detail-request">
            <h3 id="pa-detail-request" className="tm-cc-eyebrow">
              {t('PlatformActivity.detailRequest')}
            </h3>
            <dl className="tm-stack tm-stack--tight">
              <div>
                <dt className="tm-cc-cell-sub">{t('PlatformActivity.colIp')}</dt>
                <dd className="tm-cc-cell-mono">
                  {detail.data.action.ip ?? t('PlatformActivity.hidden')}
                </dd>
              </div>
              <div>
                <dt className="tm-cc-cell-sub">{t('PlatformActivity.colDevice')}</dt>
                <dd>{detail.data.action.userAgent ?? t('PlatformActivity.hidden')}</dd>
              </div>
              <div>
                <dt className="tm-cc-cell-sub">{t('PlatformActivity.correlationId')}</dt>
                <dd className="tm-cc-cell-mono">{detail.data.action.correlationId}</dd>
              </div>
            </dl>
            {detail.data.sameCorrelation.length > 0 ? (
              <ul
                className="tm-stack tm-stack--tight"
                aria-label={t('PlatformActivity.sameRequest')}
              >
                {detail.data.sameCorrelation.map((related) => (
                  <li key={related.id} className="tm-cc-cell-sub">
                    {moment(related.occurredAt)} · {related.actionLabel} · {related.result}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <PlatformDialogActions>
            <Link
              className="tm-cc-pill"
              href={filterHref('/platform/activity', {
                organizationId: detail.data.action.organizationId,
                correlationId: detail.data.action.correlationId,
              })}
              onClick={onClose}
            >
              {t('PlatformActivity.showSameRequest')}
            </Link>
            <Button type="button" tone="outline" onClick={onClose}>
              {t('PlatformActivity.close')}
            </Button>
          </PlatformDialogActions>
        </div>
      ) : null}
    </PlatformDialog>
  );
}
