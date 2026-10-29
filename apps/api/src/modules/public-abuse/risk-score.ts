import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 52-21 — the public-write risk score (spec 52 §52-21). Pure: every signal is a fact the guard
 * has already measured, and this file only adds weights and draws the decision line, so the
 * fixtures in `risk-score.test.ts` pin the whole policy.
 *
 * | signal                                   | weight |
 * | ---------------------------------------- | -----: |
 * | honeypot field filled                    |    100 |
 * | form filled in under 3 s                 |     60 |
 * | no (or a wrong) JS proof                 |     60 |
 * | disposable e-mail domain                 |     30 |
 * | more than 3 URLs in the text             |     30 |
 * | same submitted values seen within 24 h   |     40 |
 * | more than 10 submissions from the IP/day |     30 |
 * | Accept-Language does not match the page  |      5 |
 *
 * Decisions: under 30 allow; 30–69 hold (and, where the surface can show one, a challenge);
 * 70 and over spam. A person never trips the hold line on one ordinary signal alone except the
 * two that only a script produces (no JS proof, or a form filled faster than a person reads it).
 */

export const RISK_WEIGHTS = {
  honeypot: 100,
  fast_fill: 60,
  no_js_proof: 60,
  disposable_domain: 30,
  many_urls: 30,
  repeated_values: 40,
  ip_daily_volume: 30,
  language_mismatch: 5,
} as const;

export type RiskSignal = keyof typeof RISK_WEIGHTS;

/** The hold line (inclusive) and the spam line (inclusive). */
export const HOLD_AT = 30;
export const SPAM_AT = 70;
/** Faster than this from the form being shown to it being sent is not a person. */
export const MIN_FILL_MS = 3_000;
export const MAX_URLS = 3;
export const IP_DAILY_THRESHOLD = 10;

export type RiskDecision = 'allow' | 'hold' | 'spam';

export interface RiskFacts {
  readonly honeypotFilled: boolean;
  /** Milliseconds from the signed `startedAt` to now; `undefined` when no valid token came. */
  readonly fillMs?: number | undefined;
  readonly jsProofValid: boolean;
  readonly disposableDomain: boolean;
  readonly urlCount: number;
  readonly repeatedWithin24h: boolean;
  /** Submissions from this IP today, this one included. */
  readonly ipSubmissionsToday: number;
  readonly languageMismatch: boolean;
  /** `RATE_LIMIT_SCALE` (e2e only) widens the per-IP threshold as it widens the buckets. */
  readonly ipThresholdScale?: number;
}

export interface RiskScore {
  readonly score: number;
  readonly reasons: readonly RiskSignal[];
  readonly decision: RiskDecision;
}

export function decisionFor(score: number): RiskDecision {
  if (score >= SPAM_AT) return 'spam';
  if (score >= HOLD_AT) return 'hold';
  return 'allow';
}

export function scoreRisk(facts: RiskFacts): RiskScore {
  const reasons: RiskSignal[] = [];
  if (facts.honeypotFilled) reasons.push('honeypot');
  if (facts.fillMs !== undefined && facts.fillMs < MIN_FILL_MS) reasons.push('fast_fill');
  if (!facts.jsProofValid) reasons.push('no_js_proof');
  if (facts.disposableDomain) reasons.push('disposable_domain');
  if (facts.urlCount > MAX_URLS) reasons.push('many_urls');
  if (facts.repeatedWithin24h) reasons.push('repeated_values');
  const ipThreshold = IP_DAILY_THRESHOLD * Math.max(1, facts.ipThresholdScale ?? 1);
  if (facts.ipSubmissionsToday > ipThreshold) reasons.push('ip_daily_volume');
  if (facts.languageMismatch) reasons.push('language_mismatch');
  const score = reasons.reduce((sum, signal) => sum + RISK_WEIGHTS[signal], 0);
  return { score, reasons, decision: decisionFor(score) };
}

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"']+/giu;

/** URLs across every free-text field of the submission. */
export function countUrls(texts: readonly (string | undefined)[]): number {
  return texts.reduce((sum, text) => sum + (text?.match(URL_PATTERN)?.length ?? 0), 0);
}

/** The domain of an address, lower case, or `undefined` when it has none. */
export function emailDomain(email: string | undefined): string | undefined {
  if (email === undefined) return undefined;
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return undefined;
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

/**
 * True when the browser's languages do not include the page's language. A missing header or a
 * missing page locale is not a mismatch (no evidence either way).
 */
export function isLanguageMismatch(
  acceptLanguage: string | undefined,
  pageLocale: string | undefined,
): boolean {
  if (acceptLanguage === undefined || acceptLanguage.trim() === '') return false;
  if (pageLocale === undefined || pageLocale.trim() === '') return false;
  const page = pageLocale.trim().toLowerCase().split('-')[0];
  const offered = acceptLanguage
    .split(',')
    .map((part) => part.split(';')[0]?.trim().toLowerCase().split('-')[0] ?? '')
    .filter((tag) => tag !== '');
  if (offered.includes('*')) return false;
  return !offered.includes(page ?? '');
}

/** A few of the commonest, used only when the bundled list cannot be read (a stripped build). */
const BUILT_IN_DISPOSABLE = [
  'mailinator.com',
  'guerrillamail.com',
  '10minutemail.com',
  'yopmail.com',
  'tempmail.com',
  'temp-mail.org',
  'trashmail.com',
  'sharklasers.com',
  'getnada.com',
  'maildrop.cc',
];

export function parseDomainList(text: string): ReadonlySet<string> {
  return new Set(
    text
      .split(/\r?\n/u)
      .map((line) => line.replace(/#.*$/u, '').trim().toLowerCase())
      .filter((line) => line !== ''),
  );
}

let disposable: ReadonlySet<string> | undefined;

/**
 * `disposable-domains.txt` next to this module (or its source copy when running from `dist`,
 * which `tsc` does not copy text files into); the built-in few when neither can be read.
 */
export function disposableDomains(): ReadonlySet<string> {
  if (disposable !== undefined) return disposable;
  const here = fileURLToPath(new URL('./disposable-domains.txt', import.meta.url));
  const candidates = [here, here.replace(/([\\/])dist([\\/])/u, '$1src$2')];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        disposable = parseDomainList(readFileSync(candidate, 'utf8'));
        return disposable;
      }
    } catch {
      // fall through to the next candidate
    }
  }
  disposable = new Set(BUILT_IN_DISPOSABLE);
  return disposable;
}

/** A domain or any parent of it is on the list (`x.mailinator.com` counts). */
export function isDisposableDomain(
  domain: string | undefined,
  list: ReadonlySet<string> = disposableDomains(),
): boolean {
  if (domain === undefined) return false;
  const labels = domain.split('.');
  for (let index = 0; index < labels.length - 1; index += 1) {
    if (list.has(labels.slice(index).join('.'))) return true;
  }
  return false;
}
