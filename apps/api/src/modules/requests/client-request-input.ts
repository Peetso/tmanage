import { ApiError } from '../../common/http/errors.js';
import type { Commitment, SubmitClientRequestInput } from './client-requests.repository.js';

/**
 * Body parsing shared by REQ-001's two surfaces.
 *
 * The aggregate has one shape and two doors: the studio's `/client-requests` and the client's
 * `/portal/requests`. Parsing lives here rather than in either controller so the two cannot
 * drift into accepting different things — a title that is 300 characters on one path and 500 on
 * the other would be a validation rule with two answers, and the column has one.
 */

/** `client_requests.title` is `VARCHAR(300)`. */
export const MAX_TITLE_LENGTH = 300;
/** `client_requests.category` is `VARCHAR(64)`. */
export const MAX_CATEGORY_LENGTH = 64;
/** `client_requests.description` is `TEXT`; this is a form field, not a document. */
export const MAX_DESCRIPTION_LENGTH = 8_000;
/** `client_requests.urgency_reason` is `VARCHAR(500)`. */
export const MAX_URGENCY_LENGTH = 500;
/** `client_requests.clarification_question` is `TEXT`. */
export const MAX_CLARIFICATION_LENGTH = 2_000;
/** `client_requests.client_visible_reason` is `VARCHAR(1000)`. */
export const MAX_REASON_LENGTH = 1_000;
/** `client_requests.client_safe_scope_summary` is `TEXT`. */
export const MAX_SCOPE_SUMMARY_LENGTH = 4_000;

/**
 * A category is a slug, and that is a decision this file is making rather than transcribing.
 *
 * `22-SCREEN-BY-SCREEN` §6 CL-06 lists "category" as a field and **no document in the planning
 * pack enumerates the categories**. Two things follow. A closed set invented here would be a
 * vocabulary no screen ever agreed to, so the column is free text. But free text that reaches
 * the audit trail is not free: `client_request.submitted` records the category as a
 * classification, and `isSafeAuditMetadata` admits `[A-Za-z0-9._:-]` only — a category with a
 * space in it would make every submission a 500 at the write boundary.
 *
 * So the shape is constrained and the vocabulary is not — and REQ-05 moves the constraint off
 * the client. The field used to refuse anything that was not already a slug, so a client who
 * typed "New page" or "Bug report" into a free-text box got a 400 that read as the product
 * being broken. Now the client may type whatever they like and {@link slugifyCategory} folds it
 * to the audit-safe shape: "New page" becomes `new-page`, "Bug report!" becomes `bug-report`. A
 * picker emitting `bug_report` or `new-page` still round-trips unchanged. Text that slugifies to
 * nothing (only punctuation) is treated as no category rather than refused, because an empty
 * classification is the honest reading of a field the client did not really fill in.
 */

/**
 * Fold a client's free-text category to the audit-safe slug `client_request.submitted` records.
 *
 * Lowercased, every run of non-alphanumeric characters collapsed to a single hyphen, and the
 * leading and trailing hyphens trimmed — so the result matches `isSafeAuditMetadata`'s
 * `[A-Za-z0-9._:-]` and can never carry the space that would 500 the audit write. Capped at
 * {@link MAX_CATEGORY_LENGTH} to fit `VARCHAR(64)`, with any hyphen the cut left dangling
 * removed. Returns `undefined` when nothing survives, which the caller stores as no category.
 */
export function slugifyCategory(raw: string): string | undefined {
  const slug = raw
    .toLowerCase()
    // Underscores are kept — a picker emitting `bug_report` round-trips unchanged — and every
    // other run of non-alphanumerics folds to a single hyphen.
    .replace(/[^a-z0-9_]+/gu, '-')
    .replace(/^[-_]+|[-_]+$/gu, '')
    .slice(0, MAX_CATEGORY_LENGTH)
    .replace(/[-_]+$/gu, '');
  return slug === '' ? undefined : slug;
}

export interface ValidationDetail {
  field: string;
  message: string;
}

/**
 * The concurrency token, required rather than optional.
 *
 * Accepts a number or a numeric string, because `version` is `BIGINT UNSIGNED` and a caller who
 * read it out of JSON may have kept it as either. Refused outright when absent, so a caller
 * cannot opt out of optimistic concurrency by leaving it off.
 */
export function requiredVersion(raw: unknown, details: ValidationDetail[]): number | undefined {
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    details.push({ field: 'version', message: 'must be the version you read' });
    return undefined;
  }
  return value;
}

/**
 * Validate a bare `YYYY-MM-DD` calendar date, or add a field error and return `undefined`.
 *
 * Both request dates are calendar dates in `DATE` columns since 0012, carried as strings end
 * to end. This used to accept ISO instants and store midnight UTC in a `DATETIME(3)`, which
 * read back a day early for anyone west of UTC — the defect the migration removed.
 */
