import { Logger } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { createFixedWindowLimiter } from '../../common/http/rate-limiter.js';
import type { RequestAdmission } from '../../common/http/rate-limiter.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { resolveEgress, systemEgressResolver } from '../automations/egress-resolve.js';
import type { EgressResolver } from '../automations/egress-resolve.js';
import {
  UNFURL_MAX_BYTES,
  UNFURL_TIMEOUT_MS,
  fallbackTitle,
  figmaOembedUrl,
  normaliseUnfurlUrl,
  oembedToCard,
  parseHtmlMeta,
  unfurlOpenUrl,
} from './unfurl-meta.js';
import type { UnfurlCard, UnfurlProvider } from './unfurl-meta.js';

/**
 * R20-a (54-09 Phase 0) — the generic unfurl proxy: a preview card for a Figma, GitHub, Google
 * Docs or OneDrive link, fetched by the server so the browser never talks to the target.
 *
 * ## It must not be an SSRF oracle (54-09 security "I")
 *
 * - Only the exact hosts in `UNFURL_HOSTS`, https, default port, no userinfo — refused before any
 *   DNS lookup or fetch.
 * - `resolveEgress` resolves the host now and refuses any private / loopback / metadata answer or
 *   TManage's own host. (The fetch itself resolves again — global `fetch` cannot be pinned to the
 *   vetted address; the residual rebinding window is accepted because only five big public hosts
 *   can ever be named.)
 * - Redirects are never followed (`redirect: 'manual'`, a 3xx is "unavailable"), 5 s timeout,
 *   512 KiB read cap (a longer body is truncated, not refused), only `text/html` or
 *   `application/json` is read, and no cookie, token or credential is ever sent.
 * - Every failure is one token to the caller. The upstream status and body reach a debug log line
 *   only, never the response.
 *
 * ## Throttle and cache
 *
 * 60 calls per organization per hour (54-09 "D"), in process like every other limiter here (one
 * API process; a restart forgets). The cache is in-process too and shared across organizations on
 * purpose: the proxy fetches public pages with no credentials, so a cached card holds no tenant
 * data. A card lives 1 h, an "unavailable" 5 min; at 1 000 entries the oldest goes. Cache hits
 * still count against the org's 60 (the throttle runs first) — it bounds the caller, not the
 * upstream.
 */

export const UNFURL_RATE_PER_HOUR = 60;
export const UNFURL_CARD_TTL_MS = 60 * 60 * 1000;
export const UNFURL_UNAVAILABLE_TTL_MS = 5 * 60 * 1000;
export const UNFURL_CACHE_MAX = 1_000;

/** One upstream answer as the service sees it. `body` is read through the 512 KiB cap. */
export interface UnfurlFetchResult {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: AsyncIterable<Uint8Array> | null;
}

/** GET one URL with no credentials and no redirect-following. Throws on timeout/network error. */
export type UnfurlTransport = (url: string) => Promise<UnfurlFetchResult>;

async function* readerChunks(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    // An early stop (the read cap) cancels the rest of the download.
    await reader.cancel().catch(() => undefined);
  }
}

/** The production transport: global `fetch`, manual redirects, 5 s, credentials omitted. */
export const fetchUnfurlTransport: UnfurlTransport = async (url) => {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    credentials: 'omit',
    signal: AbortSignal.timeout(UNFURL_TIMEOUT_MS),
    headers: { Accept: 'text/html, application/json', 'User-Agent': 'TManageUnfurl/1.0' },
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: response.body ? readerChunks(response.body) : null,
  };
};

/** Read at most `cap` bytes; the rest is dropped (and, for a stream, cancelled). */
export async function readCapped(
  body: AsyncIterable<Uint8Array> | null,
  cap: number = UNFURL_MAX_BYTES,
): Promise<string> {
  if (body === null) return '';
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    const room = cap - total;
    if (chunk.byteLength >= room) {
      parts.push(chunk.subarray(0, room));
      total += room;
      break;
    }
    parts.push(chunk);
    total += chunk.byteLength;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder('utf-8').decode(joined);
}

export type UnfurlHint = 'ask_designer_to_share';

type CacheValue =
  | { readonly kind: 'card'; readonly card: UnfurlCard }
  | { readonly kind: 'unavailable'; readonly hint: UnfurlHint | null };

interface CacheEntry {
  readonly value: CacheValue;
  readonly expiresAt: number;
}

export interface UnfurlServiceOptions {
  readonly transport?: UnfurlTransport;
  readonly resolve?: EgressResolver;
  readonly ownHosts?: readonly string[];
  readonly now?: () => number;
}

function tokenError(status: number, token: string, hint: UnfurlHint | null = null): ApiError {
  const details = [{ field: 'url', message: token }];
  if (hint) details.push({ field: 'hint', message: hint });
  switch (status) {
    case 400:
      return new ApiError(400, 'validation_failed', 'The link is not a valid URL', details);
    case 422:
      return new ApiError(422, 'validation_failed', 'This link cannot be previewed', details);
    case 429:
      return new ApiError(429, 'rate_limited', MESSAGES.rateLimited, details);
    default:
      return new ApiError(404, 'not_found', MESSAGES.notFound, details);
  }
}

