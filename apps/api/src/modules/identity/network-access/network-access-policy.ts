/**
 * SEC-ALERTS item 7 — "no VPN, proxy, Tor or data-centre access" (Peter, 2026-11-22). The pure
 * decision of the sign-in door: given what is known about the address and the browser, refuse or
 * let through. No I/O; `network-access.service.ts` gathers the inputs.
 *
 * ## Layers (the block list first; then any strong layer refuses; the allowlist overrides those)
 *
 * - **0, the platform's own block list** (SEC-TRACKER, 0406): an address or CIDR a platform admin
 *   blocked by hand is refused before anything else is read, **whether the policy switch is on or
 *   off**, and recorded with its own reason ({@link SOURCE_BLOCKED_REASON}). A block never
 *   overlaps an allowlist entry (the API answers 409 on both sides), so there is no precedence
 *   puzzle; should one arise anyway (an env allowlist entry), the block wins.
 * - **A, the address** (strong): on a free block list (X4BNet VPN or data-centre ranges, the Tor
 *   exit list, IP2Proxy LITE open proxies), a Tor exit by the in-memory list, an ASN in
 *   `HOSTING_ASNS` or `VPN_PROVIDER_ASNS`. Owner-name keywords ("cloud", "vpn", …) are **weak**
 *   only: they also match ordinary carriers ("Google Fiber"), so they score but never refuse.
 * - **B, the browser** (time zone strong, language weak): the browser's IANA time zone, sent by
 *   the web client as `x-client-time-zone`, against the time zones of the address's country
 *   (IANA `zone.tab`, `geo/country-time-zones.ts`). A zone of that country, or one whose UTC
 *   offset is within {@link TZ_TOLERANCE_MINUTES} of one of them right now, is a match. A browser
 *   in Cairo time behind a Frankfurt address is the VPN shape. `UTC`/`Etc/*` is weak only:
 *   privacy-hardened browsers report it everywhere. The browser language's region (`ar-EG`)
 *   against the country is weak only: people travel and expats keep their language.
 *   WebRTC is not used: browsers mask local candidates with mDNS since 2019, so the only thing
 *   it would add is the public address the request already carries — at the cost of a STUN round
 *   trip to a third party from the sign-in page. Skipped for privacy and for no gain.
 * - **C, the account** (recorded only): how many countries and networks the named account was
 *   seen from in the last 24 hours. A score for the tracker and the log, never a refusal: a
 *   person on a train changes networks.
 *
 * ## Fail-open (decided, SEC-ALERTS item 7)
 *
 * Unknown is allowed; only known is refused. No GeoIP file, no ASN, no browser time zone, a list
 * not fetched yet: each makes its layer silent, never a refusal. The door must not lock out the
 * whole world when a download fails. What this cannot see: residential-proxy VPNs and self-hosted
 * VPNs on home lines look like any home connection to free data (see the lane report).
 */
import { HOSTING_ASNS, hasVpnKeyword, isHostingNetwork } from '../geo/hosting-asns.js';
import { COUNTRY_TIME_ZONES } from '../geo/country-time-zones.js';
import { VPN_PROVIDER_ASNS } from '../geo/vpn-provider-asns.js';
import { GUARD_REFUSAL_ACTIONS } from '../../../common/http/authentication-event-recorder.js';

export const TZ_TOLERANCE_MINUTES = 60;
export const SPREAD_COUNTRIES = 3;
export const SPREAD_NETWORKS = 4;
export const SPREAD_WINDOW_MS = 24 * 3_600_000;

/** The `authentication_events` row of a refusal. */
export const NETWORK_GUARD_ACTION = GUARD_REFUSAL_ACTIONS.network;
export const VPN_REFUSED_REASON = 'vpn_refused';
/** SEC-TRACKER: refused because a platform admin blocked the address ("Refused · blocked by you"). */
export const SOURCE_BLOCKED_REASON = 'source_blocked';

export type NetworkPolicyMode = 'refuse' | 'allow';
export type TimeZoneCheck = 'match' | 'mismatch' | 'utc' | 'unknown';
export type LanguageCheck = 'match' | 'mismatch' | 'unknown';

export interface NetworkAccessInput {
  readonly policy: NetworkPolicyMode;
  /** On the platform's own block list (layer 0): refused whatever the policy says. */
  readonly blocked: boolean;
  readonly allowlisted: boolean;
  /** Block lists whose active version holds the address (`x4b_datacenter`, …). */
  readonly listHits: readonly string[];
  readonly isTor: boolean;
  readonly asn: number | null;
  readonly networkOwner: string | null;
  readonly countryCode: string | null;
  readonly clientTimeZone: string | null;
  readonly clientLanguage: string | null;
  /** Layer C, when the request named an account that exists. */
  readonly accountSpread: { readonly countries: number; readonly networks: number } | null;
  readonly now: Date;
}

