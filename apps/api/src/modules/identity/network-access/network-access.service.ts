import { IpRangeSet, ipKey, parseCidrValue, parseIpRange, rangesOverlap } from '@tmanage/domain';
import type { CidrValue, IpRange } from '@tmanage/domain';
import { ApiError } from '../../../common/http/errors.js';
import type { AuthenticationEventRecorder } from '../../../common/http/authentication-event-recorder.js';
import { platformAuditFor } from '../../platform-admin/platform-audit.service.js';
import type { PlatformAdminActor } from '../../platform-admin/platform-admin.guard.js';
import type { PlatformAuditRequestContext } from '../../platform-admin/platform-audit.service.js';
import type { IpLookupValues } from '../geo/ip-lookups.repository.js';
import {
  NETWORK_GUARD_ACTION,
  SOURCE_BLOCKED_REASON,
  SPREAD_WINDOW_MS,
  VPN_REFUSED_REASON,
  decideNetworkAccess,
} from './network-access-policy.js';
import type { NetworkAccessDecision, NetworkPolicyMode } from './network-access-policy.js';
import type {
  ActiveList,
  AllowlistEntry,
  BlockEntry,
  BlockListRow,
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

/**
 * SEC-TRACKER: the words for an address a platform admin blocked. Not the VPN sentence: turning a
 * VPN off would not help, and the person may be on a shared line by mistake. Arabic pending the
 * native reviewer's sign-off (standing rule).
 */
export const SOURCE_BLOCKED_MESSAGES = {
  en: 'Sign-in from this address is not allowed. Contact support if this is a mistake.',
  ar: 'تسجيل الدخول من هذا العنوان غير مسموح. تواصل مع الدعم إذا كان هذا خطأ.',
} as const;

export function refusalMessage(
  language: string | null,
  messages: { readonly en: string; readonly ar: string } = VPN_REFUSED_MESSAGES,
): string {
  const lang = (language ?? '').trim().toLowerCase();
  if (lang.startsWith('ar')) return messages.ar;
  if (lang.startsWith('en')) return messages.en;
  return `${messages.en} ${messages.ar}`;
}

/**
 * SEC-TRACKER (Fable ruling, gap 1): a block is at most a /24 (IPv4) or a /48 (IPv6). Narrower
 * than the allowlist's /8 and /24, because a wrong block locks customers out.
 */
export const BLOCK_MIN_PREFIX = { 4: 24, 6: 48 } as const;

/** A block value: an address or a CIDR no wider than {@link BLOCK_MIN_PREFIX}, else null. */
export function parseBlockValue(raw: string): CidrValue | null {
  const parsed = parseCidrValue(raw);
  if (parsed === null || parsed.bits < BLOCK_MIN_PREFIX[parsed.family]) return null;
  return parsed;
}

/** `GET …/network-access` `lists[]` (gap 3). Never the raw `last_error`. */
export interface BlockListStatus {
  readonly key: string;
  readonly rangeCount: number;
  readonly fetchedAt: Date | null;
  readonly lastAttemptAt: Date | null;
  /** `off`: no version in force and no failure (never fetched, or IP2Proxy without a token). */
  readonly status: 'ok' | 'off' | 'failed';
}

export function blockListStatus(row: BlockListRow): BlockListStatus {
  return {
    key: row.listKey,
    rangeCount: row.activeVersion === null ? 0 : row.rangeCount,
    fetchedAt: row.fetchedAt,
    lastAttemptAt: row.lastAttemptAt,
    status: row.failed ? 'failed' : row.activeVersion === null ? 'off' : 'ok',
  };
}

/** What the attack tracker shows on a source row (gap 4): from the cached sets, no query. */
export interface SourceStanding {
  readonly blocked: boolean;
  /** The block entry that holds the address, for "Unblock"; null when not blocked. */
  readonly blockId: string | null;
  readonly allowlisted: boolean;
}

const conflict = (message: string): ApiError =>
  new ApiError(409, 'conflict', message, [{ field: 'value', message }]);

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

/** The platform's own block list (0406), parsed once per settings read. */
export class NetworkBlocklist {
  private readonly ranges: IpRangeSet;
  private readonly entries: readonly { readonly id: string; readonly range: IpRange }[];

  constructor(entries: readonly BlockEntry[]) {
    this.entries = entries.flatMap((entry) => {
      const range = parseIpRange(entry.value);
      return range === null ? [] : [{ id: entry.id, range }];
    });
    this.ranges = new IpRangeSet(this.entries.map((e) => e.range));
  }

  has(ip: string): boolean {
    return this.ranges.has(ip);
  }

  /** The id of the entry that holds `ip`, or null. */
  entryOf(ip: string): string | null {
    const key = ipKey(ip);
    if (key === null) return null;
    return this.entries.find((e) => e.range.start <= key && key <= e.range.end)?.id ?? null;
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
  readonly blocklist: NetworkBlocklist;
  readonly lists: readonly ActiveList[];
}

export interface NetworkAccessView {
  readonly policy: NetworkPolicyMode;
  readonly entries: readonly AllowlistEntry[];
  /** SEC-TRACKER gap 1: the platform's own block list. */
  readonly blocked: readonly BlockEntry[];
  /** SEC-TRACKER gap 3: each free list's size and last sweep. */
  readonly lists: readonly BlockListStatus[];
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
    const blocked = decision.because === 'blocked';
    try {
      this.events?.recordGuardRefusal({
        action: NETWORK_GUARD_ACTION,
        reason: blocked ? SOURCE_BLOCKED_REASON : VPN_REFUSED_REASON,
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
      refusalMessage(
        request.clientLanguage,
        blocked ? SOURCE_BLOCKED_MESSAGES : VPN_REFUSED_MESSAGES,
      ),
      undefined,
      blocked ? 'source_blocked' : 'anonymous_network_refused',
    );
  }

  /** The decision, or null when the inputs could not be gathered (fail-open). */
  async evaluate(request: NetworkAccessRequest): Promise<NetworkAccessDecision | null> {
    const ip = (request.ip ?? '').trim();
    const key = ip === '' ? null : ipKey(ip);
    if (key === null) return null;
    try {
      const settings = await this.settings();
      // Layer 0 first: a blocked source is refused before the address is classified, whatever the
      // policy switch says (decideNetworkAccess returns at once on `blocked`).
      if (settings.blocklist.has(ip)) {
        return decideNetworkAccess({
          policy: settings.policy,
          blocked: true,
          allowlisted: false,
          listHits: [],
          isTor: false,
          asn: null,
          networkOwner: null,
          countryCode: null,
          clientTimeZone: null,
          clientLanguage: null,
          accountSpread: null,
          now: this.now(),
        });
      }
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
        blocked: false,
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
    const [policy, entries, blocks, lists] = await Promise.all([
      this.store.policy(),
      this.store.allowlist(),
      this.store.blocklist(),
      this.store.activeLists(),
    ]);
    this.cache = {
      at,
      policy: policy === 'allow' ? 'allow' : 'refuse',
      allowlist: new NetworkAllowlist([...entries, ...this.envEntries]),
      blocklist: new NetworkBlocklist(blocks),
      lists,
    };
    return this.cache;
  }

  // ---- read side for the attack tracker (SEC-TRACKER gap 4) ----

  /** Blocked / allowlisted per source, from the cached sets (no query beyond the cache). */
  async standing(
    sources: readonly { readonly ip: string; readonly asn: number | null }[],
  ): Promise<ReadonlyMap<string, SourceStanding>> {
    const settings = await this.settings();
    return new Map(
      sources.map((source) => {
        const blockId = settings.blocklist.entryOf(source.ip);
        return [
          source.ip,
          {
            blocked: blockId !== null,
            blockId,
            allowlisted: settings.allowlist.has(source.ip, source.asn),
          },
        ];
      }),
    );
  }

  /** The free lists whose active version holds `ip` now (one indexed lookup per list). */
  async listsHolding(ip: string): Promise<readonly string[]> {
    const key = ipKey(ip);
    if (key === null) return [];
    const settings = await this.settings();
    return this.store.listHits(settings.lists, key);
  }

  // ---- platform admin ----

  async view(): Promise<NetworkAccessView> {
    const [policy, entries, blocked, lists] = await Promise.all([
      this.store.policy(),
      this.store.allowlist(),
      this.store.blocklist(),
      this.store.listStatus(),
    ]);
    return {
      policy: policy === 'allow' ? 'allow' : 'refuse',
      entries,
      blocked,
      lists: lists.map(blockListStatus),
    };
  }

  /**
   * SEC-TRACKER gap 1 — block a source. Refused with 409 when the range holds the admin's own
   * address (no self-lockout), overlaps an allowlist entry (database or env, or sits in an
   * allowlisted network), or overlaps a block already there. The checks read the tables, not the
   * cache. In force within {@link SETTINGS_CACHE_MS} on every process.
   *
   * DA-1: two admins adding overlapping entries at once is a write skew the checks cannot see
   * (each reads before the other commits). Both outcomes are safe: two overlapping blocks are
   * redundant, and a block beside an overlapping allowlist entry refuses (layer 0 runs first). An
   * identical value is stopped by the unique key and answered 409.
   */
  async addBlock(
    actor: PlatformAdminActor,
    raw: { readonly value?: unknown; readonly note?: unknown },
    context: PlatformAuditRequestContext,
  ): Promise<BlockEntry> {
    const parsed = typeof raw.value === 'string' ? parseBlockValue(raw.value) : null;
    if (parsed === null) {
      throw new ApiError(400, 'validation_failed', 'Check the address.', [
        { field: 'value', message: 'An IP address or a CIDR of at most /24 (IPv4) or /48 (IPv6).' },
      ]);
    }
    const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 190) : '';
    const own = context.ip === null ? null : ipKey(context.ip);
    if (own !== null && parsed.range.start <= own && own <= parsed.range.end) {
      throw conflict('This range holds your own address. Blocking it would lock you out.');
    }
    const [entries, blocks] = await Promise.all([this.store.allowlist(), this.store.blocklist()]);
    const asn = this.classifier?.classify(parsed.address)?.asn ?? null;
    for (const entry of [...entries, ...this.envEntries]) {
      const range = entry.kind === 'cidr' ? parseIpRange(entry.value) : null;
      const hit =
        entry.kind === 'asn'
          ? asn !== null && Number(entry.value) === asn
          : range !== null && rangesOverlap(range, parsed.range);
      if (hit) {
        const name = entry.kind === 'asn' ? `AS${entry.value}` : entry.value;
        throw conflict(
          `This overlaps the allowlist entry ${name}. Remove it from the allowlist first.`,
        );
      }
    }
    for (const block of blocks) {
      const range = parseIpRange(block.value);
      if (range !== null && rangesOverlap(range, parsed.range)) {
        throw conflict(`This overlaps the blocked entry ${block.value}.`);
      }
    }
    const entry = await this.store.addBlock(
      { value: parsed.value, note: note === '' ? null : note, createdAt: this.now() },
      (id) =>
        platformAuditFor(actor, context, {
          action: 'platform.network_block_added',
          targetType: 'platform',
          targetId: id,
          targetLabel: `cidr:${parsed.value}`,
          reason: null,
        }),
    );
    if (entry === null) throw conflict(`This overlaps the blocked entry ${parsed.value}.`);
    this.cache = null;
    return entry;
  }

  async removeBlock(
    actor: PlatformAdminActor,
    id: string,
    context: PlatformAuditRequestContext,
  ): Promise<void> {
    if (!/^[0-9a-f-]{36}$/u.test(id)) throw new ApiError(404, 'not_found', 'Not found.');
    const removed = await this.store.removeBlock(
      id,
      platformAuditFor(actor, context, {
        action: 'platform.network_block_removed',
        targetType: 'platform',
        targetId: id,
        targetLabel: null,
        reason: null,
      }),
    );
    if (removed === null) throw new ApiError(404, 'not_found', 'Not found.');
    this.cache = null;
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
    // SEC-TRACKER: never allow what is blocked (the dialog says which block to remove first).
    const overlapping = await this.blockOverlapping(parsed);
    if (overlapping !== null) {
      throw conflict(`This overlaps the blocked entry ${overlapping}. Unblock it first.`);
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

  /** The value of the first block entry the allowlist value would overlap, or null. */
  private async blockOverlapping(parsed: {
    readonly kind: 'cidr' | 'asn';
    readonly value: string;
  }): Promise<string | null> {
    const range = parsed.kind === 'cidr' ? parseIpRange(parsed.value) : null;
    for (const block of await this.store.blocklist()) {
      const blockRange = parseIpRange(block.value);
      if (blockRange === null) continue;
      if (range !== null && rangesOverlap(range, blockRange)) return block.value;
      if (parsed.kind === 'asn') {
        const address = parseCidrValue(block.value)?.address ?? null;
        const asn = address === null ? null : (this.classifier?.classify(address)?.asn ?? null);
        if (asn !== null && asn === Number(parsed.value)) return block.value;
      }
    }
    return null;
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
