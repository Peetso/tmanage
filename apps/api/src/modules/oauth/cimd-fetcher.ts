import { lookup as dnsLookupAll } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { clientAddressKey } from '../../common/http/rate-limiter.js';
import { isKnownCimdClient } from './known-clients.js';
import { sanitiseClientName } from './dcr-metadata.js';
import { validateRegistrationRedirectUris } from './redirect-uri.js';
import { isBlockedAddress } from './ssrf.js';

/**
 * The Client-ID Metadata Document fetcher (MCP connector S8, threat model row B5 "SSRF via CIMD
 * fetch"). A CIMD client identifies itself by an https URL; TManage fetches that URL once to read
 * the client's `client_name` and `redirect_uris`. This is the only outbound call any AI path
 * makes, so it is hardened:
 *
 *   - **https only**, no fragment, no userinfo, default port only.
 *   - **DNS resolved once and the IP pinned** for the connection (`ssrf.ts` classifies the
 *     resolved address; private, loopback, link-local, ULA, multicast and metadata ranges are
 *     refused). Pinning the resolved IP closes the DNS-rebinding window — the socket connects to
 *     the exact address that was vetted, not a second resolution.
 *   - **redirects are not followed** — a 3xx is a refusal (a redirect is the classic SSRF pivot).
 *   - **5 KB body cap, 8 KB header cap, 3 s idle timeout and a 5 s total deadline** covering DNS,
 *     connect, headers and body (audit NV07: an idle timeout alone let a peer that drips one byte
 *     every few seconds hold a fetch for hours).
 *   - the document's **`client_id` must equal the document URL**, so a URL cannot speak for
 *     another, and its `redirect_uris` go through the same validation as a DCR body.
 *
 * **An anonymous caller cannot turn this into an amplifier (audit NV07).** `/oauth/authorize` is
 * public, so every outcome is cached in-process for {@link CIMD_CACHE_MS} under the normalised
 * URL — refusals too — and concurrent requests for one URL share a single fetch. New fetches are
 * capped per host and in total, both in flight and per minute; over a cap the caller gets `429`
 * ({@link cimdBusyError}) and nothing leaves the process. The caller also keeps a good result for
 * 24 h as the `oauth_clients` row's age (`oauth.service.ts`).
 *
 * **One caller cannot spend everyone's budget (audit run 2, N06).** New fetches are also capped
 * per requesting source ({@link CIMD_MAX_PER_MINUTE_PER_SOURCE}, the address folded to its IPv6
 * /64 by `clientAddressKey`), so one address spraying fresh hostnames is refused long before the
 * shared per-minute cap fills. A known first-party client URL (`known-clients.ts`) is not counted
 * against, nor refused by, the two global caps — its own per-host caps still bound it — so a
 * flood of unknown hosts cannot lock the real AI connectors out of sign-in.
 */

const MAX_BODY_BYTES = 5 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;
const TIMEOUT_MS = 3_000;
/** Wall-clock budget for one fetch, DNS included. */
export const CIMD_DEADLINE_MS = 5_000;
/** How long one outcome (document or refusal) is reused for the same URL. */
export const CIMD_CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 1_000;
/** Outbound fetches allowed at once, in total and per host. */
export const CIMD_MAX_CONCURRENT = 4;
export const CIMD_MAX_CONCURRENT_PER_HOST = 1;
/** New outbound fetches allowed per minute, in total and per host. */
export const CIMD_MAX_PER_MINUTE = 30;
export const CIMD_MAX_PER_MINUTE_PER_HOST = 5;
/** New outbound fetches one requesting source (an IPv4 address or an IPv6 /64) may start per minute. */
export const CIMD_MAX_PER_MINUTE_PER_SOURCE = 5;
const RATE_WINDOW_MS = 60_000;

/** A validated CIMD client, ready to upsert as an `oauth_clients` row (kind `cimd`). */
export interface CimdClient {
  /** The metadata document URL, which is the client's `client_id`. */
  readonly clientId: string;
  readonly name: string;
  readonly redirectUris: string[];
  /** True when the host is a known first-party vendor (the consent "Verified" badge, S9). */
  readonly verified: boolean;
}

/** Any failure resolving a CIMD document — SSRF refusal, transport error, or bad metadata. */
export class CimdError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'CimdError';
  }
}

/** The refusal when a fetch cap is reached: `429`, nothing fetched. Deliberately not a `CimdError`. */
export function cimdBusyError(): ApiError {
  return new ApiError(429, 'rate_limited', MESSAGES.rateLimited, undefined, 'cimd_fetch_capped');
}

/**
 * Parse and harden a CIMD `client_id` URL. https only, no fragment, no credentials, and an
 * explicit non-default port is refused (the metadata lives on the standard https port). Exported
 * for the unit test (T-SSRF-01) that pins the URL rules without a network call.
 */
