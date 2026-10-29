import { connect } from 'node:tls';
import type { PeerCertificate } from 'node:tls';

/**
 * 56-30. The origin's own TLS certificate, read from the API (`checks.origin_tls` of
 * `GET /healthz/deep`).
 *
 * Behind Cloudflare in Full (strict) mode, an expired or replaced origin certificate is a 526 for
 * every visitor while the API itself stays healthy — nothing else in the deep check would notice.
 * So the API dials its own origin (`ORIGIN_TLS_PROBE_ADDRESS`, e.g. `<origin ip>:443`, with SNI =
 * the public host), reads the leaf certificate and reports how many days it has left. The runbook
 * is `docs/runbooks/origin-tls-526.md`.
 *
 * `rejectUnauthorized: false` on purpose: a Cloudflare Origin CA certificate is not publicly
 * trusted, and we only *read* the leaf — nothing is sent over this connection.
 */

export interface OriginTlsReading {
  readonly issuer: string;
  readonly subject: string;
  /** ISO-8601. */
  readonly notAfter: string;
  /** Whole days until `notAfter`, rounded down; negative once expired. */
  readonly daysLeft: number;
}

export interface OriginTlsTarget {
  /** `host:port` or `[v6]:port`; port 443 when omitted. */
  readonly address: string;
  /** SNI; omitted = none. */
  readonly servername?: string | undefined;
  readonly timeoutMs?: number;
}

export type OriginTlsState = 'ok' | 'fail' | 'not_configured';

export type OriginTlsCheck =
  | {
      readonly state: 'ok' | 'fail';
      readonly issuer: string | null;
      readonly notAfter: string | null;
      readonly daysLeft: number | null;
    }
  | { readonly state: 'not_configured' };

/** At or below this many days the reading is `fail` (and the operator is mailed daily). */
export const ORIGIN_TLS_FAIL_DAYS = 14;
/** One handshake per hour at most: a public health route must stay cheap. */
export const ORIGIN_TLS_CACHE_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** `1.2.3.4:443` / `host` / `[::1]:8443` → host and port. */
export function parseOriginAddress(address: string): { host: string; port: number } | null {
  const trimmed = address.trim();
  const match = /^(?:\[([^\]]+)\]|([^:\s]+))(?::(\d{1,5}))?$/u.exec(trimmed);
  const host = match?.[1] ?? match?.[2];
  if (host === undefined) return null;
  const port = match?.[3] === undefined ? 443 : Number(match[3]);
  return port >= 1 && port <= 65_535 ? { host, port } : null;
}

function nameOf(entity: PeerCertificate['issuer'] | undefined): string {
  if (entity === undefined) return '';
  const parts: string[] = [];
  for (const key of ['CN', 'O'] as const) {
    const value = entity[key] as string | string[] | undefined;
    if (value !== undefined) parts.push(`${key}=${Array.isArray(value) ? value.join('+') : value}`);
  }
  return parts.join(', ');
}

export function daysUntil(notAfter: Date, now: Date): number {
  return Math.floor((notAfter.getTime() - now.getTime()) / DAY_MS);
}

/** One handshake; the leaf certificate, or `null` on refusal, timeout or an unreadable cert. */
export function readOriginTls(
  target: OriginTlsTarget,
  now: Date = new Date(),
): Promise<OriginTlsReading | null> {
  const parsed = parseOriginAddress(target.address);
  if (parsed === null) return Promise.resolve(null);
  return new Promise((done) => {
    let settled = false;
    const finish = (value: OriginTlsReading | null): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(value);
    };
    const socket = connect({
      host: parsed.host,
      port: parsed.port,
      rejectUnauthorized: false,
      ...(target.servername === undefined || target.servername === ''
        ? {}
        : { servername: target.servername }),
    });
    socket.setTimeout(target.timeoutMs ?? 5_000, () => finish(null));
    socket.once('error', () => finish(null));
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const notAfter = new Date(cert.valid_to);
      if (Number.isNaN(notAfter.getTime())) return finish(null);
      finish({
        issuer: nameOf(cert.issuer),
        subject: nameOf(cert.subject),
        notAfter: notAfter.toISOString(),
        daysLeft: daysUntil(notAfter, now),
      });
    });
  });
}

/** `undefined` = no probe address configured; `null` = configured but unreadable. */
export function originTlsState(
  reading: OriginTlsReading | null | undefined,
  now: Date,
): OriginTlsState {
  if (reading === undefined) return 'not_configured';
  if (reading === null) return 'fail';
  return daysUntil(new Date(reading.notAfter), now) > ORIGIN_TLS_FAIL_DAYS ? 'ok' : 'fail';
}

/** The narrow slice of `AlertNotifier` used here. */
export interface OriginTlsAlerts {
  notify(kind: string, facts: { detail: string }): Promise<unknown>;
}

/**
 * The cached reading the deep-health controller reports: one handshake per
 * {@link ORIGIN_TLS_CACHE_MS}, and on `fail` one `origin_tls:expiring` alert per UTC day
 * (`AlertNotifier`'s own 15-minute window is too short for a daily reminder).
 */
export class OriginTlsMonitor {
  private cached: { at: number; reading: OriginTlsReading | null } | null = null;
  private inFlight: Promise<OriginTlsReading | null> | null = null;
  private lastAlertDay: string | null = null;

  constructor(
    private readonly target: { address?: string | undefined; servername?: string | undefined },
    private readonly alerts: () => OriginTlsAlerts | null = () => null,
    private readonly read: (
      t: OriginTlsTarget,
      now: Date,
    ) => Promise<OriginTlsReading | null> = readOriginTls,
  ) {}

  async check(now: Date): Promise<OriginTlsCheck> {
    const address = this.target.address;
    if (address === undefined || address.trim() === '') return { state: 'not_configured' };
    if (this.cached === null || now.getTime() - this.cached.at > ORIGIN_TLS_CACHE_MS) {
      this.inFlight ??= this.read({ address, servername: this.target.servername }, now)
        .catch(() => null)
        .finally(() => {
          this.inFlight = null;
        });
      this.cached = { at: now.getTime(), reading: await this.inFlight };
    }
    const reading = this.cached.reading;
    const state = originTlsState(reading, now) === 'ok' ? 'ok' : 'fail';
    const daysLeft = reading === null ? null : daysUntil(new Date(reading.notAfter), now);
    if (state === 'fail') await this.alertOncePerDay(now, daysLeft);
    return {
      state,
      issuer: reading?.issuer ?? null,
      notAfter: reading?.notAfter ?? null,
      daysLeft,
    };
  }

  private async alertOncePerDay(now: Date, daysLeft: number | null): Promise<void> {
    const day = now.toISOString().slice(0, 10);
    if (this.lastAlertDay === day) return;
    const notifier = this.alerts();
    if (notifier === null) return;
    this.lastAlertDay = day;
    await notifier
      .notify('origin_tls:expiring', {
        detail: daysLeft === null ? 'unreadable' : `daysLeft=${String(daysLeft)}`,
      })
      .catch(() => undefined);
  }
}
