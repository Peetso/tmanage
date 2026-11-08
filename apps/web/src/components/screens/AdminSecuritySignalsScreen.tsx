'use client';

import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, StatusDot } from '@tmanage/ui';
import type { StatusTone } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  ORGANIZATION_SIGNAL_KINDS,
  listSecuritySignals,
  markSignalReviewed,
} from '../../lib/api/admin-security-signals';
import type {
  PeriodFilter,
  ReviewFilter,
  SecuritySignalView,
  SignalFilters,
} from '../../lib/api/admin-security-signals';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useOrganizationName } from '../../lib/use-organization-names';
import { SECURITY_SIGNALS_COPY } from './security-signals-copy';
import type { SecuritySignalsCopyKey } from './security-signals-copy';
import '../../styles/screens/r44-security-growth.css';

export interface AdminSecuritySignalsScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

const SEVERITY: Record<string, { tone: StatusTone; key: SecuritySignalsCopyKey }> = {
  high: { tone: 'danger', key: 'severityHigh' },
  medium: { tone: 'warning', key: 'severityMedium' },
  low: { tone: 'neutral', key: 'severityLow' },
};

/** The kind labels before any signal of that kind arrives (the API carries its own on each row). */
const KIND_LABELS: Record<string, { en: string; ar: string }> = {
  permission_churn: { en: 'Rapid permission changes', ar: 'تغييرات سريعة في الصلاحيات' },
  mass_export: { en: 'Several exports by one person', ar: 'عمليات تصدير متعددة من شخص واحد' },
  invitation_burst: { en: 'Unusual number of invitations', ar: 'عدد غير معتاد من الدعوات' },
  public_link_guessing: {
    en: 'Repeated wrong codes on public links',
    ar: 'رموز خاطئة متكررة على الروابط العامة',
  },
  audit_chain_break: { en: 'Audit log chain check failed', ar: 'فشل فحص سلسلة سجل التدقيق' },
  support_session_long: { en: 'Support session open too long', ar: 'جلسة دعم مفتوحة لمدة طويلة' },
  webhook_breaker: { en: 'A webhook keeps failing', ar: 'فشل متكرر في خطاف ويب' },
};

function useCopy(): (key: SecuritySignalsCopyKey) => string {
  const tOr = useTOr();
  return useCallback(
    (key: SecuritySignalsCopyKey) => tOr(`SecuritySignals.${key}`, SECURITY_SIGNALS_COPY[key]),
    [tOr],
  );
}

/**
 * **Security signals** (56-23 owner view, Figma 578:32859 "Security signals · EN/AR") — the
 * company's own signals from the worker's detector, filtered by review state, kind and period,
 * with a write-once "Mark reviewed". Platform-only signals never reach an organization.
 */