export function assertCimdUrl(clientIdUrl: string): URL {
  let url: URL;
  try {
    url = new URL(clientIdUrl);
  } catch {
    throw new CimdError('client_id is not a valid URL.');
  }
  if (url.protocol !== 'https:') throw new CimdError('CIMD client_id must be https.');
  if (url.hash !== '') throw new CimdError('CIMD client_id must not contain a fragment.');
  if (url.username !== '' || url.password !== '') {
    throw new CimdError('CIMD client_id must not contain credentials.');
  }
  if (url.port !== '' && url.port !== '443') {
    throw new CimdError('CIMD client_id must use the default https port.');
  }
  return url;
}

type Resolved = { address: string; family: number };

/** Test seams. Production uses the defaults: real DNS, the hardened GET, the wall clock. */
export interface CimdFetcherOptions {
  readonly resolve?: (hostname: string) => Promise<Resolved[]>;
  readonly get?: (url: URL, pinned: Resolved, signal: AbortSignal) => Promise<string>;
  readonly now?: () => number;
  readonly deadlineMs?: number;
}

export const CIMD_FETCHER_OPTIONS = Symbol.for('tmanage.CimdFetcherOptions');

type Outcome = { readonly client: CimdClient } | { readonly error: CimdError };

@Injectable()
export class CimdFetcher {
  private readonly cache = new Map<string, { readonly at: number; readonly outcome: Outcome }>();
  private readonly inFlight = new Map<string, Promise<Outcome>>();
  private readonly activeByHost = new Map<string, number>();
  private active = 0;
  private starts: {
    readonly at: number;
    readonly host: string;
    readonly source: string;
    readonly known: boolean;
  }[] = [];
  private readonly resolve: (hostname: string) => Promise<Resolved[]>;
  private readonly getBody: (url: URL, pinned: Resolved, signal: AbortSignal) => Promise<string>;
  private readonly now: () => number;
  private readonly deadlineMs: number;

  constructor(@Optional() @Inject(CIMD_FETCHER_OPTIONS) options: CimdFetcherOptions = {}) {
    this.resolve =
      options.resolve ?? ((hostname) => dnsLookupAll(hostname, { all: true, verbatim: true }));
    this.getBody = options.get ?? ((url, pinned, signal) => this.get(url, pinned, signal));
    this.now = options.now ?? Date.now;
    this.deadlineMs = options.deadlineMs ?? CIMD_DEADLINE_MS;
  }

  /**
   * Fetch and validate the CIMD document for `clientIdUrl`. Returns the client to persist, or
   * throws `CimdError` (or {@link cimdBusyError} when a cap is reached). No part of the
   * client-supplied URL or document is trusted until it has passed every check above.
   *
   * `requester` is the caller's client address (`request.ip`); it is folded with
   * `clientAddressKey` and charged against the per-source budget. A missing address shares the
   * one `unknown` budget, which is the conservative direction.
   */
  async fetchMetadata(clientIdUrl: string, requester?: string | null): Promise<CimdClient> {
    const url = assertCimdUrl(clientIdUrl);
    const key = url.toString();
    const now = this.now();
    const cached = this.cache.get(key);
    if (cached !== undefined && now - cached.at < CIMD_CACHE_MS) return unwrap(cached.outcome);

    let pending = this.inFlight.get(key);
    if (pending === undefined) {
      const known = isKnownCimdClient(key);
      // Throws 429 before anything leaves the process.
      this.admit(url.hostname, now, clientAddressKey(requester), known);
      pending = this.fetchOnce(url, clientIdUrl).finally(() => {
        this.release(url.hostname, known);
        this.inFlight.delete(key);
      });
      this.inFlight.set(key, pending);
    }
    return unwrap(await pending);
  }

  /**
   * Reserve one fetch slot for `host` on behalf of `source`, or throw `429`. The per-host and
   * per-source caps always apply; the two global caps count and refuse only unknown hosts, so a
   * known first-party client is never starved by a flood of unknown ones (N06).
   */
  private admit(host: string, now: number, source: string, known: boolean): void {
    this.starts = this.starts.filter((s) => now - s.at < RATE_WINDOW_MS);
    const hostStarts = this.starts.filter((s) => s.host === host).length;
    const sourceStarts = this.starts.filter((s) => s.source === source).length;
    const globalStarts = this.starts.filter((s) => !s.known).length;
    const hostActive = this.activeByHost.get(host) ?? 0;
    if (
      hostActive >= CIMD_MAX_CONCURRENT_PER_HOST ||
      hostStarts >= CIMD_MAX_PER_MINUTE_PER_HOST ||
      sourceStarts >= CIMD_MAX_PER_MINUTE_PER_SOURCE ||
      (!known && (this.active >= CIMD_MAX_CONCURRENT || globalStarts >= CIMD_MAX_PER_MINUTE))
    ) {
      throw cimdBusyError();
    }
    if (!known) this.active += 1;
    this.activeByHost.set(host, hostActive + 1);
    this.starts.push({ at: now, host, source, known });
  }

