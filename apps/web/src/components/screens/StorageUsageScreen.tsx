'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchOrganizationUsage } from '../../lib/api/usage';
import type { OrganizationUsage } from '../../lib/api/usage';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface StorageUsageScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Storage usage** — the billing screen `49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY` §8 asks
 * for: "show used, reserved and quota". USAGE-001 slice 5 shipped the read
 * (`GET /v1/organizations/:orgSlug/usage`) and its client shape; this is the screen that reads it.
 *
 * Three decisions worth stating:
 *
 * 1. **No rail item.** `22-SCREEN-BY-SCREEN` §1 fixes the internal rail at eight destinations and
 *    billing is not one of them, so — exactly as `RequestInboxScreen` did for Requests — none is
 *    invented. The screen has its own route and is reached from there.
 * 2. **Authorization is the API's.** The read sits behind `org.manage`; a member without it gets
 *    the ordinary 403, which `describe()` turns into the forbidden line. The screen never guesses
 *    a capability of its own and never renders blank on a refusal.
 * 3. **One bar, no band.** `(used + reserved) / quota` is drawn once, in a neutral ink fill, with
 *    no threshold colour — the threshold band is a separate counter (USAGE-001 x63) and is not
 *    this view's to show.
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

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Storage usage"
      description="What this organization has stored, reserved and is entitled to."
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

      {usage.isSuccess ? <UsagePanel usage={usage.data} /> : null}
    </AppShell>
  );
}

function UsagePanel({ usage }: { usage: OrganizationUsage }) {
  const committed = usage.used + usage.reserved;
  const percent = usage.quota > 0 ? Math.min(100, Math.round((committed / usage.quota) * 100)) : 0;
  const valueText = `${formatBytes(committed)} of ${formatBytes(usage.quota)} used (${formatBytes(
    usage.reserved,
  )} reserved)`;

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-usage-heading">
      <h2 id="tm-usage-heading" className="tm-eyebrow">
        This organization
      </h2>

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

      <div className="tm-usage-meter">
        <div
          className="tm-usage-meter__track"
          role="progressbar"
          aria-labelledby="tm-usage-heading"
          aria-valuemin={0}
          aria-valuemax={usage.quota}
          aria-valuenow={committed}
          aria-valuetext={valueText}
        >
          <div className="tm-usage-meter__fill" style={{ inlineSize: `${percent}%` }} />
        </div>
        <p className="tm-prose tm-mono">{valueText}</p>
      </div>

      <p className="tm-prose">
        {usage.reconciledAt === null
          ? 'Never reconciled against the storage ledger.'
          : `Last reconciled ${formatMoment(usage.reconciledAt)}.`}
      </p>
    </section>
  );
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
