import { createHash } from 'node:crypto';
import { ApiError } from '../../common/http/errors.js';

/**
 * LANE-Q — the outreach import, as pure functions (IP-2: parse once, at the edge).
 *
 * The source is the researched decision-makers list (`decision-makers.csv`: company, country,
 * segment, person_name, title, work_email, source_url, checked_at_utc, notes; optional
 * `contact_type` and `language`). Only rows that may be written to survive; every other row is
 * counted under its reason and never stored, so the database holds no address we will not use.
 *
 * Who is left out, and why (owner decisions 2026-11-20, recorded in LANE-Q-REPORT.md):
 * - Germany, Denmark and Norway: cold e-mail to a named person there needs prior consent (DE
 *   UWG §7(2) no. 2, DK Marketing Practices Act §10, NO Marketing Control Act §15).
 * - The United States while `CAMPAIGN_POSTAL_ADDRESS` is empty: CAN-SPAM (15 U.S.C. §7704(a)(5))
 *   requires a valid physical postal address in every commercial e-mail.
 * - A country we cannot place in a time zone (we only send in the recipient's working hours).
 * - A row without a person's name (the greeting is the first name; there is no "Hi there"), or
 *   without a well-formed address.
 * - A row whose notes flag it: bad fit, do-not-contact, "confirm before sending", "re-check".
 * - A `contact_type` other than `general` or `named`, when the column is present.
 * - The same address twice (in the file, or already imported in any campaign).
 * - A second person at the same company: one person per company, the first usable row wins.
 *
 * Language: `ar` only when the row says so in a `language` column; otherwise English (owner
 * decision 2026-11-20: everyone in the current file gets the English text). Senders: Arabic mail
 * from the ten Arabic-named teammates, English mail from the others, spread evenly in file order.
 */

export const MAX_OUTREACH_ROWS = 2000;
export const MAX_OUTREACH_CSV_BYTES = 2_000_000;

/** ISO code and the time zone the send window is measured in (one zone per country, v1). */
const COUNTRIES: Readonly<Record<string, { readonly code: string; readonly zone: string }>> = {
  'united kingdom': { code: 'GB', zone: 'Europe/London' },
  uk: { code: 'GB', zone: 'Europe/London' },
  'great britain': { code: 'GB', zone: 'Europe/London' },
  england: { code: 'GB', zone: 'Europe/London' },
  scotland: { code: 'GB', zone: 'Europe/London' },
  wales: { code: 'GB', zone: 'Europe/London' },
  ireland: { code: 'IE', zone: 'Europe/Dublin' },
  'united states': { code: 'US', zone: 'America/Chicago' },
  usa: { code: 'US', zone: 'America/Chicago' },
  us: { code: 'US', zone: 'America/Chicago' },
  canada: { code: 'CA', zone: 'America/Toronto' },
  australia: { code: 'AU', zone: 'Australia/Sydney' },
  'new zealand': { code: 'NZ', zone: 'Pacific/Auckland' },
  finland: { code: 'FI', zone: 'Europe/Helsinki' },
  sweden: { code: 'SE', zone: 'Europe/Stockholm' },
  norway: { code: 'NO', zone: 'Europe/Oslo' },
  denmark: { code: 'DK', zone: 'Europe/Copenhagen' },
  germany: { code: 'DE', zone: 'Europe/Berlin' },
  netherlands: { code: 'NL', zone: 'Europe/Amsterdam' },
  belgium: { code: 'BE', zone: 'Europe/Brussels' },
  france: { code: 'FR', zone: 'Europe/Paris' },
  spain: { code: 'ES', zone: 'Europe/Madrid' },
  portugal: { code: 'PT', zone: 'Europe/Lisbon' },
  italy: { code: 'IT', zone: 'Europe/Rome' },
  switzerland: { code: 'CH', zone: 'Europe/Zurich' },
  austria: { code: 'AT', zone: 'Europe/Vienna' },
  poland: { code: 'PL', zone: 'Europe/Warsaw' },
  estonia: { code: 'EE', zone: 'Europe/Tallinn' },
  latvia: { code: 'LV', zone: 'Europe/Riga' },
  lithuania: { code: 'LT', zone: 'Europe/Vilnius' },
  croatia: { code: 'HR', zone: 'Europe/Zagreb' },
  'czech republic': { code: 'CZ', zone: 'Europe/Prague' },
  czechia: { code: 'CZ', zone: 'Europe/Prague' },
  egypt: { code: 'EG', zone: 'Africa/Cairo' },
  uae: { code: 'AE', zone: 'Asia/Dubai' },
  'united arab emirates': { code: 'AE', zone: 'Asia/Dubai' },
  'saudi arabia': { code: 'SA', zone: 'Asia/Riyadh' },
  ksa: { code: 'SA', zone: 'Asia/Riyadh' },
  qatar: { code: 'QA', zone: 'Asia/Qatar' },
  kuwait: { code: 'KW', zone: 'Asia/Kuwait' },
  bahrain: { code: 'BH', zone: 'Asia/Bahrain' },
  oman: { code: 'OM', zone: 'Asia/Muscat' },
  jordan: { code: 'JO', zone: 'Asia/Amman' },
};

