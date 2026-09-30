import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PersonCertificationRow } from '../../common/database/schema.js';
import type { PersonCertificationsRepository } from './certifications.repository.js';

/**
 * Person certifications (module 14, x326) — the domain logic behind the controller's HTTP surface.
 *
 * The controller owns the two authorization concerns (resolve the person tenant-scoped, then the
 * org-scoped `authorize`); this service owns everything else: validating a submitted credential,
 * writing and removing it tenant-scoped, and — the one read-side computation — marking a listed
 * credential *expired* when its `expires_on` is before today. Expiry is never stored: the same row
 * reads expired the day after it lapses, computed here against the process clock, so there is no
 * scheduled job and no drift between the stored date and the badge the screen shows.
 */

/** The longest a credential name or issuer may be, matching the `VARCHAR(200)` columns. */
const MAX_TEXT = 200;
/** Calendar dates travel as `'YYYY-MM-DD'` strings (07-DATA-MODEL §Dates). */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What a caller is allowed to see of one certification. `organizationId` is deliberately absent — the
 * wire projection never echoes the tenant id. `expired` is computed read-side, not stored. Paired
 * Exact with the web `PersonCertificationSummary` in the contracts gate.
 */
export interface PersonCertificationView {
  readonly id: string;
  readonly personUserId: string;
  readonly name: string;
  readonly issuer: string;
  /** The day it was issued, `'YYYY-MM-DD'`. */
  readonly issuedOn: string;
  /** The day it expires, `'YYYY-MM-DD'`, or null when the credential does not expire. */
  readonly expiresOn: string | null;
  /** True when `expiresOn` is a day before today (process clock). Never true when `expiresOn` is null. */
  readonly expired: boolean;
  /** The member who recorded it. */
  readonly createdBy: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

/** The validated shape of a create request, once the body has been checked. */
export interface ValidatedCertification {
  readonly name: string;
  readonly issuer: string;
  readonly issuedOn: string;
  readonly expiresOn: string | null;
}

/** The create body — every field arrives as `unknown` and is validated here. */
export interface CreatePersonCertificationBody {
  readonly name?: unknown;
  readonly issuer?: unknown;
  readonly issuedOn?: unknown;
  readonly expiresOn?: unknown;
}

/** Today as `'YYYY-MM-DD'` in UTC, the process clock. Extracted so the projection is testable. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * An explicit projection, not a serialised row: a column added to `person_certifications` later is
 * invisible to every caller until named here. `expired` is `expires_on < today`, false when unset.
 */
export function toView(row: PersonCertificationRow, today: string): PersonCertificationView {
  return {
    id: row.id,
    personUserId: row.personUserId,
    name: row.name,
    issuer: row.issuer,
    issuedOn: row.issuedOn,
    expiresOn: row.expiresOn,
    expired: row.expiresOn !== null && row.expiresOn < today,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PersonCertificationsService {
  constructor(private readonly repository: PersonCertificationsRepository) {}

  /** List a person's certifications, newest issue first, each marked expired read-side. */
  async list(
    database: TenantDatabase,
    context: TenantContext,
    personUserId: string,
  ): Promise<readonly PersonCertificationView[]> {
    const rows = await database.read(context, (runner) =>
      this.repository.listForPerson(runner, context, personUserId),
    );
    const today = todayIso();
    return rows.map((row) => toView(row, today));
  }

  /**
   * Record a certification for a person. The body is validated here — an empty name or issuer, a
   * missing or malformed date, or an expiry before the issue date is a 400 with no insert. The caller
   * has already resolved the person (404) and authorized (403); this writes and returns the new row.
   */
  async create(
    database: TenantDatabase,
    context: TenantContext,
    personUserId: string,
    createdBy: string,
    body: CreatePersonCertificationBody,
  ): Promise<PersonCertificationView> {
    const validated = validateCreate(body);
    const row = await database.transaction(context, (tx) =>
      this.repository.create(tx, context, {
        personUserId,
        name: validated.name,
        issuer: validated.issuer,
        issuedOn: validated.issuedOn,
        expiresOn: validated.expiresOn,
        createdBy,
      }),
    );
    return toView(row, todayIso());
  }

  /**
   * Remove a person's certification. Idempotent: a delete of an unknown or already-removed id within
   * the resolved person still succeeds (the controller answers 204). A row belonging to another
   * person or tenant is never touched, since the repository predicates on both.
   */
  async delete(
    database: TenantDatabase,
    context: TenantContext,
    personUserId: string,
    certificationId: string,
  ): Promise<void> {
    await database.transaction(context, (tx) =>
      this.repository.deleteById(tx, context, personUserId, certificationId),
    );
  }
}

/**
 * Validate and normalise a create body. A present-and-bad field is a 400 with every problem listed,
 * so a malformed request writes nothing. `expiresOn` is optional (absent/empty/null → no expiry).
 */
export function validateCreate(body: CreatePersonCertificationBody): ValidatedCertification {
  const details: { field: string; message: string }[] = [];

  const text = (raw: unknown, field: string): string => {
    if (typeof raw !== 'string') {
      details.push({ field, message: 'must be a non-empty string' });
      return '';
    }
    const trimmed = raw.trim();
    if (trimmed === '') {
      details.push({ field, message: 'must be a non-empty string' });
      return '';
    }
    if (trimmed.length > MAX_TEXT) {
      details.push({ field, message: `must be at most ${MAX_TEXT} characters` });
      return trimmed.slice(0, MAX_TEXT);
    }
    return trimmed;
  };

  const name = text(body?.name, 'name');
  const issuer = text(body?.issuer, 'issuer');

  const issuedOn = typeof body?.issuedOn === 'string' ? body.issuedOn : '';
  if (!DATE_PATTERN.test(issuedOn)) {
    details.push({ field: 'issuedOn', message: 'must be a date in YYYY-MM-DD form' });
  }

  let expiresOn: string | null = null;
  const rawExpiry = body?.expiresOn;
  if (rawExpiry !== undefined && rawExpiry !== null && rawExpiry !== '') {
    if (typeof rawExpiry !== 'string' || !DATE_PATTERN.test(rawExpiry)) {
      details.push({ field: 'expiresOn', message: 'must be a date in YYYY-MM-DD form, or null' });
    } else {
      expiresOn = rawExpiry;
    }
  }

  // The cross-field rule only makes sense once both dates parsed.
  if (
    details.length === 0 &&
    expiresOn !== null &&
    DATE_PATTERN.test(issuedOn) &&
    expiresOn < issuedOn
  ) {
    details.push({ field: 'expiresOn', message: 'must not be before issuedOn' });
  }

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }

  return { name, issuer, issuedOn, expiresOn };
}
