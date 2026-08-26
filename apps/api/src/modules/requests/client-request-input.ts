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
 * So the shape is constrained and the vocabulary is not. A picker emitting `bug_report` or
 * `new-page` works; a client typing a sentence into the field is refused with a 400 that says
 * what a category looks like. The missing enumeration is recorded in
 * `docs/implementation-status.md` as a gap rather than filled in by guesswork.
 */
const CATEGORY_PATTERN = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/;

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
 * `23-ERD` §6's "committed date or explicit unscheduled state", parsed from one field.
 *
 * One field rather than two, because it is one choice. Two nullable inputs would admit a third
 * answer — neither — which is the ambiguity §6 exists to remove and which the trigger in
 * `0006_client_requests.sql` refuses at the engine.
 */
export function parseCommitment(raw: unknown, details: ValidationDetail[]): Commitment | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'unscheduled') return { kind: 'unscheduled' };

  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    details.push({
      field: 'commitment',
      message: "must be 'unscheduled' or an ISO 8601 instant, such as 2026-09-30T17:00:00Z",
    });
    return undefined;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field: 'commitment', message: 'is not a real instant' });
    return undefined;
  }
  return { kind: 'committed', at: parsed };
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

  let category: string | undefined;
  if (body?.category !== undefined) {
    const raw = typeof body.category === 'string' ? body.category.trim().toLowerCase() : '';
    if (raw.length > MAX_CATEGORY_LENGTH || !CATEGORY_PATTERN.test(raw)) {
      details.push({
        field: 'category',
        message: 'must be a short lowercase label such as new-page or bug_report',
      });
    } else {
      category = raw;
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

  // The date the client wants, and the reason this parser accepts a full instant rather than a
  // calendar date: a request "by Friday close of business" is a real thing to ask for, and
  // guessing a time of day for a bare date is how a request becomes a deadline nobody stated.
  let desiredAt: Date | undefined;
  if (body?.desiredAt !== undefined && body.desiredAt !== null) {
    if (typeof body.desiredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(body.desiredAt)) {
      details.push({
        field: 'desiredAt',
        message: 'must be an ISO 8601 instant, such as 2026-09-30T17:00:00Z',
      });
    } else {
      const parsed = new Date(body.desiredAt);
      if (Number.isNaN(parsed.getTime())) {
        details.push({ field: 'desiredAt', message: 'is not a real instant' });
      } else {
        desiredAt = parsed;
      }
    }
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
