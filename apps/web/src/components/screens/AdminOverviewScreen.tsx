'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchAdminOverview } from '../../lib/api/admin-overview';
import type { AdminOverviewView } from '../../lib/api/admin-overview';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface AdminOverviewScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Administration overview** — module 18 (x175, audit rank #9 "Admin Partial"). It reads
 * `GET /v1/organizations/:orgSlug/admin/overview` (gated on the server by `org.manage`) and renders
 * the org-health roll-up as accessible stat tiles, with links to the existing administration
 * sub-screens (audit log, members, offboarding, settings) so the overview is the module's front door.
 *
 * The decisions are the sibling admin screens':
 * 1. **Authorization is the API's.** A caller without `org.manage` gets the ordinary 403, which
 *    `describe()` turns into a sentence in the panel's own alert; the screen never guesses a
 *    capability of its own and never renders blank on a refusal.
 * 2. **No invented numbers.** Every figure is the API's; the audit window it was computed over is
 *    shown plainly rather than assumed.
 * 3. **No new nav destination.** Administration is not one of the eight internal-rail destinations
 *    (`22-SCREEN-BY-SCREEN` §1), so the shell names none — the screen is reached directly and links
 *    onward with ordinary in-app links.
 */
export function AdminOverviewScreen({
  organizationSlug,
  organizationName,
  client,
}: AdminOverviewScreenProps) {
  const api = client ?? browserApiClient();

  const overview = useQuery({
    queryKey: ['admin-overview', organizationSlug],
    queryFn: () => fetchAdminOverview(api, organizationSlug),
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Administration"
      description="Organization health at a glance, with links to the administration screens."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-admin-overview-heading">
        <h2 id="tm-admin-overview-heading" className="tm-eyebrow">
          Organization health
        </h2>

        {overview.isPending ? (
          <LoadingRegion
            label="Loading the organization overview."
            className="tm-stack tm-stack--tight"
          >
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {overview.isError ? (
          <InlineAlert tone="danger" title="Could not load the organization overview" live>
            {describe(overview.error)}
          </InlineAlert>
        ) : null}

        {overview.isSuccess ? <OverviewMetrics overview={overview.data} /> : null}
      </section>

      <nav className="tm-panel tm-stack" aria-labelledby="tm-admin-links-heading">
        <h2 id="tm-admin-links-heading" className="tm-eyebrow">
          Administration
        </h2>
        <ul className="tm-stack tm-stack--tight">
          {ADMIN_LINKS.map(({ href, label, description }) => (
            <li key={href}>
              <Link href={`/${organizationSlug}${href}`} className="tm-prose">
                {label}
              </Link>
              <p className="tm-prose tm-muted">{description}</p>
            </li>
          ))}
        </ul>
      </nav>
    </AppShell>
  );
}

/** The administration sub-screens the overview links to, in the order they are shown. */
const ADMIN_LINKS: readonly { href: string; label: string; description: string }[] = [
  {
    href: '/admin/audit',
    label: 'Audit log',
    description: 'The append-only trail of what changed.',
  },
  {
    href: '/people',
    label: 'Members and roles',
    description: "The organization's people and their roles.",
  },
  {
    href: '/people/offboarding',
    label: 'Offboarding',
    description: 'Withdraw a member who is leaving.',
  },
  { href: '/settings', label: 'Settings and policy', description: 'Organization-wide settings.' },
];

/** The roll-up figures in the order they are shown, keyed to the fields the API returns. */
const METRICS: readonly { id: keyof AdminOverviewView; label: string; kind: 'count' | 'bytes' }[] =
  [
    { id: 'activeMembers', label: 'Active members', kind: 'count' },
    { id: 'seatsUsed', label: 'Seats used', kind: 'count' },
    { id: 'storageBytesUsed', label: 'Storage used', kind: 'bytes' },
    { id: 'auditEventsWindow', label: 'Audit events (30 days)', kind: 'count' },
    { id: 'openOffboardings', label: 'Offboardings in progress', kind: 'count' },
  ];

function OverviewMetrics({ overview }: { overview: AdminOverviewView }) {
  return (
    <>
      <dl className="tm-detail-list">
        {METRICS.map(({ id, label, kind }) => (
          <div className="tm-detail-list__pair" key={id}>
            <dt>{label}</dt>
            <dd className="tm-mono">
              {kind === 'bytes' ? formatBytes(overview.storageBytesUsed) : overview[id]}
            </dd>
          </div>
        ))}
      </dl>

      <p className="tm-prose">
        Audit events are counted over the last {overview.auditWindowDays} days.
      </p>
      <p className="tm-prose tm-mono">Computed {formatMoment(overview.computedAt)}.</p>
    </>
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
 * measured in powers of 1024. A whole multiple loses its decimal (`3 GiB`, not `3.0 GiB`); a partial
 * one keeps one place. Zero is `0 B`, never the largest unit at `0`. Mirrors `StorageUsageScreen`.
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
 * Format an ISO timestamp for display, following the browser's locale for the reason `SessionsScreen`
 * gives. An unparseable value is shown verbatim rather than as `Invalid Date`.
 */
function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}
