import type { PlatformSuspiciousPatternView, PlatformSuspiciousView } from './activity.service.js';

/**
 * C3 · Suspicious (platform-admin v2 · PA-09) — unusual sign-in patterns folded out of the
 * failure rows of a window. Pure: the repository hands over the rows, this decides.
 *
 * - **Burst from one IP**: at least {@link IP_BURST_MIN} failed attempts from one address;
 * - **Repeated failures**: at least {@link ACCOUNT_FAILURES_MIN} failed attempts on one account
 *   (from any number of addresses);
 * - **Sign-in from a new country**: needs a GeoIP lookup that is not switched on yet, so the
 *   answer says `geoAvailable: false` and the screen shows the placeholder note.
 *
 * "Locked" when any of the pattern's rows was refused by the abuse control (a lockout or a rate
 * limit) rather than by a wrong secret.
 */

export const SUSPICIOUS_WINDOWS = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
} as const;
export type SuspiciousWindow = keyof typeof SUSPICIOUS_WINDOWS;

export const IP_BURST_MIN = 10;
export const ACCOUNT_FAILURES_MIN = 5;

/** The GeoIP lookup is not wired yet (SPEC §4 C3: "placeholder"). */
export const GEOIP_AVAILABLE = false;

export interface FailureEvent {
  readonly ip: string | null;
  readonly userId: string | null;
  readonly email: string | null;
  readonly outcome: string;
  readonly reason: string | null;
  readonly occurredAt: Date;
}

export function parseWindow(raw: unknown): SuspiciousWindow {
  return raw === '1h' || raw === '7d' ? raw : '24h';
}

export function windowStart(window: SuspiciousWindow, now: Date): Date {
  return new Date(now.getTime() - SUSPICIOUS_WINDOWS[window]);
}

function isLock(event: FailureEvent): boolean {
  const reason = (event.reason ?? '').toLowerCase();
  return (
    event.outcome === 'locked' ||
    reason.includes('lock') ||
    reason.includes('rate') ||
    reason.includes('budget')
  );
}

interface Group {
  readonly events: FailureEvent[];
}

function fold(
  kind: PlatformSuspiciousPatternView['kind'],
  source: string,
  group: Group,
): PlatformSuspiciousPatternView {
  const times = group.events.map((event) => event.occurredAt.getTime());
  const accounts = new Set(
    group.events.map((event) => event.userId ?? event.email ?? '').filter((key) => key !== ''),
  );
  const userIds = new Set(group.events.map((event) => event.userId).filter((id) => id !== null));
  return {
    kind,
    source,
    userId: kind === 'repeated_failures' && userIds.size === 1 ? ([...userIds][0] ?? null) : null,
    accountsHit: kind === 'repeated_failures' ? 1 : accounts.size,
    failures: group.events.length,
    firstAt: new Date(Math.min(...times)).toISOString(),
    lastAt: new Date(Math.max(...times)).toISOString(),
    status: group.events.some(isLock) ? 'locked' : 'open',
  };
}

export function detectSuspicious(
  events: readonly FailureEvent[],
  window: SuspiciousWindow,
  thresholds: { readonly ipBurstMin?: number; readonly accountFailuresMin?: number } = {},
): PlatformSuspiciousView {
  const ipMin = thresholds.ipBurstMin ?? IP_BURST_MIN;
  const accountMin = thresholds.accountFailuresMin ?? ACCOUNT_FAILURES_MIN;
  const byIp = new Map<string, Group>();
  const byAccount = new Map<string, Group>();
  for (const event of events) {
    if (event.ip) {
      const group = byIp.get(event.ip) ?? { events: [] };
      group.events.push(event);
      byIp.set(event.ip, group);
    }
    const account = event.userId ?? null;
    if (account) {
      const group = byAccount.get(account) ?? { events: [] };
      group.events.push(event);
      byAccount.set(account, group);
    }
  }
  const patterns: PlatformSuspiciousPatternView[] = [];
  for (const [ip, group] of byIp) {
    if (group.events.length >= ipMin) patterns.push(fold('ip_burst', ip, group));
  }
  for (const [, group] of byAccount) {
    if (group.events.length < accountMin) continue;
    const label = group.events.find((event) => event.email)?.email ?? group.events[0]?.userId ?? '';
    patterns.push(fold('repeated_failures', label, group));
  }
  patterns.sort((a, b) =>
    a.status !== b.status
      ? a.status === 'open'
        ? -1
        : 1
      : b.failures - a.failures || b.lastAt.localeCompare(a.lastAt),
  );
  return { window, patterns, geoAvailable: GEOIP_AVAILABLE };
}
