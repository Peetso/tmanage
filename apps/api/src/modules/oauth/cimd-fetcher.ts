import { lookup as dnsLookupAll } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { Injectable } from '@nestjs/common';
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
 *   - **5 KB body cap and 3 s timeout.**
 *   - the document's **`client_id` must equal the document URL**, so a URL cannot speak for
 *     another, and its `redirect_uris` go through the same validation as a DCR body.
 *
 * Results are cached by the caller (24 h, as the `oauth_clients` row's age — `oauth.service.ts`),
 * so this network path runs at most once per client per day.
 */

const MAX_BODY_BYTES = 5 * 1024;
const TIMEOUT_MS = 3_000;

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

@Injectable()
export class CimdFetcher {
  /**
   * Fetch and validate the CIMD document for `clientIdUrl`. Returns the client to persist, or
   * throws `CimdError`. No part of the client-supplied URL or document is trusted until it has
   * passed every check above.
   */
  async fetchMetadata(clientIdUrl: string): Promise<CimdClient> {
    const url = assertCimdUrl(clientIdUrl);

    // Resolve once, vet every answer, and pin a single address for the socket.
    let resolved: { address: string; family: number }[];
    try {
      resolved = await dnsLookupAll(url.hostname, { all: true, verbatim: true });
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

    const body = await this.get(url, pinned);
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

  /** One hardened GET to the pinned address, capping body and time and refusing any redirect. */
  private get(url: URL, pinned: { address: string; family: number }): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const req = httpsRequest(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          servername: url.hostname, // TLS SNI + certificate check still bind to the real host.
          headers: { accept: 'application/json', 'user-agent': 'TManage-CIMD/1.0' },
          // Pin the vetted address so the socket cannot re-resolve to a blocked one.
          lookup: (_hostname, _options, cb) => {
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
