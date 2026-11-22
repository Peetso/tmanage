import { IpRangeSet, ipKey, parseIpRange } from '@tmanage/domain';
import type { IpRange } from '@tmanage/domain';
import { ApiError } from '../../../common/http/errors.js';
import type { AuthenticationEventRecorder } from '../../../common/http/authentication-event-recorder.js';
import { platformAuditFor } from '../../platform-admin/platform-audit.service.js';
import type { PlatformAdminActor } from '../../platform-admin/platform-admin.guard.js';
import type { PlatformAuditRequestContext } from '../../platform-admin/platform-audit.service.js';
import type { IpLookupValues } from '../geo/ip-lookups.repository.js';
import {
  NETWORK_GUARD_ACTION,
  SPREAD_WINDOW_MS,
  VPN_REFUSED_REASON,
  decideNetworkAccess,
} from './network-access-policy.js';
import type { NetworkAccessDecision, NetworkPolicyMode } from './network-access-policy.js';
import type {
  ActiveList,
  AllowlistEntry,
  NetworkAccessStore,
} from './network-access.repository.js';

/**
 * SEC-ALERTS item 7 — the sign-in door's service: gathers the inputs of
 * `decideNetworkAccess` (cached settings, the block-list lookup, the address's place and network,
 * the browser's time zone and language, the named account's spread), records a refusal, and
 * serves the platform allowlist routes.
 *
 * Caching: the policy switch, the allowlist and the active list versions are read at most once a
 * {@link SETTINGS_CACHE_MS} per process; a change made on another process is in force within
 * that time. The block-list lookup itself is per request (one indexed read per list).
 *
 * Fail-open: any error while gathering inputs lets the request through and is logged once a
 * minute at most. The door is a filter in front of the real controls (password, MFA, throttle),
 * not one of them, so a database hiccup must not lock everyone out.
 */

export const SETTINGS_CACHE_MS = 60_000;
export const NETWORK_ACCESS_SERVICE = Symbol.for('tmanage.NetworkAccessService');

/** Plain words, English and Arabic (Peter's wording, SEC-ALERTS item 7). */
export const VPN_REFUSED_MESSAGES = {
  en: 'Turn off your VPN or proxy and try again.',
  ar: 'أوقف تشغيل VPN أو الخادم الوكيل ثم حاول مرة أخرى.',
} as const;

export function refusalMessage(language: string | null): string {
  const lang = (language ?? '').trim().toLowerCase();
  if (lang.startsWith('ar')) return VPN_REFUSED_MESSAGES.ar;
  if (lang.startsWith('en')) return VPN_REFUSED_MESSAGES.en;
  return `${VPN_REFUSED_MESSAGES.en} ${VPN_REFUSED_MESSAGES.ar}`;
}

/** An allowlist entry's kind from its text: `AS13335` is an ASN, anything else an address/CIDR. */
export function parseAllowlistValue(
  raw: string,
): { readonly kind: 'cidr' | 'asn'; readonly value: string } | null {
  const text = raw.trim();
  const asn = /^AS(\d{1,10})$/iu.exec(text);
  if (asn !== null) {
    const n = Number(asn[1]);
    return n > 0 && n <= 4_294_967_295 ? { kind: 'asn', value: String(n) } : null;
  }
  if (text.length > 64 || parseIpRange(text) === null) return null;
  const [address = '', bits] = text.split('/');
  // Never a whole slice of the internet: at most a /8 (IPv4) or a /24 (IPv6).
  if (bits !== undefined && Number(bits) < (address.includes(':') ? 24 : 8)) return null;
  return { kind: 'cidr', value: text };
}

export class NetworkAllowlist {
  private readonly ranges: IpRangeSet;
  private readonly asns: ReadonlySet<number>;

  constructor(entries: readonly { readonly kind: 'cidr' | 'asn'; readonly value: string }[]) {
    const ranges: IpRange[] = [];
    const asns = new Set<number>();
    for (const entry of entries) {
      if (entry.kind === 'asn') asns.add(Number(entry.value));
      else {
        const range = parseIpRange(entry.value);
        if (range !== null) ranges.push(range);
      }
    }
    this.ranges = new IpRangeSet(ranges);
    this.asns = asns;
  }

  has(ip: string, asn: number | null): boolean {
    return this.ranges.has(ip) || (asn !== null && this.asns.has(asn));
  }
}

/** `NETWORK_ACCESS_ALLOWLIST`: a comma list of addresses, CIDRs and `AS<number>`. */
export function envAllowlist(
  raw: string | undefined,
): readonly { kind: 'cidr' | 'asn'; value: string }[] {
  return (raw ?? '')
    .split(',')
    .map((part) => parseAllowlistValue(part))
    .filter((entry): entry is { kind: 'cidr' | 'asn'; value: string } => entry !== null);
}

/** What the guard knows about the request. */
export interface NetworkAccessRequest {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly clientTimeZone: string | null;
  readonly clientLanguage: string | null;
  /** The account the request names (sign-in, reset, portal code), for layer C. */
  readonly email: string | null;
  readonly correlationId: string;
}

/** The part of `IpIntelligenceService` the door needs. */
export interface IpClassifier {
  classify(raw: string | null | undefined): IpLookupValues | null;
}

interface CachedSettings {
  readonly at: number;
  readonly policy: NetworkPolicyMode;
  readonly allowlist: NetworkAllowlist;
  readonly lists: readonly ActiveList[];
}

export interface NetworkAccessView {
  readonly policy: NetworkPolicyMode;
  readonly entries: readonly AllowlistEntry[];
}

export class NetworkAccessService {
  private cache: CachedSettings | null = null;
  private lastErrorLog = 0;

