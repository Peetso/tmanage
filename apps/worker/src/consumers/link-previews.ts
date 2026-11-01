import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import {
  findMessageBody,
  finishLinkPreview,
  stageLinkPreview,
} from '../common/database/link-preview-store.js';
import type { WorkerDatabase } from '../common/database/worker-database.js';
import type { OutboxHandler, OutboxHandlers } from '../outbox/dispatcher.js';
import type { RealtimeHub } from '../realtime/hub.js';

/**
 * R7 slice 5 — link previews. `message.created.v1` → the first http(s) link in the body is
 * unfurled here, and only here: never in the browser (it would leak every reader's address to the
 * linked site) and never in the API (a slow site would hold a request open).
 *
 * The handler stages a `pending` row inside the event's savepoint; the fetch runs as an
 * after-commit effect so a slow site never holds the relay's batch transaction. The effect writes
 * `ready` or `failed` and tells the conversation's sockets (`link_preview.ready`, ids only). An
 * effect is at-most-once (dispatcher.ts): a crash mid-fetch leaves the row `pending`, which the
 * card shows as a plain link.
 *
 * ## The SSRF guard
 *
 * The worker sits inside the host's network, so a link is a request on the server's behalf. Every
 * hop (the first URL and each of at most three redirects) is checked again: http(s) only, port 80
 * or 443, no credentials in the URL, and every address the name resolves to must be public. The
 * connection is then pinned to the vetted address (`lookup` below), so a second DNS answer cannot
 * swap in a private one between the check and the connect. 5 s for the whole unfurl, 2 MB read at
 * most, `text/html` only.
 */

export const LINK_PREVIEW_USER_AGENT = 'TManageLinkPreview/1.0';
export const LINK_PREVIEW_TIMEOUT_MS = 5_000;
export const LINK_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const LINK_PREVIEW_MAX_REDIRECTS = 3;
export const LINK_PREVIEW_READY_EVENT = 'link_preview.ready';

const REFUSED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) {
  REFUSED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 96], // unspecified, loopback and IPv4-compatible
  ['64:ff9b::', 96], // NAT64 can reach any IPv4 address, private ones included
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  REFUSED.addSubnet(network, prefix, 'ipv6');
}

/** The IPv4 address inside an IPv4-mapped IPv6 address (`::ffff:a.b.c.d` / `::ffff:7f00:1`). */
function mappedIpv4(address: string): string | null {
  const match = /^(?:0{0,4}:){0,4}:?(?:0{0,4}:)?ffff:(.+)$/iu.exec(address);
  if (match === null || match[1] === undefined) return null;
  const tail = match[1];
  if (isIP(tail) === 4) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/iu.exec(tail);
  if (hex === null || hex[1] === undefined || hex[2] === undefined) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

/** Whether an IP address is one a preview fetch must never reach. Not an IP at all: refused. */
export function isRefusedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/gu, '').replace(/%.*$/u, '');
  const family = isIP(bare);
  if (family === 4) return REFUSED.check(bare, 'ipv4');
  if (family !== 6) return true;
  const inner = mappedIpv4(bare);
  if (inner !== null) return REFUSED.check(inner, 'ipv4');
  return REFUSED.check(bare, 'ipv6');
}

/** A hop's URL, parsed, if its scheme, port and userinfo are allowed; otherwise `null`. */
export function allowedUrl(raw: string, base?: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.port !== '' && url.port !== '80' && url.port !== '443') return null;
  if (url.username !== '' || url.password !== '') return null;
  return url;
}

export type Resolver = (
  hostname: string,
) => Promise<readonly { address: string; family: number }[]>;

const systemResolver: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** The one address to connect to, or `null` when the host has any refused address (or none). */
export async function vetHost(hostname: string, resolve: Resolver): Promise<string | null> {
  const bare = hostname.replace(/^\[|\]$/gu, '');
  if (isIP(bare) !== 0) return isRefusedAddress(bare) ? null : bare;
  let answers: readonly { address: string; family: number }[];
  try {
    answers = await resolve(bare);
  } catch {
    return null;
  }
  if (answers.length === 0 || answers.some((answer) => isRefusedAddress(answer.address))) {
    return null;
  }
  return answers[0]?.address ?? null;
}