export function AdminSecuritySignalsScreen({
  organizationSlug,
  organizationName: passedName,
  client,
}: AdminSecuritySignalsScreenProps) {
  const organizationName = useOrganizationName(organizationSlug, passedName);
  const api = client ?? browserApiClient();
  const copy = useCopy();
  const describe = useDescribeApiError();
  const locale = useActiveLocale();
  const queries = useQueryClient();
  const [filters, setFilters] = useState<SignalFilters>({
    review: 'open',
    kind: null,
    period: '30d',
  });
  const [markingId, setMarkingId] = useState<string | null>(null);
  const listKey = ['admin-security-signals', organizationSlug];

  const signals = useQuery({
    queryKey: [...listKey, filters],
    queryFn: () => listSecuritySignals(api, organizationSlug, filters),
  });
  const mark = useMutation({
    mutationFn: (signalId: string) => markSignalReviewed(api, organizationSlug, signalId),
    onMutate: (signalId: string) => setMarkingId(signalId),
    onSettled: async () => {
      setMarkingId(null);
      await queries.invalidateQueries({ queryKey: listKey });
    },
  });

  const label = (entry: { en: string; ar: string }) =>
    locale.startsWith('ar') ? entry.ar : entry.en;
  const reviews: readonly { id: ReviewFilter; key: SecuritySignalsCopyKey }[] = [
    { id: 'open', key: 'notReviewed' },
    { id: 'all', key: 'all' },
  ];
  const periods: readonly { id: PeriodFilter; key: SecuritySignalsCopyKey }[] = [
    { id: '7d', key: 'last7' },
    { id: '30d', key: 'last30' },
    { id: 'all', key: 'anyTime' },
  ];
  const rows = signals.data?.events ?? [];

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="security"
      crumbs={[copy('crumbSecurity'), copy('title')]}
      title={copy('title')}
    >
      <p className="tm-r44-lede">{copy('description')}</p>

      <div className="tm-r44-chips" role="group" aria-label={copy('filtersLabel')}>
        {reviews.map((item) => (
          <button
            key={item.id}
            type="button"
            className={filters.review === item.id ? 'tm-chip tm-chip--active' : 'tm-chip'}
            aria-pressed={filters.review === item.id}
            onClick={() => setFilters({ ...filters, review: item.id })}
          >
            {copy(item.key)}
          </button>
        ))}
        {ORGANIZATION_SIGNAL_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            className={filters.kind === kind ? 'tm-chip tm-chip--active' : 'tm-chip'}
            aria-pressed={filters.kind === kind}
            onClick={() => setFilters({ ...filters, kind: filters.kind === kind ? null : kind })}
          >
            {label(KIND_LABELS[kind] ?? { en: kind, ar: kind })}
          </button>
        ))}
        {periods.map((item) => (
          <button
            key={item.id}
            type="button"
            className={filters.period === item.id ? 'tm-chip tm-chip--active' : 'tm-chip'}
            aria-pressed={filters.period === item.id}
            onClick={() => setFilters({ ...filters, period: item.id })}
          >
            {copy(item.key)}
          </button>
        ))}
      </div>

      {signals.isPending ? (
        <LoadingRegion label={copy('loading')} className="tm-stack tm-stack--tight">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}
      {signals.isError ? (
        <InlineAlert tone="danger" title={copy('loadError')} live>
          {describe(signals.error)}
        </InlineAlert>
      ) : null}
      {mark.isError ? (
        <InlineAlert tone="danger" title={copy('reviewError')} live>
          {describe(mark.error)}
        </InlineAlert>
      ) : null}
      {signals.isSuccess && rows.length === 0 ? (
        <InlineAlert tone="neutral">{copy('empty')}</InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <section className="tm-cc-card tm-cc-card--flush" aria-labelledby="tm-signals-heading">
          <h2 id="tm-signals-heading" className="tm-visually-hidden">
            {copy('title')}
          </h2>
          <table className="tm-table tm-cc-table" aria-label={copy('tableLabel')}>
            <thead>
              <tr>
                <th scope="col">{copy('colSignal')}</th>
                <th scope="col">{copy('colSeverity')}</th>
                <th scope="col">{copy('colCount')}</th>
                <th scope="col">{copy('colLastSeen')}</th>
                <th scope="col">
                  <span className="tm-visually-hidden">{copy('colActions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((signal) => (
                <SignalRow
                  key={signal.id}
                  signal={signal}
                  label={label(signal.label)}
                  busy={mark.isPending && markingId === signal.id}
                  onReview={() => mark.mutate(signal.id)}
                />
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </ControlCenterShell>
  );
}

function SignalRow({
  signal,
  label,
  busy,
  onReview,
}: {
  signal: SecuritySignalView;
  label: string;
  busy: boolean;
  onReview: () => void;
}) {
  const copy = useCopy();
  const format = useDisplayFormatters();
  const severity = SEVERITY[signal.severity] ?? SEVERITY['low'];
  return (
    <tr>
      <th scope="row" className="tm-cc-cell-title">
        {label}
      </th>
      <td>{severity ? <StatusDot tone={severity.tone}>{copy(severity.key)}</StatusDot> : null}</td>
      <td className="tm-cc-cell-mono">{format.number(signal.count)}</td>
      <td className="tm-cc-cell-sub">
        {format.day(signal.lastSeen, {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })}
      </td>
      <td className="tm-cc-end">
        {signal.reviewedAt ? (
          <StatusDot tone="success">{copy('reviewed')}</StatusDot>
        ) : (
          <Button type="button" tone="outline" size="compact" disabled={busy} onClick={onReview}>
            {busy ? copy('marking') : copy('markReviewed')}
          </Button>
        )}
      </td>
    </tr>
  );
}
