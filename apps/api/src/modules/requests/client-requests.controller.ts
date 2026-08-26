import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { AUDIENCES, CLIENT_REQUEST_STATES } from '@tmanage/domain';
import type { Audience, ClientRequestState, Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { CLIENT_REQUESTS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  AcceptedClientRequest,
  ClientRequestView,
  ClientRequestsService,
} from './client-requests.service.js';
import type { AuditEventView } from '../audit/audit.service.js';
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

/** `23-ERD` §6's three requirements, plus how the work is obtained. */
interface AcceptanceBody {
  readonly version?: unknown;
  readonly clientSafeScopeSummary?: unknown;
  /** `"unscheduled"` or an ISO 8601 instant. Required — silence is not an answer to "when". */
  readonly commitment?: unknown;
  /** Point at existing work. Mutually exclusive with `work`. */
  readonly linkedWorkItemId?: unknown;
  readonly work?: unknown;
}

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
    if (to === 'accepted') {
      // REQ-002 made acceptance a route of its own, because it creates the work in the same
      // transaction. Leaving it reachable here would leave an acceptance path that links work
      // created anywhere — which is the two-write version this ticket exists to remove.
      details.push({
        field: 'to',
        message:
          'use POST :clientRequestId/acceptance, which commits the work in the same transaction',
      });
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

  /**
   * Accept, and commit the work — REQ-002.
   *
   * A route of its own rather than a state on `POST :id/transitions`, and the difference is a
   * transaction rather than a URL: this endpoint creates the work item and moves the request in
   * one unit, so an acceptance that fails leaves no task behind describing work nobody agreed
   * to. `:id/transitions` refuses `accepted` and says so, which is the only way the guarantee
   * survives a second author.
   *
   * `client_request.triage` on the route. Creating the work needs `work.create` as well, and
   * that is checked by the service against the *project* rather than here — a capability guard
   * knows the role and not the relation.
   */
  @Post(':clientRequestId/acceptance')
  @RequireCapability('client_request.triage')
  @HttpCode(200)
  async accept(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientRequestId') clientRequestId: string,
    @Body() body: AcceptanceBody,
  ): Promise<AcceptedClientRequest> {
    const details: { field: string; message: string }[] = [];
    const version = requiredVersion(body?.version, details);

    const clientSafeScopeSummary = requiredProse(
      body?.clientSafeScopeSummary,
      'clientSafeScopeSummary',
      MAX_SCOPE_SUMMARY_LENGTH,
      details,
    );
    const commitment = parseCommitment(body?.commitment, details);
    if (body?.commitment === undefined) {
      // Required here, unlike on a transition, because there is no acceptance without an answer
      // to "when". `23-ERD` §6 admits `unscheduled` as that answer; it does not admit silence.
      details.push({
        field: 'commitment',
        message: "must be 'unscheduled' or an ISO 8601 instant",
      });
    }

    const linkedWorkItemId =
      typeof body?.linkedWorkItemId === 'string' && body.linkedWorkItemId !== ''
        ? body.linkedWorkItemId
        : undefined;
    if (body?.linkedWorkItemId !== undefined && linkedWorkItemId === undefined) {
      details.push({ field: 'linkedWorkItemId', message: 'must be a work item id' });
    }

    const rawWork =
      body?.work === undefined || body.work === null
        ? undefined
        : typeof body.work === 'object' && !Array.isArray(body.work)
          ? (body.work as Record<string, unknown>)
          : undefined;
    if (body?.work !== undefined && body.work !== null && rawWork === undefined) {
      details.push({ field: 'work', message: 'must be an object' });
    }
    if (rawWork !== undefined && linkedWorkItemId !== undefined) {
      // Both would mean "create this, and also use that", which names two different pieces of
      // work for one acceptance. Refused rather than silently preferring one.
      details.push({
        field: 'work',
        message: 'cannot be given together with linkedWorkItemId',
      });
    }

    const workTitle = optionalWorkTitle(rawWork?.['title'], details);
    const workAudience = optionalAudience(rawWork?.['audience'], details);
    const workOwnerUserId =
      typeof rawWork?.['ownerUserId'] === 'string' && rawWork['ownerUserId'] !== ''
        ? (rawWork['ownerUserId'] as string)
        : undefined;

    if (
      details.length > 0 ||
      version === undefined ||
      clientSafeScopeSummary === undefined ||
      commitment === undefined
    ) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    const work = {
      ...(workTitle === undefined ? {} : { title: workTitle }),
      ...(workAudience === undefined ? {} : { audience: workAudience }),
      ...(workOwnerUserId === undefined ? {} : { ownerUserId: workOwnerUserId }),
    };

    return this.requests.accept(context, principal, clientRequestId, version, {
      clientSafeScopeSummary,
      commitment,
      ...(linkedWorkItemId === undefined ? {} : { linkedWorkItemId }),
      ...(Object.keys(work).length === 0 ? {} : { work }),
    });
  }

  /**
   * The request's history — US-B02's "actor/time/history immutable".
   *
   * `client_request.triage` gates reaching the request at all; `AuditService` then applies its
   * own `audit.read` check and its own scope narrowing, so a `manager` reading this sees what
   * `audit.read` entitles them to and not one row more.
   */
  @Get(':clientRequestId/history')
  @RequireCapability('client_request.triage')
  async history(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientRequestId') clientRequestId: string,
  ): Promise<{ readonly history: readonly AuditEventView[] }> {
    return { history: await this.requests.historyOf(context, principal, clientRequestId) };
  }
}

/**
 * A sentence the transition could not happen without.
 *
 * `optionalProse` treats an absent value as "not changing this". An acceptance has no such
 * reading: §6 requires the scope summary, so absence is a validation failure with a field name
 * rather than a state-machine 422 that says only that something was missing.
 */
function requiredProse(
  raw: unknown,
  field: string,
  max: number,
  details: { field: string; message: string }[],
): string | undefined {
  if (raw === undefined) {
    details.push({ field, message: 'is required to accept a request' });
    return undefined;
  }
  return optionalProse(raw, field, max, details);
}

/** `work_items.title` is `VARCHAR(300)`, the same width as a request's. */
function optionalWorkTitle(
  raw: unknown,
  details: { field: string; message: string }[],
): string | undefined {
  return optionalProse(raw, 'work.title', 300, details);
}

function optionalAudience(
  raw: unknown,
  details: { field: string; message: string }[],
): Audience | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !(AUDIENCES as readonly string[]).includes(raw)) {
    details.push({ field: 'work.audience', message: `must be one of ${AUDIENCES.join(', ')}` });
    return undefined;
  }
  return raw as Audience;
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