function isReadableType(contentType: string | null, want: 'html' | 'json'): boolean {
  const type = (contentType ?? '').trim().toLowerCase();
  return want === 'html' ? type.startsWith('text/html') : type.startsWith('application/json');
}

export class UnfurlService {
  private readonly logger = new Logger('Unfurl');
  private readonly transport: UnfurlTransport;
  private readonly resolve: EgressResolver;
  private readonly ownHosts: readonly string[];
  private readonly now: () => number;
  private readonly admit: RequestAdmission;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: UnfurlServiceOptions = {}) {
    this.transport = options.transport ?? fetchUnfurlTransport;
    this.resolve = options.resolve ?? systemEgressResolver;
    this.ownHosts = options.ownHosts ?? [];
    this.now = options.now ?? Date.now;
    this.admit = createFixedWindowLimiter({
      windowMs: 60 * 60 * 1000,
      max: UNFURL_RATE_PER_HOUR,
      now: this.now,
    });
  }

  async unfurl(context: TenantContext, principal: Principal, raw: unknown): Promise<UnfurlCard> {
    if (!this.mayRead(principal, context)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
    }
    const normalised = normaliseUnfurlUrl(raw);
    if ('reason' in normalised) {
      throw normalised.reason === 'invalid_url'
        ? tokenError(400, 'invalid_url')
        : tokenError(422, 'unfurl_host_not_allowed');
    }
    if (!this.admit(`org:${context.organizationId}`)) {
      throw tokenError(429, 'unfurl_rate_limited');
    }
    const value = await this.cached(normalised.url, normalised.provider);
    if (value.kind === 'card') return value.card;
    throw tokenError(404, 'unfurl_unavailable', value.hint);
  }

  private async cached(url: string, provider: UnfurlProvider): Promise<CacheValue> {
    const at = this.now();
    const hit = this.cache.get(url);
    if (hit && hit.expiresAt > at) return hit.value;
    if (hit) this.cache.delete(url);
    const value = await this.fetchCard(url, provider);
    this.remember(url, value, at);
    return value;
  }

  private remember(url: string, value: CacheValue, at: number): void {
    const ttl = value.kind === 'card' ? UNFURL_CARD_TTL_MS : UNFURL_UNAVAILABLE_TTL_MS;
    this.cache.delete(url);
    while (this.cache.size >= UNFURL_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(url, { value, expiresAt: at + ttl });
  }

  private async fetchCard(url: string, provider: UnfurlProvider): Promise<CacheValue> {
    const target = provider === 'figma' ? figmaOembedUrl(url) : url;
    const verdict = await resolveEgress(target, { resolve: this.resolve, ownHosts: this.ownHosts });
    if (!verdict.ok) {
      this.logger.debug(`unfurl refused egress (${verdict.reason})`);
      return { kind: 'unavailable', hint: null };
    }
    let result: UnfurlFetchResult;
    try {
      result = await this.transport(target);
    } catch (error) {
      this.logger.debug(`unfurl fetch failed: ${error instanceof Error ? error.name : 'error'}`);
      return { kind: 'unavailable', hint: null };
    }
    if (result.status < 200 || result.status >= 300) {
      this.logger.debug(`unfurl upstream status ${result.status}`);
      // A private Figma file answers 404 on oEmbed: tell the member who can fix it.
      const hint = provider === 'figma' && result.status === 404 ? 'ask_designer_to_share' : null;
      return { kind: 'unavailable', hint };
    }
    const want = provider === 'figma' ? 'json' : 'html';
    if (!isReadableType(result.contentType, want)) {
      this.logger.debug('unfurl upstream content-type refused');
      return { kind: 'unavailable', hint: null };
    }
    let text: string;
    try {
      text = await readCapped(result.body);
    } catch {
      return { kind: 'unavailable', hint: null };
    }
    const openUrl = unfurlOpenUrl(url, provider);
    if (provider === 'figma') {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return { kind: 'unavailable', hint: null };
      }
      const fields = oembedToCard(json);
      if (!fields) return { kind: 'unavailable', hint: null };
      return {
        kind: 'card',
        card: {
          provider,
          url,
          title: fields.title ?? fallbackTitle(url),
          description: null,
          thumbnailUrl: fields.thumbnailUrl,
          openUrl,
        },
      };
    }
    const meta = parseHtmlMeta(text);
    return {
      kind: 'card',
      card: {
        provider,
        url,
        title: meta.title ?? fallbackTitle(url),
        description: meta.description,
        thumbnailUrl: meta.imageUrl,
        openUrl,
      },
    };
  }

  /** Org-scoped deny-by-default decision the route guard cannot make: a client principal is 403. */
  private mayRead(principal: Principal, context: TenantContext): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }
}
