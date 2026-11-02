import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { checkWebhookUrl, isBlockedIpAddress } from './url-guard.js';

/**
 * R13 slice 2 (56-08) — the delivery-time egress guard.
 *
 * `url-guard.ts` judges the URL **as written**, at registration. That cannot see a name that
 * resolves to a public address when it is registered and to `127.0.0.1` when it is delivered to
 * (DNS rebinding). This module closes that: resolve the host *now*, refuse it if **any** answer is
 * private / loopback / link-local / metadata / CGNAT / multicast (`isBlockedIpAddress`) or is the
 * deployment's own host, and hand back the one vetted address so the connection is **pinned** to
 * it — a second DNS answer cannot swap a private address in between the check and the connect.
 *
 * The delivery itself (in the worker) then POSTs with `redirect: 'manual'` (a 3xx is a failed
 * attempt, never followed), a 10 s timeout, a 1 MB read cap, and keeps a 500-char excerpt only —
 * the constants below are the contract both sides use. The API runs the same resolve on a manual
 * retry, a resume and a replay, so an endpoint that now points inside the network is refused with
 * `blocked_private_ip` before anything is queued.
 */

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_MAX_RESPONSE_BYTES = 1024 * 1024;
export const WEBHOOK_EXCERPT_CHARS = 500;

export type EgressRefusal =
  'invalid_url' | 'blocked_private_ip' | 'blocked_own_host' | 'unresolvable';

export type EgressVerdict =
  | { readonly ok: true; readonly url: URL; readonly address: string; readonly family: 4 | 6 }
  | { readonly ok: false; readonly reason: EgressRefusal };

export type EgressResolver = (
  hostname: string,
) => Promise<readonly { readonly address: string; readonly family: number }[]>;

export const systemEgressResolver: EgressResolver = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

function normalHost(host: string): string {
  return host
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '')
    .toLowerCase();
}

/** The hostnames of TManage's own public URLs (API, web) — never a webhook target. */
export function ownHostsFrom(urls: readonly (string | undefined)[]): readonly string[] {
  const hosts: string[] = [];
  for (const raw of urls) {
    if (raw === undefined || raw === '') continue;
    try {
      hosts.push(normalHost(new URL(raw).hostname));
    } catch {
      // A malformed configured URL names no host to refuse.
    }
  }
  return hosts;
}

/**
 * Resolve and vet `raw` for one delivery. Refuses the URL rules first (`checkWebhookUrl`), then
 * TManage's own hosts, then every resolved address; on success returns the address to pin.
 */
export async function resolveEgress(
  raw: string,
  options: { readonly resolve?: EgressResolver; readonly ownHosts?: readonly string[] } = {},
): Promise<EgressVerdict> {
  if (!checkWebhookUrl(raw).ok) {
    // A stored URL failing the write-time rule now means the rule tightened — never deliver.
    let parsed: URL | null = null;
    try {
      parsed = new URL(raw);
    } catch {
      return { ok: false, reason: 'invalid_url' };
    }
    const literal = normalHost(parsed.hostname);
    return isIP(literal) !== 0 || literal === 'localhost' || literal.endsWith('.localhost')
      ? { ok: false, reason: 'blocked_private_ip' }
      : { ok: false, reason: 'invalid_url' };
  }
  const url = new URL(raw);
  const host = normalHost(url.hostname);
  const own = (options.ownHosts ?? []).map(normalHost);
  if (own.some((name) => host === name || host.endsWith(`.${name}`))) {
    return { ok: false, reason: 'blocked_own_host' };
  }
  const literalFamily = isIP(host);
  if (literalFamily !== 0) {
    return isBlockedIpAddress(host)
      ? { ok: false, reason: 'blocked_private_ip' }
      : { ok: true, url, address: host, family: literalFamily as 4 | 6 };
  }
  let answers: readonly { readonly address: string; readonly family: number }[];
  try {
    answers = await (options.resolve ?? systemEgressResolver)(host);
  } catch {
    return { ok: false, reason: 'unresolvable' };
  }
  if (answers.length === 0) return { ok: false, reason: 'unresolvable' };
  // Any blocked answer refuses the whole name: a resolver that round-robins a private address
  // must not get a delivery through on a lucky pick.
  if (answers.some((answer) => isBlockedIpAddress(answer.address))) {
    return { ok: false, reason: 'blocked_private_ip' };
  }
  const first = answers[0] as { readonly address: string; readonly family: number };
  return { ok: true, url, address: first.address, family: first.family === 6 ? 6 : 4 };
}

/** The 500-char excerpt a delivery row keeps of the target's answer. */
export function responseExcerpt(body: string): string | null {
  const text = body.replace(/\s+/gu, ' ').trim();
  return text === '' ? null : [...text].slice(0, WEBHOOK_EXCERPT_CHARS).join('');
}

/** Nest token for the egress settings the webhook routes resolve with (tests inject a resolver). */
export const WEBHOOK_EGRESS = Symbol('tmanage.automations.webhookEgress');

export interface WebhookEgressSettings {
  readonly resolve?: EgressResolver;
  readonly ownHosts: readonly string[];
}

/** The deployment's own hosts, from the environment the API boots with. */
export function webhookEgressFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WebhookEgressSettings {
  return { ownHosts: ownHostsFrom([env['API_PUBLIC_URL'], env['WEB_PUBLIC_URL']]) };
}

/** The 400 detail a refused egress maps to — the class, never a resolved address. */
export function egressRefusalMessage(reason: EgressRefusal): string {
  switch (reason) {
    case 'blocked_private_ip':
      return 'resolves to a private, loopback or metadata address (blocked_private_ip)';
    case 'blocked_own_host':
      return 'must not point at TManage itself (blocked_own_host)';
    case 'unresolvable':
      return 'does not resolve right now (unresolvable)';
    default:
      return 'is not a valid webhook URL (invalid_url)';
  }
}