/** Prior consent is required for cold e-mail to a named person here (see the header). */
export const CONSENT_COUNTRIES: ReadonlySet<string> = new Set(['DE', 'DK', 'NO']);

/** The ten Arabic-named teammates (owner-approved list); everyone else writes in English. */
export const ARABIC_SENDER_LOCALS: ReadonlySet<string> = new Set([
  'mariam',
  'nour',
  'layla',
  'salma',
  'sana',
  'omar',
  'karim',
  'tarek',
  'youssef',
  'ziad',
]);

const FLAG_MARKERS =
  /\b(bad[\s-]?fit|do[\s-]?not[\s-]?contact|confirm before sending|re-?check(ed)? before)\b/iu;
const EMAIL_SHAPE = /^[^\s@,;<>"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/u;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/u;
const REQUIRED_COLUMNS = ['company', 'country', 'person_name', 'work_email'] as const;

export type OutreachExclusion =
  | 'consent_country'
  | 'us_without_postal_address'
  | 'unknown_country'
  | 'no_name'
  | 'bad_email'
  | 'flagged'
  | 'contact_type'
  | 'duplicate_address'
  | 'second_at_company';

export interface OutreachSender {
  readonly id: string;
  readonly address: string;
}

export interface PlannedRecipient {
  readonly company: string;
  readonly personName: string;
  readonly firstName: string;
  readonly email: string;
  readonly emailHash: string;
  readonly country: string;
  readonly timeZone: string;
  readonly language: 'en' | 'ar';
  readonly senderPersonId: string;
}

export interface OutreachPlan {
  readonly recipients: readonly PlannedRecipient[];
  readonly excluded: Readonly<Partial<Record<OutreachExclusion, number>>>;
  readonly rows: number;
}

export interface OutreachPlanOptions {
  /** Active people from `platform_mail_people`. */
  readonly senders: readonly OutreachSender[];
  /** Whether `CAMPAIGN_POSTAL_ADDRESS` is set (US recipients need it). */
  readonly postalAddressSet: boolean;
  /** Address hashes already imported (any campaign). */
  readonly knownHashes: ReadonlySet<string>;
  /** Normalised company names already imported (any campaign). */
  readonly knownCompanies: ReadonlySet<string>;
}

const invalid = (message: string): ApiError =>
  new ApiError(400, 'validation_failed', message, [{ field: 'csv', message }]);

/** The unsubscribe list's key for an address (same as `@tmanage/mail` `emailAddressHash`). */
export function outreachAddressHash(address: string): string {
  return createHash('sha256').update(address.trim().toLowerCase(), 'utf8').digest('base64url');
}

export function normaliseCompany(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
}

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (quoted) throw invalid('The file ends inside a quoted field.');
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  return rows;
}

