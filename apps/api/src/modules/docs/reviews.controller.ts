import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { DOC_REVIEWS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { DocReviewsService } from './reviews.service.js';
import type { DocReviewView } from './reviews.service.js';

/**
 * Docs review workflow (x313). The document-review endpoints: request a review, decide one, and list
 * a document's reviews, all keyed by the document id in the path.
 *
 * Like every tenant-scoped controller here it never reads `organizationId` from the body, a header,
 * or its own `:orgSlug` segment: it receives the `TenantContext` that `TenantContextGuard` built and
 * passes it on. The document (and, on decide, the review) are resolved tenant-scoped **before** the
 * write in the service: a cross-tenant `documentId` is a 404 with nothing written, never a
 * foreign-key 500.
 */

/** Request-a-review body. */
interface RequestReviewBody {
  readonly reviewerUserId?: unknown;
  readonly note?: unknown;
}

/** Decide-a-review body. */
interface DecideReviewBody {
  readonly state?: unknown;
  readonly note?: unknown;
}

const DECISION_STATES = ['approved', 'changes_requested'] as const;
type DecisionState = (typeof DECISION_STATES)[number];

@Controller('v1/organizations/:orgSlug/documents/:documentId/reviews')
export class DocReviewsController {
  constructor(@Inject(DOC_REVIEWS_SERVICE) private readonly reviews: DocReviewsService) {}

  /** List a document's reviews, oldest first, for a caller who may read the document (`doc.read`). */
  @Get()
  @RequireCapability('doc.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly reviews: readonly DocReviewView[] }> {
    requireDocumentId(documentId);

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    return {
      reviews: await this.reviews.list(context, principal, documentId, {
        ...(after ? { after } : {}),
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      }),
    };
  }

  /** Request a review of a document from a reviewer (`doc.write`). */
  @Post()
  @RequireCapability('doc.write')
  @HttpCode(201)
  async request(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
    @Body() body: RequestReviewBody,
  ): Promise<DocReviewView> {
    requireDocumentId(documentId);

    const reviewerUserId =
      typeof body?.reviewerUserId === 'string' ? body.reviewerUserId.trim() : undefined;
    if (reviewerUserId === undefined || reviewerUserId === '') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'reviewerUserId', message: 'must be a non-empty string' },
      ]);
    }

    const note = normaliseNote(body?.note);

    return this.reviews.request(context, principal, documentId, { reviewerUserId, note });
  }

  /** Decide a review — approve or request changes (`doc.write`). */
  @Put(':reviewId')
  @RequireCapability('doc.write')
  async decide(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('documentId') documentId: string,
    @Param('reviewId') reviewId: string,
    @Body() body: DecideReviewBody,
  ): Promise<DocReviewView> {
    requireDocumentId(documentId);
    if (typeof reviewId !== 'string' || reviewId === '') {
      throw new ApiError(400, 'validation_failed', 'reviewId is required', [
        { field: 'reviewId', message: 'must be a non-empty string' },
      ]);
    }

    const state = body?.state;
    if (!isDecisionState(state)) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'state', message: `must be one of ${DECISION_STATES.join(', ')}` },
      ]);
    }

    const note = normaliseNote(body?.note);
    // A changes-requested decision must say why; an approval may stand on its own.
    if (state === 'changes_requested' && (note === null || note === '')) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'note', message: 'must be a non-empty string when requesting changes' },
      ]);
    }

    return this.reviews.decide(context, principal, documentId, reviewId, { state, note });
  }
}

/** Trim a note to a non-empty string, or null; reject one that is too long. */
function normaliseNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'note', message: 'must be a string' },
    ]);
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > DocReviewsService.maxNoteLength) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'note', message: `must be ${DocReviewsService.maxNoteLength} characters or fewer` },
    ]);
  }
  return trimmed;
}

function isDecisionState(value: unknown): value is DecisionState {
  return typeof value === 'string' && (DECISION_STATES as readonly string[]).includes(value);
}

/** A path `documentId` is always required and always a non-empty string. */
function requireDocumentId(documentId: unknown): asserts documentId is string {
  if (typeof documentId !== 'string' || documentId === '') {
    throw new ApiError(400, 'validation_failed', 'documentId is required', [
      { field: 'documentId', message: 'must be a non-empty string' },
    ]);
  }
}
