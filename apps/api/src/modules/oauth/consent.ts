import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CONSENT_SCOPES, SCOPE_BILLING, SCOPE_PLATFORM, SCOPE_READ } from './scopes.js';

/**
 * The consent page's server-side rules (MCP connector S9) — pure, so each one is unit-tested.
 *
 * - **What the page shows about the client** (threat model B2, "Consent phishing"): the name, a
 *   publisher only for a verified first-party client, the redirect **hostname**, and whether the
 *   redirect is a loopback address. The page never invents a publisher for an unverified app.
 * - **The consent ticket** (B2, "Session fixation"): the page's GET mints an HMAC over the session
 *   id, the user id and the exact authorize parameters; the decision POST must present it from
 *   the same session, with the same parameters, within ten minutes. A consent page loaded in one
 *   session cannot be approved from another, and a parameter changed between loading and
 *   approving (a swapped redirect or challenge) invalidates it.
 * - **Which scopes may be granted**: read is always part of a grant (every other scope builds on
 *   seeing the work), billing only by an owner or organization admin (plan §4.2), and nothing
 *   outside the known vocabulary.
 */

/** How long a loaded consent page stays approvable. */
export const CONSENT_TICKET_TTL_MS = 10 * 60 * 1000;

/** Roles that may grant `tmanage:billing` (plan §4.2: "Only owners and admins can grant it"). */
const BILLING_GRANTING_ROLES: ReadonlySet<string> = new Set(['owner', 'org_admin']);

/** Publisher names for the verified first-party hosts (`known-clients.ts`), by apex. */
const PUBLISHERS: ReadonlyArray<readonly [string, string]> = [
  ['claude.ai', 'Anthropic'],
  ['claude.com', 'Anthropic'],
  ['anthropic.com', 'Anthropic'],
  ['chatgpt.com', 'OpenAI'],
  ['openai.com', 'OpenAI'],
  ['cursor.com', 'Cursor'],
  ['cursor.sh', 'Cursor'],
];

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The authorize parameters a ticket is bound to — exactly what the decision will mint from. */
export interface ConsentBinding {
  readonly sessionId: string;
  readonly userId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly resource: string;
  readonly state: string | null;
}

/** What the consent page renders about the client. */
export interface ConsentClientView {
  readonly name: string;
  readonly verified: boolean;
  /** Only for a verified client; an unverified one never gets a publisher. */
  readonly publisher: string | null;
  /** The hostname the code will be sent to (B2: shown on every consent). */
  readonly redirectHost: string;
  /** True when the code goes to this computer (a desktop or CLI client). */
  readonly loopback: boolean;
}

export function describeClient(input: {
  readonly name: string;
  readonly verified: boolean;
  readonly clientId: string;
  readonly redirectUri: string;
}): ConsentClientView {
  const redirect = new URL(input.redirectUri);
  const redirectHost = redirect.hostname.toLowerCase();
  return {
    name: input.name,
    verified: input.verified,
    publisher: input.verified ? publisherFor(input.clientId) : null,
    redirectHost,
    loopback: LOOPBACK_HOSTS.has(redirectHost),
  };
}

function publisherFor(clientId: string): string | null {
  let host: string;
  try {
    host = new URL(clientId).hostname.toLowerCase();
  } catch {
    return null;
  }
  const match = PUBLISHERS.find(([apex]) => host === apex || host.endsWith(`.${apex}`));
  return match ? match[1] : null;
}

/**
 * The scopes a member may grant, from what the page sent. Unknown values are dropped (the page
 * only ever offers the known four), read is always included, and billing is refused outright
 * for a member who is not an owner or admin — refused rather than silently dropped, so a page
 * that offered it in error is noticed.
 */
export function resolveGrantedScopes(
  chosen: unknown,
  role: string,
  /** ADR-0015 F11: the person is a platform admin with two-step on and a fresh step-up now. */
  platformEligible = false,
): { readonly ok: true; readonly scopes: readonly string[] } | { readonly ok: false } {
  const picked = new Set<string>([SCOPE_READ]);
  if (Array.isArray(chosen)) {
    for (const value of chosen) {
      if (typeof value === 'string' && CONSENT_SCOPES.includes(value)) picked.add(value);
    }
  }
  if (picked.has(SCOPE_BILLING) && !BILLING_GRANTING_ROLES.has(role)) return { ok: false };
  // F11: refused rather than dropped, like billing, so a page that offered it in error is noticed.
  if (picked.has(SCOPE_PLATFORM) && !platformEligible) return { ok: false };
  return { ok: true, scopes: CONSENT_SCOPES.filter((scope) => picked.has(scope)) };
}

