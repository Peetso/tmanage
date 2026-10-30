import { createHash } from 'node:crypto';

/**
 * 56-31 — the mail priority lanes (spec 56 §12.1).
 *
 * Every queued message travels in one of four lanes, drained strictly in this order:
 *
 * | lane            | what                                                           | mailbox   |
 * | --------------- | -------------------------------------------------------------- | --------- |
 * | `auth`          | sign-in codes, magic links, password reset, MFA, new device,   | security@ |
 * |                 | erasure / password / credential confirmations                  |           |
 * | `transactional` | invitations, approvals, client requests, receipts, alerts      | noreply@  |
 * | `digest`        | digests, nudges, "while you were away", per-event notices      | noreply@  |
 * | `bulk`          | announcements, GTM, reports                                    | noreply@  |
 *
 * **This file is the one place a template key becomes a lane.** `MailMessage` carries a
 * `templateKey`, never a lane, and no HTTP DTO names either; an unknown key is `transactional`,
 * never `auth` — a producer cannot buy the top lane by inventing a name.
 */

export type MailLane = 'auth' | 'transactional' | 'digest' | 'bulk';
export type Mailbox = 'security' | 'noreply';

/** Drain order, highest priority first. */
export const MAIL_LANES: readonly MailLane[] = Object.freeze([
  'auth',
  'transactional',
  'digest',
  'bulk',
]);

export const MAILBOXES: readonly Mailbox[] = Object.freeze(['security', 'noreply']);

export function isMailLane(value: unknown): value is MailLane {
  return typeof value === 'string' && (MAIL_LANES as readonly string[]).includes(value);
}

const MINUTE_MS = 60_000;

/**
 * `auth` templates and how long their code or link stays valid. A queued row past this deadline
 * is never sent (the drainer marks it `failed`, error `deadline`): a late sign-in code is worse
 * than none. `null` = a notice with no code (sent whenever it can be).
 */
const AUTH_TEMPLATES: Readonly<Record<string, number | null>> = Object.freeze({
  sign_in_code: 10 * MINUTE_MS,
  magic_link: 15 * MINUTE_MS,
  password_reset: 60 * MINUTE_MS,
  mfa_code: 10 * MINUTE_MS,
  mfa_changed: null,
  new_device: null,
  email_change: null,
  password_changed: null,
  credential_change: null,
  erasure_confirmation: null,
  privacy_notice: null,
  security_report_ack: null,
});

const TRANSACTIONAL_TEMPLATES = new Set([
  'invitation',
  'welcome',
  'approval',
  'client_request',
  'receipt',
  'ops_alert',
]);

const DIGEST_TEMPLATES = new Set([
  'digest',
  'nudge',
  'while_you_were_away',
  'collaboration_notice',
  'usage_threshold',
]);

const BULK_TEMPLATES = new Set(['announcement', 'gtm', 'report']);

/** The lane a template travels in. Unknown or absent → `transactional`, never `auth`. */
export function laneForTemplate(templateKey: string | undefined | null): MailLane {
  if (typeof templateKey !== 'string') return 'transactional';
  if (Object.prototype.hasOwnProperty.call(AUTH_TEMPLATES, templateKey)) return 'auth';
  if (DIGEST_TEMPLATES.has(templateKey)) return 'digest';
  if (BULK_TEMPLATES.has(templateKey)) return 'bulk';
  if (TRANSACTIONAL_TEMPLATES.has(templateKey)) return 'transactional';
  return 'transactional';
}

/** The code/link TTL of an `auth` template in ms, or `null` (no deadline / not auth). */
export function authDeadlineMs(templateKey: string | undefined | null): number | null {
  if (typeof templateKey !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(AUTH_TEMPLATES, templateKey)) return null;
  return AUTH_TEMPLATES[templateKey] ?? null;
}

/**
 * The mailbox a lane sends from. `auth` uses the separate security@ mailbox when one is
 * configured (its own hourly ceiling, so a digest storm cannot spend it); otherwise everything
 * shares noreply@ and the lane order alone protects `auth`.
 */
export function mailboxForLane(lane: MailLane, securityConfigured: boolean): Mailbox {
  return lane === 'auth' && securityConfigured ? 'security' : 'noreply';
}

/** The share of a shared mailbox's hour `digest` + `bulk` may use; the rest is kept. */
export const LOWER_LANE_SHARE = 0.8;
/** Kept below the host's stated ceiling, so a miscount never reaches the host's throttle. */
export const CEILING_SAFETY_MARGIN = 0.1;

/** The usable hour budget of a mailbox: the ceiling less the 10 % safety margin. */
export function effectiveCeiling(ceiling: number): number {
  return Math.max(0, Math.floor(ceiling * (1 - CEILING_SAFETY_MARGIN)));
}

/**
 * How many more messages of `lane` may go out of a mailbox this hour.
 *
 * `windowCount` is everything the mailbox already submitted this hour (all lanes). On a shared
 * mailbox `digest` and `bulk` stop once the mailbox reaches 80 % of its usable budget, so 20 %
 * stays for `transactional` (and `auth` when it has no mailbox of its own). `auth` and
 * `transactional` may use the whole usable budget; `auth` on its own mailbox is never deferred
 * while that budget remains.
 */
export function allowance(
  lane: MailLane,
  windowCount: number,
  ceiling: number,
  sharedMailbox = true,
): number {
  const usable = effectiveCeiling(ceiling);
  const lower = lane === 'digest' || lane === 'bulk';
  const limit = lower && sharedMailbox ? Math.floor(usable * LOWER_LANE_SHARE) : usable;
  return Math.max(0, limit - Math.max(0, windowCount));
}

/**
 * A stable minute (0–59) for one user, so scheduled digests and nudges (53-15, 55-24) spread
 * across the hour instead of all landing at :00 and spending the window in one burst.
 */
export function spreadMinute(userId: string): number {
  const digest = createHash('sha256').update(userId, 'utf8').digest();
  return digest.readUInt32BE(0) % 60;
}

/** The start of the clock hour (UTC) holding `at` — the key of `mail_hour_windows`. */
export function hourWindowStart(at: Date): Date {
  const start = new Date(at.getTime());
  start.setUTCMinutes(0, 0, 0);
  return start;
}

/** `platform_settings` keys the API writes and the drainer reads (56-31). */
export function lanePausedSettingKey(lane: MailLane): string {
  return `mail_lane_paused_${lane}`;
}

export function mailboxCeilingSettingKey(mailbox: Mailbox): string {
  return `mail_hour_ceiling_${mailbox}`;
}

/** A stored hour ceiling, or `fallback` for a missing, non-integer or non-positive value. */
export function parseCeiling(stored: string | null | undefined, fallback: number): number {
  if (typeof stored !== 'string' || !/^\d{1,7}$/u.test(stored.trim())) return fallback;
  const value = Number(stored.trim());
  return value > 0 ? value : fallback;
}

/** A stored pause: only the literal `on` pauses. `auth` is never paused, whatever is stored. */
export function laneIsPaused(lane: MailLane, stored: string | null | undefined): boolean {
  return lane !== 'auth' && stored?.trim() === 'on';
}