/** The file's rows as objects keyed by the (lower-cased) header. Throws 400 on a bad file. */
export function readDecisionMakersCsv(raw: unknown): Record<string, string>[] {
  if (typeof raw !== 'string' || raw.trim() === '') throw invalid('Upload the CSV file.');
  if (Buffer.byteLength(raw, 'utf8') > MAX_OUTREACH_CSV_BYTES) {
    throw invalid('The file is larger than 2 MB.');
  }
  const [header, ...rows] = parseCsv(raw);
  const columns = (header ?? []).map((cell) => cell.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((column) => !columns.includes(column));
  if (missing.length > 0) throw invalid(`The file has no ${missing.join(', ')} column.`);
  if (rows.length === 0 || rows.length > MAX_OUTREACH_ROWS) {
    throw invalid(`Import 1 to ${String(MAX_OUTREACH_ROWS)} rows at a time.`);
  }
  return rows.map((cells) => {
    const record: Record<string, string> = {};
    columns.forEach((column, index) => {
      record[column] = (cells[index] ?? '').trim();
    });
    return record;
  });
}

function firstNameOf(name: string): string {
  return (name.split(/\s+/u)[0] ?? '').slice(0, 60);
}

/** Which rows become recipients, who sends to each, and how many were left out and why. */
export function planOutreachImport(
  rows: readonly Readonly<Record<string, string>>[],
  options: OutreachPlanOptions,
): OutreachPlan {
  const excluded: Partial<Record<OutreachExclusion, number>> = {};
  const skip = (reason: OutreachExclusion) => {
    excluded[reason] = (excluded[reason] ?? 0) + 1;
  };
  const pools = {
    ar: options.senders.filter((s) => ARABIC_SENDER_LOCALS.has(localPart(s.address))),
    en: options.senders.filter((s) => !ARABIC_SENDER_LOCALS.has(localPart(s.address))),
  };
  const turn = { ar: 0, en: 0 };
  const hashes = new Set(options.knownHashes);
  const companies = new Set(options.knownCompanies);
  const recipients: PlannedRecipient[] = [];

  for (const row of rows) {
    const place = COUNTRIES[(row['country'] ?? '').trim().toLowerCase()];
    if (place === undefined) {
      skip('unknown_country');
      continue;
    }
    if (CONSENT_COUNTRIES.has(place.code)) {
      skip('consent_country');
      continue;
    }
    if (place.code === 'US' && !options.postalAddressSet) {
      skip('us_without_postal_address');
      continue;
    }
    const personName = (row['person_name'] ?? '').replace(/\s+/gu, ' ').trim();
    const company = (row['company'] ?? '').replace(/\s+/gu, ' ').trim();
    if (
      personName === '' ||
      personName.length > 120 ||
      CONTROL.test(personName) ||
      company === '' ||
      company.length > 160 ||
      CONTROL.test(company)
    ) {
      skip('no_name');
      continue;
    }
    const email = (row['work_email'] ?? '').trim().toLowerCase();
    if (!EMAIL_SHAPE.test(email) || email.length > 254) {
      skip('bad_email');
      continue;
    }
    if (FLAG_MARKERS.test(row['notes'] ?? '') || FLAG_MARKERS.test(row['segment'] ?? '')) {
      skip('flagged');
      continue;
    }
    const contactType = row['contact_type'];
    if (contactType !== undefined && !['general', 'named'].includes(contactType.toLowerCase())) {
      skip('contact_type');
      continue;
    }
    const emailHash = outreachAddressHash(email);
    if (hashes.has(emailHash)) {
      skip('duplicate_address');
      continue;
    }
    const companyKey = normaliseCompany(company);
    if (companies.has(companyKey)) {
      skip('second_at_company');
      continue;
    }
    const language: 'en' | 'ar' = (row['language'] ?? '').toLowerCase() === 'ar' ? 'ar' : 'en';
    const pool = pools[language];
    const sender = pool[turn[language] % Math.max(pool.length, 1)];
    if (sender === undefined) {
      throw new ApiError(
        409,
        'conflict',
        `No active ${language === 'ar' ? 'Arabic' : 'English'} sender in E-mail people.`,
      );
    }
    turn[language] += 1;
    hashes.add(emailHash);
    companies.add(companyKey);
    recipients.push({
      company,
      personName,
      firstName: firstNameOf(personName),
      email,
      emailHash,
      country: place.code,
      timeZone: place.zone,
      language,
      senderPersonId: sender.id,
    });
  }
  return { recipients, excluded, rows: rows.length };
}

function localPart(address: string): string {
  return (address.split('@')[0] ?? '').toLowerCase();
}
