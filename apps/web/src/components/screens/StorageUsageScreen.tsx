'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ControlCenterSections } from '../admin/ControlCenterShell';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchOrganizationUsage } from '../../lib/api/usage';
import type { OrganizationUsage } from '../../lib/api/usage';
import { fetchSubscription } from '../../lib/api/subscription';
import type { SubscriptionView } from '../../lib/api/subscription';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/billing.css';

export interface StorageUsageScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/** Plan ids as the subscription endpoint names them, with the label a person reads. */
const PLAN_LABELS: Readonly<Record<string, string>> = {
  free: 'Free',
  starter: 'Starter',
  pro: 'Pro',
  business: 'Business',
};

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
      eyebrow="Control center · Billing"
      title="Plan and usage"
      actions={
        <div className="tm-bil-actions">
          <Link href={`/${organizationSlug}/billing/invoices`} className="tm-bil-capsule">
            Invoices
          </Link>
          <Link
            href={`/${organizationSlug}/billing/plan-change/request`}
            className="tm-bil-capsule tm-bil-capsule--ink"
          >
            Change plan
          </Link>
        </div>
      }
    >
      {usage.isPending ? (
        <LoadingRegion label="Loading storage usage." className="tm-stack tm-stack--tight">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {usage.isError ? (
        <InlineAlert tone="danger" title="Could not load storage usage" live>
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
                Who can see this
              </h2>
              <p className="tm-bil-card__body">
                Only owners. Project managers and members never see the plan, its usage or its
                invoices.
              </p>
              <p className="tm-bil-card__foot">
                Storage is measured in binary units — 1 GiB is 1,024 MiB.
              </p>
            </section>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}

function UsagePanel({ usage, plan }: { usage: OrganizationUsage; plan: SubscriptionView | null }) {
  const committed = usage.used + usage.reserved;
  const percent = usage.quota > 0 ? Math.min(100, Math.round((committed / usage.quota) * 100)) : 0;
  const valueText = `${formatBytes(committed)} of ${formatBytes(usage.quota)} used (${formatBytes(
    usage.reserved,
  )} reserved)`;
  const eyebrow = plan
    ? [
        `${planLabel(plan.planId)} plan`,
        plan.status === 'pending_change' ? 'change pending' : null,
        plan.currentPeriodEnd ? `renews ${formatDay(plan.currentPeriodEnd)}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : 'Storage';

  return (
    <div className="tm-bil-col tm-bil-col--wide tm-bil-main">
      <div className="tm-bil-figure">
        <p className="tm-bil-eyebrow">{eyebrow}</p>
        <p className="tm-bil-figure__value">{percent}% of storage in use</p>
        <p className="tm-bil-figure__note">{valueText}.</p>
      </div>

      <section className="tm-bil-card" aria-labelledby="tm-usage-heading">
        <h2 id="tm-usage-heading" className="tm-bil-card__title">
          Usage against the plan
        </h2>

        <ul className="tm-bil-meters">
          <li className="tm-bil-meter">
            <span className="tm-bil-meter__label">File storage</span>
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
            <dt>Used</dt>
            <dd className="tm-mono">{formatBytes(usage.used)}</dd>
          </div>
          <div className="tm-detail-list__pair">
            <dt>Reserved</dt>
            <dd className="tm-mono">{formatBytes(usage.reserved)}</dd>
          </div>
          <div className="tm-detail-list__pair">
            <dt>Quota</dt>
            <dd className="tm-mono">{formatBytes(usage.quota)}</dd>
          </div>
        </dl>

        <hr className="tm-bil-rule" />

        <p className="tm-bil-card__foot">
          {usage.reconciledAt === null
            ? 'Never reconciled against the storage ledger.'
            : `Last reconciled ${formatMoment(usage.reconciledAt)}.`}{' '}
          Nothing here throttles work.
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
  return (
    <section className="tm-bil-card" aria-labelledby="tm-usage-plan-heading">
      <h2 id="tm-usage-plan-heading" className="tm-bil-card__title">
        Plan
      </h2>
      <dl className="tm-detail-list">
        <div className="tm-detail-list__pair">
          <dt>Plan</dt>
          <dd>{planLabel(plan.planId)}</dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>Status</dt>
          <dd>{plan.status === 'pending_change' ? 'Change pending' : 'Active'}</dd>
        </div>
        <div className="tm-detail-list__pair">
          <dt>Renews</dt>
          <dd className="tm-mono">
            {plan.currentPeriodEnd === null ? 'No renewal date' : formatDay(plan.currentPeriodEnd)}
          </dd>
        </div>
      </dl>
      <hr className="tm-bil-rule" />
      <div className="tm-bil-actions">
        <Link href={`/${organizationSlug}/billing/subscription`} className="tm-bil-capsule">
          Subscription
        </Link>
        <Link href={`/${organizationSlug}/billing/seats`} className="tm-bil-capsule">
          Seats
        </Link>
        <Link href={`/${organizationSlug}/billing/settings`} className="tm-bil-capsule">
          Billing profile
        </Link>
      </div>
    </section>
  );
}

function planLabel(planId: string): string {
  return PLAN_LABELS[planId] ?? planId;
}

function formatDay(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(at);
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}

/**
 * Bytes as the person who owns the quota reads them — binary units, because storage is sold and
 * measured in powers of 1024. A whole multiple loses its decimal (`3 GiB`, not `3.0 GiB`); a
 * partial one keeps one place. Zero is `0 B`, never the largest unit at `0`.
 */
const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

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
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}
