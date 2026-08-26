import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { CLIENT_REQUEST_STATES } from '@tmanage/domain';
import type { ClientRequestState, Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { CLIENT_REQUESTS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ClientRequestView, ClientRequestsService } from './client-requests.service.js';
import type { TransitionFacts } from './client-requests.repository.js';
import {
  MAX_CLARIFICATION_LENGTH,
  MAX_REASON_LENGTH,
  MAX_SCOPE_SUMMARY_LENGTH,
  parseCommitment,
  requiredVersion,
} from './client-request-input.js';

/**
 * REQ-001's internal surface — the studio's triage queue.
 *
 * `client_request.triage` on every route, which is `12-PERMISSION-MATRIX` §2's "Triage client
 * request" and is in `INTERNAL_ONLY_CAPABILITIES`: a client role that somehow held it would
 * still be refused by `authorize()` rule 5, and a client principal never reaches these paths.
 *
 * **There is no `POST /client-requests`.** Submission is a client act, on `/portal/requests`,
 * and the matrix gives "Submit client request" to no internal role. An internal create endpoint
 * would be a way for the agency to file requests as its own clients, which is the one thing a
 * request log has to be unable to do.
 *
 * Transitions are their own sub-resource, for the reason `WorkItemsController` gives: a
 * transition carries the *facts* §6 requires — a question, a client-safe reason, a scope summary,
 * a commitment, linked work — and those belong in a body of their own rather than mixed into a
 * field edit. There is no field edit here at all: this aggregate has no `PATCH`, because every
 * column beyond the client's own words is written by the move that required it.
 */

interface TransitionBody {
  readonly version?: unknown;
  readonly to?: unknown;
  readonly clarificationQuestion?: unknown;
  readonly clientVisibleReason?: unknown;
  readonly clientSafeScopeSummary?: unknown;
  /** `"unscheduled"` or an ISO 8601 instant — `23-ERD` §6's two alternatives. */
  readonly commitment?: unknown;
  readonly linkedWorkItemId?: unknown;
}

@Controller('v1/organizations/:orgSlug/client-requests')
export class ClientRequestsController {
  constructor(@Inject(CLIENT_REQUESTS_SERVICE) private readonly requests: ClientRequestsService) {}

  @Get()
  @RequireCapability('client_request.triage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('projectId') projectId?: string,
    @Query('clientOrganizationId') clientOrganizationId?: string,
    @Query('state') state?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly clientRequests: readonly ClientRequestView[] }> {
    const details: { field: string; message: string }[] = [];

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1)) {
      details.push({ field: 'limit', message: 'must be a positive integer' });
    }

    // A comma-separated list, matching `WorkItemsController`: "submitted or triage" is the
    // ordinary triage-queue filter and repeating a parameter is not something every client
    // library spells the same way.
    const states = state === undefined ? undefined : state.split(',').map((value) => value.trim());
    if (states) {
      for (const candidate of states) {
        if (!isClientRequestState(candidate)) {
          details.push({ field: 'state', message: `${candidate} is not a client request state` });
        }
      }
    }

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The query is invalid', details);
    }

    return {
      clientRequests: await this.requests.list(context, principal, {
        ...(projectId ? { projectId } : {}),
        ...(clientOrganizationId ? { clientOrganizationId } : {}),
        ...(states ? { states: states as ClientRequestState[] } : {}),
        ...(after ? { after } : {}),
        ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      }),
    };
  }

  @Get(':clientRequestId')
  @RequireCapability('client_request.triage')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientRequestId') clientRequestId: string,
  ): Promise<ClientRequestView> {
    return this.requests.get(context, principal, clientRequestId);
  }

  /**
   * Move a request through §6's lifecycle.
   *
   * The facts are named fields rather than an opaque `facts` object, and this differs from
   * `WorkItemsController` deliberately. A work item's facts are prose the machine only checks
   * for presence; three of these are **columns** with widths, and one of them —
   * `commitment` — is a choice between a date and an explicit absence that has to be parsed
   * before the machine can be asked. Validating them by name is what makes a 400 say which
   * field was wrong instead of the machine's 422 saying only that something was missing.
   *
   * Which moves this caller may make is not decided here: the service asks the domain, and the
   * machine refuses an illegal move from the state the row is actually in.
   */
  @Post(':clientRequestId/transitions')
  @RequireCapability('client_request.triage')
  @HttpCode(200)
  async transition(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientRequestId') clientRequestId: string,
    @Body() body: TransitionBody,
  ): Promise<ClientRequestView> {
    const details: { field: string; message: string }[] = [];
    const version = requiredVersion(body?.version, details);

    const to = typeof body?.to === 'string' ? body.to : undefined;
    if (!to || !isClientRequestState(to)) {
      details.push({ field: 'to', message: 'must be a client request state' });
    }

    const clarificationQuestion = optionalProse(
      body?.clarificationQuestion,
      'clarificationQuestion',
      MAX_CLARIFICATION_LENGTH,
      details,
    );
    const clientVisibleReason = optionalProse(
      body?.clientVisibleReason,
      'clientVisibleReason',
      MAX_REASON_LENGTH,
      details,
    );
    const clientSafeScopeSummary = optionalProse(
      body?.clientSafeScopeSummary,
      'clientSafeScopeSummary',
      MAX_SCOPE_SUMMARY_LENGTH,
      details,
    );
    const commitment = parseCommitment(body?.commitment, details);
    const linkedWorkItemId =
      typeof body?.linkedWorkItemId === 'string' && body.linkedWorkItemId !== ''
        ? body.linkedWorkItemId
        : undefined;
    if (body?.linkedWorkItemId !== undefined && linkedWorkItemId === undefined) {
      details.push({ field: 'linkedWorkItemId', message: 'must be a work item id' });
    }

    if (details.length > 0 || version === undefined || !to || !isClientRequestState(to)) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    const facts: TransitionFacts = {
      ...(clarificationQuestion === undefined ? {} : { clarificationQuestion }),
      ...(clientVisibleReason === undefined ? {} : { clientVisibleReason }),
      ...(clientSafeScopeSummary === undefined ? {} : { clientSafeScopeSummary }),
      ...(commitment === undefined ? {} : { commitment }),
      ...(linkedWorkItemId === undefined ? {} : { linkedWorkItemId }),
    };

    return this.requests.triage(context, principal, clientRequestId, version, to, facts);
  }
}

function isClientRequestState(value: string): value is ClientRequestState {
  return (CLIENT_REQUEST_STATES as readonly string[]).includes(value);
}

/**
 * A sentence a person wrote, bounded by the column that holds it.
 *
 * Trimmed, and an all-whitespace value is refused rather than stored: the state machine treats
 * a blank string as an absent fact, so storing one would produce a row whose decline reason is
 * a space and whose transition nonetheless succeeded.
 */
function optionalProse(
  raw: unknown,
  field: string,
  max: number,
  details: { field: string; message: string }[],
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') {
    details.push({ field, message: 'must be a non-empty string' });
    return undefined;
  }
  const value = raw.trim();
  if (value.length > max) {
    details.push({ field, message: `must be ${max} characters or fewer` });
    return undefined;
  }
  return value;
}
