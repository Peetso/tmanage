import { isHeadlessAgent, isToolAgent } from './user-agent-summary.js';

/**
 * R12 (R1, SPEC D3). How much a sign-in looks like a script rather than a person. Pure: every
 * input is passed in, nothing is read. The verdict is a hint with its reasons, never a certainty —
 * there is deliberately no "certain" value.
 */
export const AUTOMATION_WEIGHTS = {
  ua_headless: 40,
  ua_tool: 40,
  ch_headless: 30,
  webdriver: 35,
  form_too_fast: 20,
  no_keystrokes: 15,
  hosting_ip: 15,
  tor_ip: 10,
  rate_high: 15,
  accept_language_missing: 10,
} as const;

export type AutomationReason = keyof typeof AUTOMATION_WEIGHTS;
export type AutomationVerdict = 'likely_automated' | 'unclear' | 'likely_person';

export const FORM_TOO_FAST_MS = 1500;
export const RATE_HIGH_ATTEMPTS = 5;
export const LIKELY_AUTOMATED_AT = 60;
export const UNCLEAR_AT = 25;

/** What the sign-in page reports about itself (all optional; absent proves nothing). */
export interface ClientSignals {
  readonly webdriver?: boolean;
  readonly formMs?: number;
  readonly keystrokes?: number;
  readonly hints?: string;
}

export interface AutomationInput {
  readonly userAgent: string | null;
  /** `Sec-CH-UA` header and/or the page's reported brands. */
  readonly clientHints: string | null;
  readonly acceptLanguage: string | null;
  readonly client: ClientSignals | null;
  readonly hostingIp: boolean;
  readonly torIp: boolean;
  /** Sign-in attempts from this address in the last 10 minutes, this one excluded. */
  readonly recentAttemptsFromIp: number;
}

export interface AutomationSignal {
  readonly score: number;
  readonly verdict: AutomationVerdict;
  readonly reasons: readonly AutomationReason[];
}

export function scoreAutomation(input: AutomationInput): AutomationSignal {
  const reasons: AutomationReason[] = [];
  const client = input.client;
  if (isHeadlessAgent(input.userAgent)) reasons.push('ua_headless');
  else if (isToolAgent(input.userAgent)) reasons.push('ua_tool');
  if (/headless/i.test(input.clientHints ?? '')) reasons.push('ch_headless');
  if (client?.webdriver === true) reasons.push('webdriver');
  if (typeof client?.formMs === 'number' && client.formMs < FORM_TOO_FAST_MS) {
    reasons.push('form_too_fast');
  }
  if (client?.keystrokes === 0) reasons.push('no_keystrokes');
  if (input.hostingIp) reasons.push('hosting_ip');
  if (input.torIp) reasons.push('tor_ip');
  if (input.recentAttemptsFromIp >= RATE_HIGH_ATTEMPTS) reasons.push('rate_high');
  if ((input.acceptLanguage ?? '').trim() === '') reasons.push('accept_language_missing');
  const score = Math.min(
    100,
    reasons.reduce((sum, reason) => sum + AUTOMATION_WEIGHTS[reason], 0),
  );
  return { score, verdict: verdictOf(score), reasons };
}

export function verdictOf(score: number): AutomationVerdict {
  if (score >= LIKELY_AUTOMATED_AT) return 'likely_automated';
  if (score >= UNCLEAR_AT) return 'unclear';
  return 'likely_person';
}

/**
 * The page's `client` object, validated field by field. A bad field is dropped, never refused:
 * a sign-in must not fail (or become a 400) because a browser sent something odd.
 */
export function parseClientSignals(raw: unknown): ClientSignals | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as {
    readonly webdriver?: unknown;
    readonly formMs?: unknown;
    readonly keystrokes?: unknown;
    readonly hints?: unknown;
  };
  const out: { webdriver?: boolean; formMs?: number; keystrokes?: number; hints?: string } = {};
  if (typeof value.webdriver === 'boolean') out.webdriver = value.webdriver;
  if (isIntIn(value.formMs, 0, 3_600_000)) out.formMs = value.formMs;
  if (isIntIn(value.keystrokes, 0, 10_000)) out.keystrokes = value.keystrokes;
  if (typeof value.hints === 'string' && value.hints.length <= 255) out.hints = value.hints;
  return Object.keys(out).length === 0 ? null : out;
}

function isIntIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