/** What one HTTP hop answered: a redirect target, or an HTML body (at most the cap). */
export type HopResult =
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'html'; readonly body: string }
  | { readonly kind: 'refused' };

export type HopFetcher = (url: URL, address: string, signal: AbortSignal) => Promise<HopResult>;

/** One GET over node:http(s), connected to `address` only, reading at most the byte cap. */
const nodeHop: HopFetcher = (url, address, signal) =>
  new Promise<HopResult>((resolvePromise, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const family = isIP(address);
    const req = send(
      url,
      {
        method: 'GET',
        signal,
        headers: { 'User-Agent': LINK_PREVIEW_USER_AGENT, Accept: 'text/html' },
        // Pinned: the socket goes to the address the guard vetted, whatever DNS says now.
        lookup: (_host, options, callback) => {
          if ((options as { all?: boolean }).all === true) {
            (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
              { address, family },
            ]);
          } else {
            callback(null, address, family);
          }
        },
      },
      (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && typeof location === 'string') {
          response.destroy();
          resolvePromise({ kind: 'redirect', location });
          return;
        }
        const type = String(response.headers['content-type'] ?? '').toLowerCase();
        if (status < 200 || status >= 300 || !type.startsWith('text/html')) {
          response.destroy();
          resolvePromise({ kind: 'refused' });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const finish = () =>
          resolvePromise({ kind: 'html', body: Buffer.concat(chunks).toString('utf8') });
        response.on('data', (chunk: Buffer) => {
          const room = LINK_PREVIEW_MAX_BYTES - size;
          chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
          size += Math.min(chunk.length, room);
          if (size >= LINK_PREVIEW_MAX_BYTES) {
            response.destroy();
            finish();
          }
        });
        response.on('end', finish);
        response.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });

export interface UnfurledPage {
  readonly title: string | null;
  readonly description: string | null;
  readonly imageUrl: string | null;
  readonly siteName: string | null;
}

export interface UnfurlDependencies {
  readonly resolve?: Resolver;
  readonly hop?: HopFetcher;
  readonly timeoutMs?: number;
}

/** The page behind `raw`, or `null` when any hop is refused, fails or times out. */
export async function unfurl(
  raw: string,
  deps: UnfurlDependencies = {},
): Promise<UnfurledPage | null> {
  const resolve = deps.resolve ?? systemResolver;
  const hop = deps.hop ?? nodeHop;
  const signal = AbortSignal.timeout(deps.timeoutMs ?? LINK_PREVIEW_TIMEOUT_MS);
  let url = allowedUrl(raw);
  try {
    for (let redirects = 0; url !== null; redirects += 1) {
      const address = await vetHost(url.hostname, resolve);
      if (address === null || signal.aborted) return null;
      const result = await hop(url, address, signal);
      if (result.kind === 'html') return parseOpenGraph(result.body, url.href);
      if (result.kind === 'refused' || redirects >= LINK_PREVIEW_MAX_REDIRECTS) return null;
      url = allowedUrl(result.location, url.href);
    }
  } catch {
    return null;
  }
  return null;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code =
        name[1] === 'x' || name[1] === 'X'
          ? Number.parseInt(name.slice(2), 16)
          : Number(name.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function clean(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  const text = decodeEntities(value).replace(/\s+/gu, ' ').trim();
  return text === '' ? null : [...text].slice(0, max).join('');
}

function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(/([a-z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/giu)) {
    const name = match[1]?.toLowerCase();
    if (name !== undefined) attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

/** `og:title`, `og:description`, `og:image`, `og:site_name` and `<title>`, by regex (no deps). */
export function parseOpenGraph(html: string, pageUrl: string): UnfurledPage {
  const meta = new Map<string, string>();
  for (const match of html.matchAll(/<meta\b[^>]*>/giu)) {
    const attributes = attributesOf(match[0]);
    const key = (attributes.get('property') ?? attributes.get('name'))?.toLowerCase();
    const content = attributes.get('content');
    if (key !== undefined && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1];
  const image = meta.get('og:image');
  const imageUrl = image === undefined ? null : allowedUrl(decodeEntities(image).trim(), pageUrl);
  return {
    title: clean(meta.get('og:title') ?? titleTag, 300),
    description: clean(meta.get('og:description') ?? meta.get('description'), 500),
    imageUrl: imageUrl !== null && imageUrl.href.length <= 2048 ? imageUrl.href : null,
    siteName: clean(meta.get('og:site_name'), 120),
  };
}

/** The first http(s) link in a message body, trailing punctuation trimmed; `null` when none. */
export function firstLinkOf(body: string): string | null {
  const match = /\bhttps?:\/\/[^\s<>"'`]+/iu.exec(body);
  if (match === null) return null;
  const link = match[0].replace(/[.,;:!?)\]}]+$/u, '');
  return link.length <= 2048 && allowedUrl(link) !== null ? link : null;
}

export interface LinkPreviewConsumerDependencies {
  /** The effect's own transaction — none is open when an after-commit effect runs. */
  readonly database: WorkerDatabase;
  /** Present when a socket server runs; the card otherwise refetches on its backoff. */
  readonly hub?: RealtimeHub | undefined;
  readonly unfurl?: (url: string) => Promise<UnfurledPage | null>;
}

function factsOf(event: { id: string; payload: unknown }): {
  conversationId: string;
  messageId: string;
} {
  const record = (event.payload ?? {}) as Record<string, unknown>;
  const conversationId = record['conversationId'];
  const messageId = record['messageId'];
  if (typeof conversationId !== 'string' || typeof messageId !== 'string') {
    throw new Error(`event ${event.id} has no readable conversationId/messageId`);
  }
  return { conversationId, messageId };
}

export function createLinkPreviewConsumer(deps: LinkPreviewConsumerDependencies): OutboxHandler {
  const fetchPage = deps.unfurl ?? ((url: string) => unfurl(url));
  return async (event, tx, effects) => {
    const { conversationId, messageId } = factsOf(event);
    const organizationId = event.organizationId;
    const url = firstLinkOf((await findMessageBody(tx, organizationId, messageId)) ?? '');
    if (url === null) return;
    const row = await stageLinkPreview(tx, organizationId, messageId, url);
    if (row === null || row.status !== 'pending') return;

    effects.afterCommit(async () => {
      const page = await fetchPage(row.url).catch(() => null);
      const status = page === null ? 'failed' : 'ready';
      await deps.database.transaction((write) =>
        finishLinkPreview(write, organizationId, messageId, {
          status,
          title: page?.title ?? null,
          description: page?.description ?? null,
          imageUrl: page?.imageUrl ?? null,
          siteName: page?.siteName ?? null,
        }),
      );
      deps.hub?.publish(organizationId, conversationId, {
        type: 'event',
        eventType: LINK_PREVIEW_READY_EVENT,
        conversationId,
        objectId: messageId,
        sequence: null,
        patch: { messageId, status },
      });
    });
  };
}

/**
 * The handlers with link previews composed onto `message.created.v1`, after whatever already
 * answers it (mentions, the socket frame), in the same savepoint. Composed by the processes that
 * own a database handle (`main.ts`, the single-app server) rather than in the registry, because the
 * after-commit write needs one.
 */
export function withLinkPreviews(
  handlers: OutboxHandlers,
  database: WorkerDatabase,
  hub?: RealtimeHub,
): OutboxHandlers {
  const previews = createLinkPreviewConsumer({ database, hub });
  const existing = handlers['message.created.v1'];
  return {
    ...handlers,
    'message.created.v1':
      existing === undefined
        ? previews
        : async (event, tx, effects) => {
            await existing(event, tx, effects);
            await previews(event, tx, effects);
          },
  };
}
