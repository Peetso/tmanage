import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PersonTimeOffRow } from '../../common/database/schema.js';
import type { PersonTimeOffRepository, TimeOffRange } from './time-off.repository.js';

/**
 * Person time-off orchestration (People module 14, x325). The service owns the security ordering the
 * brief fixes — **resolve the target person by `(tenant, :userId)` BEFORE authorize** — plus the
 * semantic validation, so the controller is a thin projection over it. It is deliberately free of
 * HTTP framework types: it takes the `TenantContext`, the ids, and a `guard` closure the controller
 * builds from the real `authorize()`, and it throws the shared {@link ApiError} the HTTP layer maps.
 *
 * The one rule every method obeys: inside a single unit of work it resolves the person tenant-scoped
 * first (a cross-tenant or unknown user id is a 404, indistinguishable from the id never existing),
 * then runs `guard()` (a 403 if the caller lacks the capability), and only then reads or writes. A
 * cross-tenant probe can therefore never tell "not a member here" from "not allowed", and no row is
 * ever read or written for a person outside the acting tenant.
 */

/** The fixed vocabulary a time-off entry's `kind` may take — an unknown value is a 400 with no write. */
export const TIME_OFF_KINDS = ['vacation', 'sick', 'other'] as const;
export type TimeOffKind = (typeof TIME_OFF_KINDS)[number];

const MAX_NOTE_LENGTH = 500;
// `YYYY-MM-DD`, the shape the DATE columns store.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A guard the controller supplies; it throws the route's 403 when the capability is denied. */
export type TimeOffGuard = () => void;

/** The raw create body — every field arrives as `unknown` and is validated here. */
export interface PersonTimeOffBody {
  readonly startsOn?: unknown;
  readonly endsOn?: unknown;
  readonly kind?: unknown;
  readonly note?: unknown;
}

function notFound(): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'person_not_visible');
}

export class PersonTimeOffService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: PersonTimeOffRepository,
  ) {}

  /**
   * List a person's entries, optionally within an inclusive `[from, to]` overlap window. Resolve the
   * person (404) before `guard()` (403), then read. A person with no entries reads an empty list.
   */
  async list(
    context: TenantContext,
    personUserId: string,
    range: TimeOffRange | null,
    guard: TimeOffGuard,
  ): Promise<PersonTimeOffRow[]> {
    const rows = await this.database.read(context, async (runner) => {
      const person = await this.repository.resolvePersonMembership(runner, context, personUserId);
      if (person === null) return null;
      guard();
      return this.repository.listForPerson(runner, context, personUserId, range);
    });
    if (rows === null) throw notFound();
    return rows;
  }

  /**
   * File one entry against a person. Resolve the person (404) before `guard()` (403), then validate
   * the body (400) — a malformed field writes nothing — then insert. `startsOn`/`endsOn` are compared
   * as bound `Date` values, never the database clock (the admin-pool-clock trap).
   */
  async create(
    context: TenantContext,
    personUserId: string,
    createdByUserId: string,
    body: PersonTimeOffBody,
    guard: TimeOffGuard,
  ): Promise<PersonTimeOffRow> {
    const row = await this.database.transaction(context, async (tx) => {
      const person = await this.repository.resolvePersonMembership(tx, context, personUserId);
      if (person === null) return null;
      guard();
      const input = parseBody(body);
      return this.repository.create(tx, context, {
        personUserId,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        kind: input.kind,
        note: input.note,
        createdByUserId,
      });
    });
    if (row === null) throw notFound();
    return row;
  }

  /**
   * Remove one entry. Resolve the person (404) before `guard()` (403), then delete scoped to the
   * person. DELETE is idempotent: once the person resolves and the caller is allowed, a missing or
   * already-removed entry is still a success — the controller returns 204 either way.
   */
  async remove(
    context: TenantContext,
    personUserId: string,
    entryId: string,
    guard: TimeOffGuard,
  ): Promise<void> {
    const resolved = await this.database.transaction(context, async (tx) => {
      const person = await this.repository.resolvePersonMembership(tx, context, personUserId);
      if (person === null) return false;
      guard();
      // Idempotent: whether or not a row matched, the post-condition (no such entry for this person)
      // holds, so the outcome is the same 204.
      await this.repository.deleteForPerson(tx, context, personUserId, entryId);
      return true;
    });
    if (!resolved) throw notFound();
  }
}

/** Validate and normalise a create body into the three stored fields. Any failure is a 400, no write. */
function parseBody(body: PersonTimeOffBody): {
  readonly startsOn: string;
  readonly endsOn: string;
  readonly kind: string;
  readonly note: string | null;
} {
  const details: { field: string; message: string }[] = [];

  const startsOn = validDate(body?.startsOn, 'startsOn', details);
  const endsOn = validDate(body?.endsOn, 'endsOn', details);

  const kind = body?.kind;
  if (typeof kind !== 'string' || !(TIME_OFF_KINDS as readonly string[]).includes(kind)) {
    details.push({ field: 'kind', message: `must be one of ${TIME_OFF_KINDS.join(', ')}` });
  }

  let note: string | null = null;
  if (body?.note !== undefined && body?.note !== null) {
    if (typeof body.note !== 'string') {
      details.push({ field: 'note', message: 'must be a string' });
    } else if (body.note.length > MAX_NOTE_LENGTH) {
      details.push({ field: 'note', message: `must be at most ${MAX_NOTE_LENGTH} characters` });
    } else {
      const trimmed = body.note.trim();
      note = trimmed === '' ? null : trimmed;
    }
  }

  // Compare with bound Date values, never the admin-pool clock: starts must not be after ends.
  if (startsOn !== undefined && endsOn !== undefined && Date.parse(startsOn) > Date.parse(endsOn)) {
    details.push({ field: 'endsOn', message: 'must be on or after startsOn' });
  }

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The time-off entry is invalid', details);
  }

  return { startsOn: startsOn as string, endsOn: endsOn as string, kind: kind as string, note };
}

function validDate(
  value: unknown,
  field: string,
  details: { field: string; message: string }[],
): string | undefined {
  if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
    details.push({ field, message: 'must be an ISO-8601 date (YYYY-MM-DD)' });
    return undefined;
  }
  return value;
}
