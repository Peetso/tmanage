import { randomBytes } from 'node:crypto';
import { INTERNAL_ROLES } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';

/**
 * 57-08 REFERRAL — the pure rules of invite links and partner codes. Every one runs on the server;
 * the web screen only draws what the API answers.
 */

/** A recorded sign-up's outcome. Only `counted` reaches the inviting owner's list. */
export const REFERRAL_OUTCOMES = ['counted', 'self', 'same_domain', 'rate_limited'] as const;
export type ReferralOutcome = (typeof REFERRAL_OUTCOMES)[number];

/** Counted sign-ups per code in any rolling 24 hours; the rest are recorded as `rate_limited`. */
export const REFERRAL_COUNTED_PER_DAY = 10;

/** The newest counted sign-ups the owner's list shows. */
export const REFERRAL_LIST_MAX = 200;

/** A partner's display name, in characters (the column is VARCHAR(120)). */
export const PARTNER_NAME_MAX = 120;

/** The reward a counted sign-up records. Recorded only: nothing pays it out. */
export const REFERRAL_REWARD = { kind: 'account_credit', state: 'recorded' } as const;

/** Partner codes start with `p.`; a workspace slug never holds a dot, so the two never collide. */
export const PARTNER_CODE_PREFIX = 'p.';

const CODE_SHAPE = /^(?:p\.)?[a-z0-9](?:[a-z0-9-]{0,24})-[a-z2-9]{6}$/u;
/** No 0/1/o/l, so a code read aloud or copied by hand cannot be mistyped into another one. */
const SUFFIX_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/**
 * Only the workspace owner gets an invite link. An organization admin, every other internal role,
 * every client role and the hidden Support-session role are refused (403).
 */
export function mayUseReferrals(principal: Principal): boolean {
  return (
    principal.kind === 'internal' &&
    principal.membershipStatus === 'active' &&
    principal.role === 'owner'
  );
}

export function requireReferralOwner(principal: Principal): void {
  if (!mayUseReferrals(principal)) {
    throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'referral:owner');
  }
}

function suffix(random: (size: number) => Buffer): string {
  const bytes = random(6);
  let out = '';
  for (const byte of bytes) out += SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length];
  return out;
}

/** `northstar` → `northstar-7q4k2m`: the workspace's web link (first 24 characters) and a random tail. */
export function newWorkspaceCode(
  slug: string,
  random: (size: number) => Buffer = randomBytes,
): string {
  const base =
    slug
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]+/gu, '-')
      .replaceAll(/^-+|-+$/gu, '')
      .slice(0, 24)
      .replaceAll(/-+$/gu, '') || 'workspace';
  return `${base}-${suffix(random)}`;
}

/** `Cedar Agency` → `p.cedar-agency-4k2m9q`. */
export function newPartnerCode(
  name: string,
  random: (size: number) => Buffer = randomBytes,
): string {
  return `${PARTNER_CODE_PREFIX}${newWorkspaceCode(name.normalize('NFKD'), random)}`;
}

/** A code from the sign-up body when it has the shape of one; anything else is no referral. */
export function parseReferralCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return value.length <= 40 && CODE_SHAPE.test(value) ? value : null;
}

export function isPartnerCode(code: string): boolean {
  return code.startsWith(PARTNER_CODE_PREFIX);
}

export function parsePartnerName(body: unknown): string {
  const raw = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  if (name === '' || [...name].length > PARTNER_NAME_MAX) {
    throw new ApiError(400, 'validation_failed', 'The request is invalid', [
      { field: 'name', message: `must be 1 to ${String(PARTNER_NAME_MAX)} characters` },
    ]);
  }
  return name;
}

/**
 * Mail providers anyone can sign up with: two people on `gmail.com` are not one company, so the
 * same-domain rule never fires for these (the exact-address rule still does).
 */
export const SHARED_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.net',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'qq.com',
  '163.com',
]);

/**
 * One mailbox, whatever its spelling: lower case, the `+tag` dropped, and for Gmail the dots in
 * the local part too. `peter+2@x.com` and `peter@x.com` are the same person.
 */
export function mailboxOf(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at <= 0) return lower;
  let local = lower.slice(0, at).split('+')[0] ?? '';
  let domain = lower.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replaceAll('.', '');
  return `${local}@${domain}`;
}

export function domainOf(email: string): string {
  const lower = email.trim().toLowerCase();
  return lower.slice(lower.lastIndexOf('@') + 1);
}

/** The roles whose people are "the inviting workspace" for the self and same-domain rules. */
const TEAM_ROLES: ReadonlySet<string> = new Set(
  (INTERNAL_ROLES as readonly string[]).filter((role) => role !== 'platform_support'),
);

export function isTeamRole(role: string): boolean {
  return TEAM_ROLES.has(role);
}

export interface ReferralFacts {
  /** The new account's address (already normalised by sign-up). */
  readonly newEmail: string;
  /** The inviting workspace's team addresses; empty for a partner code. */
  readonly teamEmails: readonly string[];
  /** Counted sign-ups through this code in the last 24 hours. */
  readonly countedLastDay: number;
}

/**
 * The abuse rules, in order:
 * 1. self — the new account is one of the inviting team's own mailboxes (any spelling);
 * 2. same_domain — it shares a company domain with someone on the inviting team;
 * 3. rate_limited — the code already counted {@link REFERRAL_COUNTED_PER_DAY} today.
 * Everything else is counted. A refused sign-up is still a sign-up; only the credit is withheld.
 */
export function classifyReferral(facts: ReferralFacts): ReferralOutcome {
  const mailbox = mailboxOf(facts.newEmail);
  if (facts.teamEmails.some((email) => mailboxOf(email) === mailbox)) return 'self';
  const domain = domainOf(facts.newEmail);
  if (
    !SHARED_MAIL_DOMAINS.has(domain) &&
    facts.teamEmails.some((email) => domainOf(email) === domain)
  ) {
    return 'same_domain';
  }
  if (facts.countedLastDay >= REFERRAL_COUNTED_PER_DAY) return 'rate_limited';
  return 'counted';
}

export function isReferralOutcome(value: unknown): value is ReferralOutcome {
  return typeof value === 'string' && (REFERRAL_OUTCOMES as readonly string[]).includes(value);
}
