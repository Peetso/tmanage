'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ControlCenterSections } from '../admin/ControlCenterShell';
import { AppShell } from '../shell/AppShell';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchOrganizationUsage } from '../../lib/api/usage';
import type { OrganizationUsage } from '../../lib/api/usage';
import { fetchSubscription } from '../../lib/api/subscription';
import type { SubscriptionView } from '../../lib/api/subscription';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/billing.css';
import { appLocale } from '../../lib/i18n/app-locale';

export interface StorageUsageScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Storage usage** — the billing home (BIL-01 "Plan and usage"). It shows what
 * `49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY` §8 asks for — used, reserved and quota — read from
 * `GET /v1/organizations/:orgSlug/usage`, laid out the way BIL-01 draws the plan: a figure on the
 * left with the "Usage against the plan" card under it, and the plan and "who can see this" cards
 * on the right.
 *
 * Three decisions worth stating:
 *
 * 1. **Reached from the Control Center.** Billing is not one of the eight rail destinations
 *    (`22-SCREEN-BY-SCREEN` §1), so the Control orb is the one marked current.
 * 2. **Authorization is the API's.** The reads sit behind `org.manage` (owners only); a refusal
 *    becomes the forbidden line, never a blank page. The plan card reads the subscription
 *    (`GET …/billing/subscription`) and simply stays away when that read is refused or absent.
 * 3. **One bar, no band.** `(used + reserved) / quota` is drawn once, in a neutral ink fill, with
 *    no threshold colour — the threshold band is a separate counter (USAGE-001 x63).
 */
