import { resolveTxt } from 'node:dns/promises';

/**
 * 51-11 — the DNS reader: SPF, DKIM and DMARC of the sending domain, verdict only.
 *
 * Three TXT lookups (`<domain>`, `<selector>._domainkey.<domain>`, `_dmarc.<domain>`) through
 * `node:dns`, parsed into a small verdict per mechanism. It reads public DNS and nothing else; it
 * changes nothing (the records are Peter's hPanel step) and never throws — a lookup that fails is
 * a `missing` or `error` verdict, so the platform screen and `/healthz/deep` can always answer.
 *
 * Hostinger's mail DKIM is published as CNAMEs `hostingermail-a/-b/-c._domainkey` that point at its
 * key records; a TXT query follows the CNAME, so the default selectors are those three. An
 * operator overrides them with `EMAIL_DKIM_SELECTORS` (comma-separated).
 */

export type AuthStatus = 'pass' | 'weak' | 'missing' | 'invalid' | 'error';

export interface MechanismVerdict {
  readonly status: AuthStatus;
  /** One short reason a person can act on; never the raw record. */
  readonly note: string;
}

export interface DmarcVerdict extends MechanismVerdict {
  readonly policy: 'none' | 'quarantine' | 'reject' | null;
}

export interface DomainAuthReport {
  readonly domain: string;
  readonly spf: MechanismVerdict;
  readonly dkim: MechanismVerdict & { readonly selector: string | null };
  readonly dmarc: DmarcVerdict;
  /** `pass` only when all three pass; `weak` when none fails but one is weak. */
  readonly overall: 'pass' | 'weak' | 'fail';
  readonly checkedAt: string;
}

export type TxtResolver = (name: string) => Promise<string[][]>;

export const DEFAULT_DKIM_SELECTORS: readonly string[] = [
  'hostingermail-a',
  'hostingermail-b',
  'hostingermail-c',
];

const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA', 'ENONAME', 'NXDOMAIN']);

/** TXT strings of one name, each record's chunks joined; `null` = the name has no TXT. */
async function lookup(resolver: TxtResolver, name: string): Promise<string[] | null> {
  try {
    return (await resolver(name)).map((chunks) => chunks.join(''));
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && NOT_FOUND.has(code)) return null;
    throw error;
  }
}

export function parseSpf(records: readonly string[] | null): MechanismVerdict {
  const spf = (records ?? []).filter((r) => /^v=spf1(\s|$)/iu.test(r.trim()));
  if (spf.length === 0) return { status: 'missing', note: 'no v=spf1 record' };
  if (spf.length > 1) return { status: 'invalid', note: 'more than one v=spf1 record; merge them' };
  const terms = (spf[0] ?? '').trim().toLowerCase().split(/\s+/u);
  if (terms.includes('+all') || terms.includes('all')) {
    return { status: 'invalid', note: '+all lets anyone send as this domain' };
  }
  if (!terms.some((t) => t.startsWith('include:') || /^[+]?(a|mx|ip4|ip6)(:|$)/u.test(t))) {
    return { status: 'invalid', note: 'no sender is authorised' };
  }
  if (terms.includes('-all')) return { status: 'pass', note: 'hard fail for other senders' };
  if (terms.includes('~all'))
    return { status: 'pass', note: 'soft fail (~all); -all once DKIM passes' };
  return { status: 'weak', note: 'no ~all/-all terminator' };
}

export function parseDkim(records: readonly string[] | null): MechanismVerdict {
  const key = (records ?? []).find((r) => /(^|;)\s*p=/iu.test(r));
  if (key === undefined) return { status: 'missing', note: 'no DKIM key record' };
  const p = /(?:^|;)\s*p=([^;]*)/iu.exec(key)?.[1]?.replaceAll(/\s+/gu, '') ?? '';
  if (p === '') return { status: 'invalid', note: 'DKIM key is revoked (empty p=)' };
  // Base64 of a 2048-bit RSA SubjectPublicKeyInfo is ~392 chars; 1024-bit is ~216.
  if (/k=rsa/iu.test(key) || !/k=/iu.test(key)) {
    if (p.length < 300) return { status: 'weak', note: 'DKIM key shorter than 2048 bits' };
  }
  return { status: 'pass', note: 'DKIM key published' };
}

export function parseDmarc(records: readonly string[] | null): DmarcVerdict {
  const dmarc = (records ?? []).filter((r) => /^v=DMARC1\s*(;|$)/iu.test(r.trim()));
  if (dmarc.length === 0) return { status: 'missing', note: 'no v=DMARC1 record', policy: null };
  if (dmarc.length > 1)
    return { status: 'invalid', note: 'more than one DMARC record', policy: null };
  const tags = new Map<string, string>();
  for (const part of (dmarc[0] ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) tags.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
  }
  const raw = tags.get('p')?.toLowerCase();
  if (raw !== 'none' && raw !== 'quarantine' && raw !== 'reject') {
    return { status: 'invalid', note: 'p= is missing or unknown', policy: null };
  }
  const reports = tags.has('rua') ? '' : '; no rua= reports address';
  if (raw === 'none') {
    return { status: 'weak', note: `p=none (monitoring only)${reports}`, policy: raw };
  }
  return { status: 'pass', note: `p=${raw}${reports}`, policy: raw };
}

function failed(note: string): MechanismVerdict {
  return { status: 'error', note };
}

/** Run the three lookups for one domain. Never throws. */
export async function checkDomainAuth(
  domain: string,
  options: {
    readonly resolver?: TxtResolver;
    readonly selectors?: readonly string[];
    readonly now?: Date;
  } = {},
): Promise<DomainAuthReport> {
  const resolver = options.resolver ?? resolveTxt;
  const selectors = options.selectors ?? DEFAULT_DKIM_SELECTORS;

  const spf = await lookup(resolver, domain).then(parseSpf, () => failed('SPF lookup failed'));
  const dmarc = await lookup(resolver, `_dmarc.${domain}`).then(parseDmarc, () => ({
    ...failed('DMARC lookup failed'),
    policy: null,
  }));
  let dkim: MechanismVerdict & { selector: string | null } = {
    status: 'missing',
    note: `no DKIM key at ${selectors.join(', ')}`,
    selector: null,
  };
  for (const selector of selectors) {
    const verdict = await lookup(resolver, `${selector}._domainkey.${domain}`).then(parseDkim, () =>
      failed('DKIM lookup failed'),
    );
    if (verdict.status === 'missing') continue;
    dkim = { ...verdict, selector };
    if (verdict.status === 'pass') break;
  }

  const all = [spf.status, dkim.status, dmarc.status];
  const overall = all.every((s) => s === 'pass')
    ? 'pass'
    : all.every((s) => s === 'pass' || s === 'weak')
      ? 'weak'
      : 'fail';
  return {
    domain,
    spf,
    dkim,
    dmarc,
    overall,
    checkedAt: (options.now ?? new Date()).toISOString(),
  };
}

/** The sending domain of a From address, lower-cased; `null` for anything without one. */
export function sendingDomainOf(fromAddress: string | undefined): string | null {
  const at = fromAddress?.lastIndexOf('@') ?? -1;
  if (fromAddress === undefined || at < 1) return null;
  const domain = fromAddress
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/u.test(domain) ? domain : null;
}