/**
 * ADR-0015 F1 — the external platform scope's own window, separate from the browser step-up's
 * 24 hours: `PLATFORM_AI_SCOPE_MINUTES`, a whole number from 5 to 240, default 60.
 */
export const PLATFORM_AI_SCOPE_DEFAULT_MINUTES = 60;
export const PLATFORM_AI_SCOPE_MAX_MINUTES = 240;
const PLATFORM_AI_SCOPE_MIN_MINUTES = 5;

export function platformAiScopeMinutes(env: Readonly<Record<string, string | undefined>>): number {
  const raw = (env['PLATFORM_AI_SCOPE_MINUTES'] ?? '').trim();
  const minutes = /^\d{1,3}$/u.test(raw) ? Number(raw) : PLATFORM_AI_SCOPE_DEFAULT_MINUTES;
  return minutes >= PLATFORM_AI_SCOPE_MIN_MINUTES && minutes <= PLATFORM_AI_SCOPE_MAX_MINUTES
    ? minutes
    : PLATFORM_AI_SCOPE_DEFAULT_MINUTES;
}

/** F11: the consent's step-up must be this fresh (minutes, not the browser window's hours). */
export const PLATFORM_CONSENT_STEP_UP_FRESH_MS = 10 * 60 * 1000;

/** What the consent page may offer about `tmanage:platform`, decided by the server (F11). */
export interface PlatformConsentStanding {
  /** The person is a platform admin: the page shows the switch (off by default). */
  readonly offered: boolean;
  /** Two-step is on where required and the step-up in this session is fresh: it can be ticked. */
  readonly ready: boolean;
  /** The live step-up's own end, which also caps the platform window. */
  readonly stepUpExpiresAt: Date | null;
}

/** Port: the platform standing of the consenting person in this browser session. */
export interface PlatformConsentCheck {
  standing(
    userId: string,
    sessionId: string,
    correlationId: string,
  ): Promise<PlatformConsentStanding>;
}

export const PLATFORM_CONSENT_CHECK = Symbol.for('tmanage.OAuthPlatformConsentCheck');

/** F1: the window end — the scope's minutes from now, never past the step-up's own end. */
export function platformWindowEnd(now: Date, minutes: number, stepUpExpiresAt: Date | null): Date {
  const own = now.getTime() + minutes * 60_000;
  const cap = stepUpExpiresAt?.getTime() ?? own;
  return new Date(Math.min(own, cap));
}

/** Whether a member in this role can grant billing — the page greys the switch out otherwise. */
export function canGrantBilling(role: string): boolean {
  return BILLING_GRANTING_ROLES.has(role);
}

/**
 * Mints and verifies consent tickets. The key lives in memory only: a restart invalidates open
 * consent pages, which simply ask the person to start the connection again (fail safe).
 */
export class ConsentTickets {
  private readonly key: Buffer;

  constructor(
    key: Buffer = randomBytes(32),
    private readonly now: () => number = Date.now,
  ) {
    this.key = key;
  }

  mint(binding: ConsentBinding): string {
    const issuedAt = this.now();
    return `${issuedAt}.${this.mac(issuedAt, binding)}`;
  }

  verify(ticket: unknown, binding: ConsentBinding): boolean {
    if (typeof ticket !== 'string') return false;
    const match = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/.exec(ticket);
    if (!match) return false;
    const issuedAt = Number(match[1]);
    const age = this.now() - issuedAt;
    if (age < 0 || age > CONSENT_TICKET_TTL_MS) return false;
    const expected = Buffer.from(this.mac(issuedAt, binding));
    const presented = Buffer.from(match[2] ?? '');
    return expected.length === presented.length && timingSafeEqual(expected, presented);
  }

  private mac(issuedAt: number, binding: ConsentBinding): string {
    const payload = JSON.stringify([
      issuedAt,
      binding.sessionId,
      binding.userId,
      binding.clientId,
      binding.redirectUri,
      binding.challenge,
      binding.resource,
      binding.state,
    ]);
    return createHmac('sha256', this.key).update(payload, 'utf8').digest('base64url');
  }
}