function parseCalendarDay(
  raw: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    details.push({ field, message: 'must be a calendar date in YYYY-MM-DD form' });
    return undefined;
  }
  // `2026-02-31` parses in some engines by rolling into March. Round-tripping catches it.
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    details.push({ field, message: 'is not a real date' });
    return undefined;
  }
  return raw;
}

/**
 * `23-ERD` §6's "committed date or explicit unscheduled state", parsed from one field.
 *
 * One field rather than two, because it is one choice. Two nullable inputs would admit a third
 * answer — neither — which is the ambiguity §6 exists to remove and which the trigger in
 * `0006_client_requests.sql` refuses at the engine.
 */
export function parseCommitment(raw: unknown, details: ValidationDetail[]): Commitment | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'unscheduled') return { kind: 'unscheduled' };

  const day = parseCalendarDay(raw, 'commitment', details);
  if (day === undefined) {
    // Rewrite the generic shape error so the one-field-two-answers contract stays stated.
    const last = details[details.length - 1];
    if (last?.field === 'commitment' && last.message.startsWith('must be')) {
      details[details.length - 1] = {
        field: 'commitment',
        message: "must be 'unscheduled' or a calendar date in YYYY-MM-DD form",
      };
    }
    return undefined;
  }
  return { kind: 'committed', day };
}

interface SubmitBody {
  readonly projectId?: unknown;
  readonly title?: unknown;
  readonly category?: unknown;
  readonly description?: unknown;
  readonly urgencyReason?: unknown;
  readonly desiredAt?: unknown;
}

/**
 * CL-06's form, validated: "Title, category, description, urgency reason, desired date, files."
 *
 * **Files are absent, and named as absent.** `FILE-001` has not shipped, there is no
 * `file_assets` table and nothing scans an upload — and US-B01's acceptance criterion is "valid
 * files scanned", which cannot be satisfied by accepting an attachment and hoping. A field that
 * took ids of files nothing had checked would be worse than the gap.
 *
 * Throws rather than returning an error list, because both callers do the same thing with it.
 */
export function parseSubmitBody(
  body: SubmitBody,
): Omit<SubmitClientRequestInput, 'clientOrganizationId' | 'submittedByUserId'> {
  const details: ValidationDetail[] = [];

  const projectId = typeof body?.projectId === 'string' ? body.projectId : undefined;
  if (!projectId) details.push({ field: 'projectId', message: 'must be a string' });

  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  if (title === '') details.push({ field: 'title', message: 'must be a non-empty string' });
  if (title.length > MAX_TITLE_LENGTH) {
    details.push({ field: 'title', message: `must be ${MAX_TITLE_LENGTH} characters or fewer` });
  }

  const description = typeof body?.description === 'string' ? body.description.trim() : '';
  if (description === '') {
    details.push({ field: 'description', message: 'must be a non-empty string' });
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    details.push({
      field: 'description',
      message: `must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`,
    });
  }

  // REQ-05: the client types whatever reads naturally and the slug is derived here. A
  // non-string value is the only thing left to refuse — there is no text to fold — and a string
  // that is all punctuation folds to nothing, which is stored as no category rather than a 400.
  let category: string | undefined;
  if (body?.category !== undefined && body.category !== null) {
    if (typeof body.category !== 'string') {
      details.push({ field: 'category', message: 'must be text' });
    } else {
      category = slugifyCategory(body.category);
    }
  }

  let urgencyReason: string | undefined;
  if (body?.urgencyReason !== undefined && body.urgencyReason !== null) {
    const raw = typeof body.urgencyReason === 'string' ? body.urgencyReason.trim() : '';
    if (raw === '' || raw.length > MAX_URGENCY_LENGTH) {
      details.push({
        field: 'urgencyReason',
        message: `must be a non-empty string of ${MAX_URGENCY_LENGTH} characters or fewer`,
      });
    } else {
      urgencyReason = raw;
    }
  }

  // The date the client wants, as a calendar date. An earlier revision accepted a full
  // instant here, arguing "by Friday close of business" is a real thing to ask for — but the
  // only writer is a date field, every value ever sent was midnight UTC, and storing that
  // instant in a DATETIME read back a day early west of UTC. A time of day someone actually
  // states belongs in the description until a screen exists to ask for one.
  let desiredAt: string | undefined;
  if (body?.desiredAt !== undefined && body.desiredAt !== null) {
    desiredAt = parseCalendarDay(body.desiredAt, 'desiredAt', details);
  }

  if (details.length > 0 || !projectId) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }

  return {
    projectId,
    title,
    description,
    ...(category === undefined ? {} : { category }),
    ...(urgencyReason === undefined ? {} : { urgencyReason }),
    ...(desiredAt === undefined ? {} : { desiredAt }),
  };
}