export function StorageUsageScreen({
  organizationSlug,
  organizationName,
  client,
}: StorageUsageScreenProps) {
  const describe = useDescribeApiError();
  const t = useT();
  const api = client ?? browserApiClient();

  const usage = useQuery({
    queryKey: ['organization-usage', organizationSlug],
    queryFn: () => fetchOrganizationUsage(api, organizationSlug),
  });

  const subscription = useQuery({
    queryKey: ['organization-subscription', organizationSlug],
    queryFn: () => fetchSubscription(api, organizationSlug),
  });

  const plan =
    subscription.isSuccess && typeof subscription.data?.planId === 'string'
      ? subscription.data
      : null;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      contextRail={<ControlCenterSections organizationSlug={organizationSlug} section="billing" />}
      eyebrow={t('StorageUsageScreen.eyebrow')}
      title={t('StorageUsageScreen.title')}
      actions={
        <div className="tm-bil-actions">
          <Link href={`/${organizationSlug}/billing/invoices`} className="tm-bil-capsule">
            {t('StorageUsageScreen.invoices')}
          </Link>
          <Link
            href={`/${organizationSlug}/billing/plan-change/request`}
            className="tm-bil-capsule tm-bil-capsule--ink"
          >
            {t('StorageUsageScreen.changePlan')}
          </Link>
        </div>
      }
    >
      {usage.isPending ? (
        <LoadingRegion label={t('StorageUsageScreen.loading')} className="tm-stack tm-stack--tight">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {usage.isError ? (
        <InlineAlert tone="danger" title={t('StorageUsageScreen.loadError')} live>
          {describe(usage.error)}
        </InlineAlert>
      ) : null}

      {usage.isSuccess ? (
        <div className="tm-bil">
          <UsagePanel usage={usage.data} plan={plan} />
          <div className="tm-bil-col">
            {plan ? <PlanCard plan={plan} organizationSlug={organizationSlug} /> : null}
            <section
              className="tm-bil-card tm-bil-card--paper tm-bil-card--fill"
              aria-labelledby="tm-usage-audience-heading"
            >
              <h2 id="tm-usage-audience-heading" className="tm-bil-eyebrow">
                {t('StorageUsageScreen.whoCanSeeHeading')}
              </h2>
              <p className="tm-bil-card__body">{t('StorageUsageScreen.whoCanSeeBody')}</p>
            </section>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}

function UsagePanel({ usage, plan }: { usage: OrganizationUsage; plan: SubscriptionView | null }) {
  const t = useT();
  const committed = usage.used + usage.reserved;
  const percent = usage.quota > 0 ? Math.min(100, Math.round((committed / usage.quota) * 100)) : 0;
  const valueText = `${formatBytes(committed)} ${t('StorageUsageScreen.of')} ${formatBytes(
    usage.quota,
  )} ${t('StorageUsageScreen.usedOpenParen')}${formatBytes(usage.reserved)}${t('StorageUsageScreen.reservedCloseParen')}`;
  const eyebrow = plan
    ? [
        `${planLabel(plan.planId, t)} ${t('StorageUsageScreen.planWord')}`,
        plan.status === 'pending_change' ? t('StorageUsageScreen.changePending') : null,
        plan.currentPeriodEnd
          ? `${t('StorageUsageScreen.renews')} ${formatDay(plan.currentPeriodEnd)}`
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : t('StorageUsageScreen.storageFallback');

  return (
    <div className="tm-bil-col tm-bil-col--wide tm-bil-main">
      <div className="tm-bil-figure">
        <p className="tm-bil-eyebrow">{eyebrow}</p>
        <p className="tm-bil-figure__value">
          {percent}
          {t('StorageUsageScreen.percentStorageInUse')}
        </p>
        <p className="tm-bil-figure__note">{valueText}.</p>
      </div>

      <section className="tm-bil-card" aria-labelledby="tm-usage-heading">
        <h2 id="tm-usage-heading" className="tm-bil-card__title">
          {t('StorageUsageScreen.usageHeading')}
        </h2>

        <ul className="tm-bil-meters">
          <li className="tm-bil-meter">
            <span className="tm-bil-meter__label">{t('StorageUsageScreen.fileStorage')}</span>
            <div
              className="tm-bil-meter__track"
              role="progressbar"
              aria-labelledby="tm-usage-heading"
              aria-valuemin={0}
              aria-valuemax={usage.quota}
              aria-valuenow={committed}
              aria-valuetext={valueText}
            >
              <div className="tm-bil-meter__fill" style={{ inlineSize: `${percent}%` }} />
            </div>
            <span className="tm-bil-meter__value">{percent}%</span>
          </li>
        </ul>

        <dl className="tm-detail-list">
          <div className="tm-detail-list__pair">
            <dt>{t('StorageUsageScreen.usedLabel')}</dt>
            <dd className="tm-mono">{formatBytes(usage.used)}</dd>
          </div>
          <div className="tm-detail-list__pair">
            <dt>{t('StorageUsageScreen.reservedLabel')}</dt>
            <dd className="tm-mono">{formatBytes(usage.reserved)}</dd>
          </div>
          <div className="tm-detail-list__pair">
            <dt>{t('StorageUsageScreen.quotaLabel')}</dt>
            <dd className="tm-mono">{formatBytes(usage.quota)}</dd>
          </div>
        </dl>

        <hr className="tm-bil-rule" />

        <p className="tm-bil-card__foot">
          {usage.reconciledAt === null
            ? t('StorageUsageScreen.notCheckedYet')
            : `${t('StorageUsageScreen.lastCheckedPrefix')} ${formatMoment(usage.reconciledAt)}.`}{' '}
          {t('StorageUsageScreen.nothingSlows')}
        </p>
      </section>
    </div>
  );
}

function PlanCard({
  plan,
  organizationSlug,
}: {
  plan: SubscriptionView;
  organizationSlug: string;
}) {
  const t = useT();
  return (
    <section className="tm-bil-card" aria-labelledby="tm-usage-plan-heading">
      <h2 id="tm-usage-plan-heading" className="tm-bil-card__title">
        {t('StorageUsageScreen.planHeading')}
      </h2>
      <dl className="tm-detail-list">
        <div className="tm-detail-list__pair">
          <dt>{t('StorageUsageScreen.planHeading')}</dt>
          <dd>{planLabel(plan.planId, t)}</dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>{t('StorageUsageScreen.statusLabel')}</dt>
          <dd>
            {plan.status === 'pending_change'
              ? t('StorageUsageScreen.changePendingCap')
              : t('StorageUsageScreen.active')}
          </dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>{t('StorageUsageScreen.renewsLabel')}</dt>
          <dd className="tm-mono">
            {plan.currentPeriodEnd === null
              ? t('StorageUsageScreen.noRenewalDate')
              : formatDay(plan.currentPeriodEnd)}
          </dd>
        </div>
      </dl>
      <hr className="tm-bil-rule" />
      <div className="tm-bil-actions">
        <Link href={`/${organizationSlug}/billing/subscription`} className="tm-bil-capsule">
          {t('StorageUsageScreen.subscription')}
        </Link>
        <Link href={`/${organizationSlug}/billing/seats`} className="tm-bil-capsule">
          {t('StorageUsageScreen.seats')}
        </Link>
        <Link href={`/${organizationSlug}/billing/settings`} className="tm-bil-capsule">
          {t('StorageUsageScreen.billingProfile')}
        </Link>
      </div>
    </section>
  );
}

/** Plan ids as the subscription endpoint names them, with the label a person reads. */
function planLabel(planId: string, t: (key: MessageKey) => string): string {
  const labels: Record<string, string> = {
    free: t('StorageUsageScreen.planFree'),
    starter: t('StorageUsageScreen.planStarter'),
    pro: t('StorageUsageScreen.planPro'),
    business: t('StorageUsageScreen.planBusiness'),
  };
  return labels[planId] ?? planId;
}

function formatDay(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(appLocale(), { dateStyle: 'medium' }).format(at);
}

/**
 * Bytes as the person who owns the quota reads them — the familiar GB/MB labels every operating
 * system shows, scaled in powers of 1024. A whole multiple loses its decimal (`3 GB`, not
 * `3.0 GB`); a partial one keeps one place. Zero is `0 B`, never the largest unit at `0`.
 */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} ${UNITS[unit]}`;
}

/**
 * Format an ISO timestamp for display, following the browser's locale for the reason
 * `SessionsScreen` gives. An unparseable value is shown verbatim rather than as `Invalid Date`.
 */
function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(appLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
    at,
  );
}