  private release(host: string, known: boolean): void {
    if (!known) this.active = Math.max(0, this.active - 1);
    const left = (this.activeByHost.get(host) ?? 1) - 1;
    if (left <= 0) this.activeByHost.delete(host);
    else this.activeByHost.set(host, left);
  }

  /** One fetch under the total deadline; its outcome, good or bad, is cached. */
  private async fetchOnce(url: URL, clientIdUrl: string): Promise<Outcome> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new CimdError('CIMD fetch exceeded its deadline.'));
      }, this.deadlineMs);
    });
    let outcome: Outcome;
    try {
      const client = await Promise.race([this.load(url, clientIdUrl, controller.signal), deadline]);
      outcome = { client };
    } catch (error) {
      outcome = {
        error: error instanceof CimdError ? error : new CimdError('CIMD fetch failed.'),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
    this.remember(url.toString(), outcome);
    return outcome;
  }

  private remember(key: string, outcome: Outcome): void {
    this.cache.delete(key);
    this.cache.set(key, { at: this.now(), outcome });
    while (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async load(url: URL, clientIdUrl: string, signal: AbortSignal): Promise<CimdClient> {
    // Resolve once, vet every answer, and pin a single address for the socket.
    let resolved: Resolved[];
    try {
      resolved = await this.resolve(url.hostname);
    } catch {
      throw new CimdError('CIMD host did not resolve.');
    }
    if (resolved.length === 0) throw new CimdError('CIMD host did not resolve.');
    for (const entry of resolved) {
      if (isBlockedAddress(entry.address)) {
        throw new CimdError(`CIMD host resolves to a blocked address: ${entry.address}`);
      }
    }
    const pinned = resolved[0]!;

    if (signal.aborted) throw new CimdError('CIMD fetch exceeded its deadline.');
    const body = await this.getBody(url, pinned, signal);
    let document: unknown;
    try {
      document = JSON.parse(body);
    } catch {
      throw new CimdError('CIMD document is not valid JSON.');
    }
    if (typeof document !== 'object' || document === null) {
      throw new CimdError('CIMD document must be a JSON object.');
    }
    const record = document as Record<string, unknown>;

    // The document must claim exactly the URL it was fetched from — no speaking for another id.
    if (record['client_id'] !== url.toString() && record['client_id'] !== clientIdUrl) {
      throw new CimdError('CIMD document client_id does not equal the document URL.');
    }

    let redirectUris: string[];
    try {
      redirectUris = validateRegistrationRedirectUris(record['redirect_uris']);
    } catch (error) {
      throw new CimdError(error instanceof Error ? error.message : 'Invalid redirect_uris.');
    }

    return {
      clientId: url.toString(),
      name: sanitiseClientName(record['client_name']) || url.hostname,
      redirectUris,
      verified: isKnownCimdClient(url.toString()),
    };
  }

  /** One hardened GET to the pinned address, capping body, headers and time, refusing redirects. */
  private get(url: URL, pinned: Resolved, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const req = httpsRequest(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          servername: url.hostname, // TLS SNI + certificate check still bind to the real host.
          headers: { accept: 'application/json', 'user-agent': 'TManage-CIMD/1.0' },
          maxHeaderSize: MAX_HEADER_BYTES,
          // The total deadline destroys the socket, whatever stage the exchange is in.
          signal,
          family: pinned.family,
          // Pin the vetted address so the socket cannot re-resolve to a blocked one. Node 22's
          // happy-eyeballs path asks for every address (`all: true`) and expects an array, so
          // both callback shapes are answered with the one pinned address.
          lookup: (_hostname, options, cb) => {
            if ((options as { all?: boolean } | undefined)?.all === true) {
              (cb as unknown as (err: Error | null, addresses: Resolved[]) => void)(null, [pinned]);
              return;
            }
            (cb as (err: Error | null, address: string, family: number) => void)(
              null,
              pinned.address,
              pinned.family,
            );
          },
        },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          // Redirects are never followed — a 3xx is the classic SSRF pivot.
          if (status >= 300 && status < 400) {
            res.destroy();
            reject(new CimdError(`CIMD fetch returned a redirect (${status}), which is refused.`));
            return;
          }
          if (status !== 200) {
            res.destroy();
            reject(new CimdError(`CIMD fetch returned HTTP ${status}.`));
            return;
          }
          let received = 0;
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > MAX_BODY_BYTES) {
              res.destroy();
              reject(new CimdError('CIMD document exceeds the 5 KB cap.'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          res.on('error', () => reject(new CimdError('CIMD response stream failed.')));
        },
      );
      req.setTimeout(TIMEOUT_MS, () => req.destroy(new CimdError('CIMD fetch timed out.')));
      req.on('error', (error) =>
        reject(error instanceof CimdError ? error : new CimdError('CIMD fetch failed.')),
      );
      req.end();
    });
  }
}

function unwrap(outcome: Outcome): CimdClient {
  if ('error' in outcome) throw outcome.error;
  return outcome.client;
}
