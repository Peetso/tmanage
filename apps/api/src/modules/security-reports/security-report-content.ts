import { randomBytes } from 'node:crypto';
import { signOffText } from '@tmanage/mail';
import { emailT } from '../../common/i18n/email-messages.js';
import { ApiError } from '../../common/http/errors.js';

/**
 * 56-17 — what a vulnerability report may carry, checked at the door before anything is stored.
 *
 * Text only: a title (≤ 200), a body (≤ 20 000 characters, the brief's 20 kB), an optional name
 * and e-mail for the acknowledgement, and the reporter's claimed severity. Anything that looks
 * like markup (`<tag`, `</tag`, `<!--`, `<?`) is refused, not stripped — a triager reads the
 * report as typed, and nothing is ever rendered from it. Unknown fields are ignored (52-21's
 * invisible proof fields ride in the same body).
 */

export const SECURITY_REPORT_STATUSES = [
  'new',
  'triaged',
  'fixed',
  'duplicate',
  'invalid',
] as const;
export type SecurityReportStatus = (typeof SECURITY_REPORT_STATUSES)[number];

export const CLAIMED_SEVERITIES = ['none', 'low', 'medium', 'high', 'critical'] as const;
export type ClaimedSeverity = (typeof CLAIMED_SEVERITIES)[number];

export const MAX_TITLE = 200;
export const MAX_BODY = 20_000;
export const MAX_NAME = 200;
export const MAX_EMAIL = 254;
/** Whole request text, measured in UTF-8 bytes, before any field is looked at. */
export const MAX_REQUEST_BYTES = 24_000;

const EMAIL_SHAPE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u;
/** Markup openers. `a < b` and `<3` stay legal; `<script`, `</p`, `<!--`, `<?php` do not. */
const MARKUP = /<\/?[a-z!?]/iu;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REFERENCE_SHAPE = /^SR-[A-HJ-NP-Z2-9]{8}$/u;

export interface SecurityReportInput {
  readonly title: string;
  readonly body: string;
  readonly severityClaimed: ClaimedSeverity;
  readonly reporterName: string | null;
  readonly reporterEmail: string | null;
  readonly language: 'en' | 'ar' | null;
}

export interface SecurityReportUpdate {
  readonly status?: SecurityReportStatus;
  readonly creditName?: string | null;
  readonly creditPublic?: boolean;
}

type Detail = { field: string; message: string };

/** `SR-` + 8 symbols from a 32-letter alphabet without 0/O/1/I: 40 bits, read aloud safely. */
export function newSecurityReportReference(): string {
  const bytes = randomBytes(8);
  let out = 'SR-';
  for (const byte of bytes) out += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  return out;
}

export function isSecurityReportReference(value: unknown): value is string {
  return typeof value === 'string' && REFERENCE_SHAPE.test(value);
}

/** The honeypot (`website`, 52-21's name for it): any value at all means a script filled it. */
export function honeypotFilled(body: Readonly<Record<string, unknown>>): boolean {
  const value = body['website'];
  if (value === undefined || value === null) return false;
  return typeof value !== 'string' || value.trim() !== '';
}

function text(
  raw: unknown,
  field: string,
  max: number,
  required: boolean,
  details: Detail[],
): string | null {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    if (required) details.push({ field, message: `required, 1–${max} characters` });
    return null;
  }
  if (typeof raw !== 'string') {
    details.push({ field, message: 'must be text' });
    return null;
  }
  const value = raw.replace(/\r\n?/gu, '\n').trim();
  if (value.length > max) details.push({ field, message: `at most ${max} characters` });
  else if (MARKUP.test(value)) details.push({ field, message: 'plain text only, no HTML' });
  else if (CONTROL.test(value)) details.push({ field, message: 'contains control characters' });
  else return value;
  return null;
}

/** Validate a public report body. Throws the 400 with every problem; returns the clean input. */
export function parseSecurityReport(body: Readonly<Record<string, unknown>>): SecurityReportInput {
  const details: Detail[] = [];
  const title = text(body['title'], 'title', MAX_TITLE, true, details);
  const reportBody = text(body['body'], 'body', MAX_BODY, true, details);
  const reporterName = text(body['name'], 'name', MAX_NAME, false, details);
  const email = text(body['email'], 'email', MAX_EMAIL, false, details);
  if (email !== null && !EMAIL_SHAPE.test(email)) {
    details.push({ field: 'email', message: 'must be an e-mail address' });
  }
  const rawSeverity = body['severity'] ?? 'none';
  if (!(CLAIMED_SEVERITIES as readonly unknown[]).includes(rawSeverity)) {
    details.push({ field: 'severity', message: `one of ${CLAIMED_SEVERITIES.join(', ')}` });
  }
  if (details.length > 0 || title === null || reportBody === null) {
    throw new ApiError(400, 'validation_failed', 'The report could not be accepted.', details);
  }
  const locale = body['pageLocale'];
  return {
    title,
    body: reportBody,
    severityClaimed: rawSeverity as ClaimedSeverity,
    reporterName,
    reporterEmail: email === null ? null : email.toLowerCase(),
    language: locale === 'ar' || locale === 'en' ? locale : null,
  };
}

/** Validate a platform `PUT`: status, credit name, credit visibility. At least one field. */
export function parseSecurityReportUpdate(
  body: Readonly<Record<string, unknown>>,
): SecurityReportUpdate {
  const details: Detail[] = [];
  const update: { -readonly [K in keyof SecurityReportUpdate]: SecurityReportUpdate[K] } = {};
  if (body['status'] !== undefined) {
    if ((SECURITY_REPORT_STATUSES as readonly unknown[]).includes(body['status'])) {
      update.status = body['status'] as SecurityReportStatus;
    } else {
      details.push({ field: 'status', message: `one of ${SECURITY_REPORT_STATUSES.join(', ')}` });
    }
  }
  if (body['creditName'] !== undefined) {
    update.creditName = text(body['creditName'], 'creditName', MAX_NAME, false, details);
  }
  if (body['creditPublic'] !== undefined) {
    if (typeof body['creditPublic'] === 'boolean') update.creditPublic = body['creditPublic'];
    else details.push({ field: 'creditPublic', message: 'must be true or false' });
  }
  if (details.length === 0 && Object.keys(update).length === 0) {
    details.push({ field: 'status', message: 'nothing to change' });
  }
  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The change is invalid.', details);
  }
  return update;
}

/** A terminal status stamps `resolved_at`; moving back to new/triaged clears it. */
export function isResolved(status: SecurityReportStatus): boolean {
  return status === 'fixed' || status === 'duplicate' || status === 'invalid';
}

/**
 * The acknowledgement. It carries nothing the reporter typed — only the reference — so the door
 * cannot be used to send chosen text to a chosen address.
 */
export function composeAcknowledgement(
  to: string,
  reference: string,
  language: 'en' | 'ar' | null,
): { to: string; subject: string; text: string; templateKey: string; language: 'en' | 'ar' } {
  const locale = language ?? 'en';
  return {
    to,
    language: locale,
    subject: emailT(locale, 'securityAck.subject', { reference }),
    // C2: signed by TManage Support; a reply (keeping the reference) reaches support@.
    text: [emailT(locale, 'securityAck.text', { reference }), signOffText('support', locale)].join(
      '\n\n',
    ),
    templateKey: 'security_report_ack',
  };
}
