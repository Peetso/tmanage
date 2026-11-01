import type { IpLookupRow, IpNetworkKind } from '../../../common/database/schema.js';
import { verdictOf, type AutomationVerdict } from './automation-signal.js';
import { summarizeUserAgent, type DeviceType } from './user-agent-summary.js';

/**
 * R12 (R1, SPEC §5). The read model the session screens show beside a session or a sign-in: where
 * the address is (approximately), whose network it is, which device, and whether the sign-in
 * looked scripted. Pure: the caller fetches the `ip_lookups` rows and the sign-in event first.
 */
export interface SessionLocationView {
  readonly countryCode: string | null;
  readonly country: string | null;
  readonly region: string | null;
  readonly city: string | null;
  readonly postalCode: string | null;
  /** Always `true`: IP geolocation is a city-level guess, never an address. */
  readonly approximate: true;
  /** `'DB-IP'` when the DB-IP Lite file answered (CC BY 4.0 asks for the credit). */
  readonly attribution: 'DB-IP' | null;
}

export interface SessionNetworkView {
  readonly asn: number | null;
  readonly owner: string | null;
  readonly kind: IpNetworkKind;
  readonly tor: boolean;
  readonly vpnOrProxy: 'likely' | 'unknown';
}

export interface SessionDeviceView {
  readonly browser: string | null;
  readonly os: string | null;
  readonly deviceType: DeviceType;
  readonly raw: string | null;
}

export interface SessionAutomationView {
  readonly verdict: AutomationVerdict;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface IntelCoreView {
  readonly location: SessionLocationView | null;
  readonly network: SessionNetworkView | null;
  readonly device: SessionDeviceView;
  readonly automation: SessionAutomationView | null;
}

export interface SessionIntelView extends IntelCoreView {
  readonly ipFirst: string | null;
  readonly ipLast: string | null;
  /** ISO-8601 UTC. When the session began. */
  readonly firstSeenAt: string;
  /** ISO-8601 UTC. The last refresh, or the start when never refreshed. */
  readonly lastSeenAt: string;
}

/** One `authentication_events` row with its intel (§5: the session view minus first/last). */
export interface SignInEventIntelView extends IntelCoreView {
  readonly ip: string | null;
  readonly occurredAt: string;
  readonly action: string;
  readonly outcome: string;
}

/** The two automation columns of a sign-in event (0280). */
export interface AutomationFacts {
  readonly score: number | null;
  readonly reasons: readonly string[] | null;
}

/** The `ip_lookups.source` values that mean "DB-IP Lite answered". */
const DBIP_SOURCES: ReadonlySet<string> = new Set(['dbip', 'mmdb']);

/** `(ipLookupRow | null, uaString, eventRow | null) → intel` (SPEC slice 2). */
export function intelOf(
  lookup: IpLookupRow | null,
  userAgent: string | null,
  event: AutomationFacts | null,
): IntelCoreView {
  return {
    location: locationOf(lookup),
    network: lookup
      ? {
          asn: lookup.asn,
          owner: lookup.networkOwner,
          kind: lookup.networkKind,
          tor: lookup.isTor,
          vpnOrProxy: lookup.vpnOrProxy,
        }
      : null,
    device: summarizeUserAgent(userAgent),
    automation: automationOf(event),
  };
}

function locationOf(lookup: IpLookupRow | null): SessionLocationView | null {
  if (!lookup || lookup.networkKind === 'local') return null;
  if (!lookup.countryCode && !lookup.country && !lookup.city) return null;
  return {
    countryCode: lookup.countryCode,
    country: lookup.country,
    region: lookup.region,
    city: lookup.city,
    postalCode: lookup.postalCode,
    approximate: true,
    attribution: lookup.source !== null && DBIP_SOURCES.has(lookup.source) ? 'DB-IP' : null,
  };
}

function automationOf(event: AutomationFacts | null): SessionAutomationView | null {
  if (!event || event.score === null) return null;
  return { verdict: verdictOf(event.score), score: event.score, reasons: event.reasons ?? [] };
}

/** What a session contributes; `lookups` keyed by ip, `automation` by sign-in event id. */
export function sessionIntel(
  session: {
    readonly ipFirst: string | null;
    readonly ipLast: string | null;
    readonly userAgent: string | null;
    readonly firstSeenAt: Date;
    readonly lastSeenAt: Date;
    readonly signInEventId: string | null;
  },
  inputs: IntelInputs,
): SessionIntelView {
  const lookup =
    (session.ipLast ? inputs.lookups.get(session.ipLast) : undefined) ??
    (session.ipFirst ? inputs.lookups.get(session.ipFirst) : undefined) ??
    null;
  const event = session.signInEventId ? inputs.automation.get(session.signInEventId) : undefined;
  return {
    ipFirst: session.ipFirst,
    ipLast: session.ipLast,
    ...intelOf(lookup, session.userAgent, event ?? null),
    firstSeenAt: session.firstSeenAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
  };
}

export function eventIntel(
  event: {
    readonly ip: string | null;
    readonly userAgent: string | null;
    readonly occurredAt: Date;
    readonly action: string;
    readonly outcome: string;
  } & AutomationFacts,
  lookups: ReadonlyMap<string, IpLookupRow>,
): SignInEventIntelView {
  return {
    ip: event.ip,
    ...intelOf(event.ip ? (lookups.get(event.ip) ?? null) : null, event.userAgent, event),
    occurredAt: event.occurredAt.toISOString(),
    action: event.action,
    outcome: event.outcome,
  };
}

/** Everything {@link sessionIntel} reads, fetched in one identity read. */
export interface IntelInputs {
  readonly lookups: ReadonlyMap<string, IpLookupRow>;
  readonly automation: ReadonlyMap<string, AutomationFacts>;
}

export const NO_INTEL_INPUTS: IntelInputs = { lookups: new Map(), automation: new Map() };