export interface NetworkAccessDecision {
  readonly refuse: boolean;
  readonly because:
    'blocked' | 'allowlisted' | 'policy_off' | 'address' | 'browser_time_zone' | 'clear';
  /** 0–100: 100 when refused, else the weak signals' sum. Stored as `automation_score`. */
  readonly score: number;
  /** Every layer's reading as fixed tokens. Stored as `automation_reasons_json`. */
  readonly reasons: readonly string[];
}

/** The UTC offset of an IANA zone at `at`, in minutes, or null when the zone is unknown. */
export function zoneOffsetMinutes(zone: string, at: Date): number | null {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
    if (part === undefined) return null;
    if (part === 'GMT') return 0;
    const m = /^GMT([+-])(\d{2}):?(\d{2})?$/u.exec(part);
    if (m === null) return null;
    const minutes = Number(m[2]) * 60 + Number(m[3] ?? '0');
    return m[1] === '-' ? -minutes : minutes;
  } catch {
    return null;
  }
}

export function checkTimeZone(
  clientZone: string | null,
  countryCode: string | null,
  at: Date,
): TimeZoneCheck {
  const zone = (clientZone ?? '').trim();
  if (zone === '' || zone.length > 64 || countryCode === null) return 'unknown';
  if (zone === 'UTC' || zone.startsWith('Etc/')) return 'utc';
  const zones = COUNTRY_TIME_ZONES[countryCode.toUpperCase()];
  if (zones === undefined) return 'unknown';
  if (zones.includes(zone)) return 'match';
  const client = zoneOffsetMinutes(zone, at);
  if (client === null) return 'unknown';
  for (const candidate of zones) {
    const offset = zoneOffsetMinutes(candidate, at);
    if (offset !== null && Math.abs(offset - client) <= TZ_TOLERANCE_MINUTES) return 'match';
  }
  return 'mismatch';
}

export function checkLanguage(language: string | null, countryCode: string | null): LanguageCheck {
  const region = /^[a-z]{2,3}[-_]([A-Za-z]{2})\b/u.exec((language ?? '').trim())?.[1];
  if (region === undefined || countryCode === null) return 'unknown';
  return region.toUpperCase() === countryCode.toUpperCase() ? 'match' : 'mismatch';
}

export function decideNetworkAccess(input: NetworkAccessInput): NetworkAccessDecision {
  // Layer 0, first and alone: a source the platform blocked is refused before any other reading.
  if (input.blocked)
    return { refuse: true, because: 'blocked', score: 100, reasons: ['net.blocked'] };
  const reasons: string[] = [];
  // Layer A.
  for (const list of input.listHits) reasons.push(`net.a.list:${list}`);
  if (input.isTor) reasons.push('net.a.tor');
  if (input.asn !== null && HOSTING_ASNS.has(input.asn)) reasons.push('net.a.hosting_asn');
  if (input.asn !== null && VPN_PROVIDER_ASNS.has(input.asn)) reasons.push('net.a.vpn_asn');
  const strongA = reasons.length > 0;
  const keyword =
    hasVpnKeyword(input.networkOwner) || (!strongA && isHostingNetwork(null, input.networkOwner));
  if (keyword) reasons.push('net.a_weak.owner_keyword');
  // Layer B.
  const tz = checkTimeZone(input.clientTimeZone, input.countryCode, input.now);
  reasons.push(`net.b.time_zone:${tz}`);
  const language = checkLanguage(input.clientLanguage, input.countryCode);
  reasons.push(`net.b.language:${language}`);
  // Layer C.
  const spread = input.accountSpread;
  const spreadFlag =
    spread !== null && (spread.countries >= SPREAD_COUNTRIES || spread.networks >= SPREAD_NETWORKS);
  if (spread !== null) {
    reasons.push(`net.c.countries:${String(spread.countries)}`);
    reasons.push(`net.c.networks:${String(spread.networks)}`);
  }
  const weak =
    (keyword ? 20 : 0) +
    (tz === 'utc' ? 10 : 0) +
    (language === 'mismatch' ? 10 : 0) +
    (spreadFlag ? 30 : 0);

  if (input.allowlisted) {
    return {
      refuse: false,
      because: 'allowlisted',
      score: 0,
      reasons: ['net.allowlisted', ...reasons],
    };
  }
  const strong = strongA || tz === 'mismatch';
  if (input.policy === 'allow') {
    return {
      refuse: false,
      because: 'policy_off',
      score: strong ? 100 : weak,
      reasons: ['net.policy:allow', ...reasons],
    };
  }
  if (strongA) return { refuse: true, because: 'address', score: 100, reasons };
  if (tz === 'mismatch') return { refuse: true, because: 'browser_time_zone', score: 100, reasons };
  return { refuse: false, because: 'clear', score: Math.min(weak, 99), reasons };
}