  constructor(
    private readonly store: NetworkAccessStore,
    private readonly classifier: IpClassifier | null,
    private readonly events: AuthenticationEventRecorder | null,
    private readonly envEntries: readonly { kind: 'cidr' | 'asn'; value: string }[] = [],
    private readonly now: () => Date = () => new Date(),
    private readonly log: (message: string) => void = console.warn,
  ) {}

  /** Refuse (throw 403) or return. Never throws for any other reason. */
  async enforce(request: NetworkAccessRequest): Promise<void> {
    const decision = await this.evaluate(request);
    if (decision === null || !decision.refuse) return;
    try {
      this.events?.recordGuardRefusal({
        action: NETWORK_GUARD_ACTION,
        reason: VPN_REFUSED_REASON,
        ip: request.ip,
        userAgent: request.userAgent,
        correlationId: request.correlationId,
        automationScore: decision.score,
        automationReasons: decision.reasons,
      });
    } catch {
      // Recording is best-effort; the refusal stands.
    }
    throw new ApiError(
      403,
      'forbidden',
      refusalMessage(request.clientLanguage),
      undefined,
      'anonymous_network_refused',
    );
  }

  /** The decision, or null when the inputs could not be gathered (fail-open). */
  async evaluate(request: NetworkAccessRequest): Promise<NetworkAccessDecision | null> {
    const ip = (request.ip ?? '').trim();
    const key = ip === '' ? null : ipKey(ip);
    if (key === null) return null;
    try {
      const settings = await this.settings();
      const found = this.classifier?.classify(ip) ?? null;
      if (found?.networkKind === 'local') return null;
      const asn = found?.asn ?? null;
      const allowlisted = settings.allowlist.has(ip, asn);
      const listHits = allowlisted ? [] : await this.store.listHits(settings.lists, key);
      const now = this.now();
      const spread =
        request.email !== null && request.email.includes('@') && request.email.length <= 254
          ? await this.store.accountSpread(
              request.email,
              new Date(now.getTime() - SPREAD_WINDOW_MS),
            )
          : null;
      return decideNetworkAccess({
        policy: settings.policy,
        allowlisted,
        listHits,
        isTor: found?.isTor ?? false,
        asn,
        networkOwner: found?.networkOwner ?? null,
        countryCode: found?.countryCode ?? null,
        clientTimeZone: request.clientTimeZone,
        clientLanguage: request.clientLanguage,
        accountSpread: spread,
        now,
      });
    } catch (error) {
      const at = Date.now();
      if (at - this.lastErrorLog > 60_000) {
        this.lastErrorLog = at;
        this.log(
          `[network-access] inputs unavailable, request allowed (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      return null;
    }
  }

  private async settings(): Promise<CachedSettings> {
    const at = Date.now();
    if (this.cache !== null && at - this.cache.at < SETTINGS_CACHE_MS) return this.cache;
    const [policy, entries, lists] = await Promise.all([
      this.store.policy(),
      this.store.allowlist(),
      this.store.activeLists(),
    ]);
    this.cache = {
      at,
      policy: policy === 'allow' ? 'allow' : 'refuse',
      allowlist: new NetworkAllowlist([...entries, ...this.envEntries]),
      lists,
    };
    return this.cache;
  }

  // ---- platform admin ----

  async view(): Promise<NetworkAccessView> {
    const [policy, entries] = await Promise.all([this.store.policy(), this.store.allowlist()]);
    return { policy: policy === 'allow' ? 'allow' : 'refuse', entries };
  }

  async addEntry(
    actor: PlatformAdminActor,
    raw: { readonly value?: unknown; readonly note?: unknown },
    context: PlatformAuditRequestContext,
  ): Promise<AllowlistEntry> {
    const parsed = typeof raw.value === 'string' ? parseAllowlistValue(raw.value) : null;
    const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 190) : '';
    if (parsed === null) {
      throw new ApiError(400, 'validation_failed', 'Check the address.', [
        { field: 'value', message: 'An IP address, a CIDR (at most /8) or AS<number>.' },
      ]);
    }
    const entry = await this.store.addAllowlistEntry(
      { ...parsed, note: note === '' ? null : note, createdAt: this.now() },
      (id) =>
        platformAuditFor(actor, context, {
          action: 'platform.network_allowlist_added',
          targetType: 'platform',
          targetId: id,
          targetLabel: `${parsed.kind}:${parsed.value}`,
          reason: null,
        }),
    );
    this.cache = null;
    return entry;
  }

  async removeEntry(
    actor: PlatformAdminActor,
    id: string,
    context: PlatformAuditRequestContext,
  ): Promise<void> {
    if (!/^[0-9a-f-]{36}$/u.test(id)) throw new ApiError(404, 'not_found', 'Not found.');
    const removed = await this.store.removeAllowlistEntry(
      id,
      platformAuditFor(actor, context, {
        action: 'platform.network_allowlist_removed',
        targetType: 'platform',
        targetId: id,
        targetLabel: null,
        reason: null,
      }),
    );
    if (!removed) throw new ApiError(404, 'not_found', 'Not found.');
    this.cache = null;
  }

  async setPolicy(
    actor: PlatformAdminActor,
    raw: { readonly mode?: unknown },
    context: PlatformAuditRequestContext,
  ): Promise<NetworkAccessView> {
    if (raw.mode !== 'refuse' && raw.mode !== 'allow') {
      throw new ApiError(400, 'validation_failed', 'Check the setting.', [
        { field: 'mode', message: 'refuse or allow.' },
      ]);
    }
    await this.store.setPolicy(
      raw.mode,
      this.now(),
      platformAuditFor(actor, context, {
        action: 'platform.network_access_policy_updated',
        targetType: 'platform',
        targetId: null,
        targetLabel: raw.mode,
        reason: null,
      }),
    );
    this.cache = null;
    return this.view();
  }
}
