import { Body, Controller, Get, HttpCode, Inject, Module, Param, Put } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import { REQUEST_TRIAGE_CATEGORIES } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { RequestTriageRepository } from './request-triage.repository.js';
import { RequestTriageService } from './request-triage.service.js';

/**
 * Request triage — the studio's internal triage of an incoming client request (REQ-02, x265).
 *
 * `client_requests` (0006) ships the request and its client-facing lifecycle. This slice adds the
 * internal step before commitment: `PUT /client-requests/:id/triage` files the request under a
 * category and, optionally, assigns it to an internal member; `GET` reads the current triage. A
 * second controller on the client-requests base path rather than an edit to `ClientRequestsController`
 * — triage metadata is its own table (`request_triage`) with its own routes, kept in its own file so
 * this slice stays disjoint from the list/lifecycle controller the chain already ships.
 *
 * ## The capability is reused, not invented
 *
 * Both routes are behind **`client_request.triage`** — the internal-only capability the whole requests
 * module already reads and writes under (`ClientRequestsController`). No `capabilities.ts` edit: the
 * capability is exactly the right one (it is literally "may triage"), it is internal-only so a client
 * never reaches these routes, and it is relation-gated so a project-scoped manager may triage only
 * their own projects' requests. The route decorator is the coarse role gate; the object-level relation
 * check is the service's, on the resolved request — the division `capability.guard.ts` documents.
 *
 * ## Validation is here; resolution and authorization are the service's
 *
 * The body is validated here: `category` must be one of the fixed {@link REQUEST_TRIAGE_CATEGORIES}
 * allowlist — a value outside it is a 400 and nothing is written (the refusal this slice's unit test
 * pins) — and `assigneeMembershipId`, when present, must be a non-empty id (the service then confirms
 * it names an *active* member of this tenant, a 404 otherwise). The service resolves the request
 * (and assignee) tenant-scoped BEFORE it authorizes, so a request that is not this studio's is a 404,
 * never a 403 that would confirm it exists.
 */

/** What the GET/PUT route exchanges: a request's triage, without row identity. Paired with the web shape. */
export interface RequestTriageView {
  readonly requestId: string;
  /** The category the request is filed under, or `null` when it has not been triaged yet. */
  readonly category: string | null;
  /** The internal member the request is assigned to, or `null` when unassigned or untriaged. */
  readonly assigneeMembershipId: string | null;
  /** Whether a triage row exists yet. `false` is the at-rest, never-triaged read. */
  readonly triaged: boolean;
}

/** The fixed category allowlist, for O(1) membership checks. */
const KNOWN_CATEGORIES: ReadonlySet<string> = new Set(REQUEST_TRIAGE_CATEGORIES);

@Controller('v1/organizations/:orgSlug/client-requests/:clientRequestId/triage')
export class RequestTriageController {
  private readonly service: RequestTriageService;

  constructor(@Inject(TENANT_DATABASE) database: TenantDatabase, triage: RequestTriageRepository) {
    this.service = new RequestTriageService(database, triage);
  }

  @Get()
  @RequireCapability('client_request.triage')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientRequestId') clientRequestId: string,
  ): Promise<RequestTriageView> {
    return this.service.getTriage(context, principal, clientRequestId);
  }

  @Put()
  @RequireCapability('client_request.triage')
  @HttpCode(200)
  async put(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientRequestId') clientRequestId: string,
    @Body() body: unknown,
  ): Promise<RequestTriageView> {
    const input = parseInput(body);
    return this.service.setTriage(context, principal, clientRequestId, input);
  }
}

/**
 * Validate a PUT body into a triage input: `category` is required and must be one of the fixed
 * allowlist; `assigneeMembershipId` is optional — `null`, absent, or a non-empty id string. Any
 * failure is a single 400 and nothing is written, so an off-allowlist category never reaches the
 * store.
 */
export function parseInput(body: unknown): {
  category: string;
  assigneeMembershipId: string | null;
} {
  const details: { field: string; message: string }[] = [];
  const value = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  const rawCategory = value['category'];
  if (typeof rawCategory !== 'string' || !KNOWN_CATEGORIES.has(rawCategory)) {
    details.push({
      field: 'category',
      message: `must be one of: ${REQUEST_TRIAGE_CATEGORIES.join(', ')}`,
    });
  }

  const rawAssignee = value['assigneeMembershipId'];
  let assigneeMembershipId: string | null = null;
  if (rawAssignee !== undefined && rawAssignee !== null) {
    if (typeof rawAssignee !== 'string' || rawAssignee.trim() === '') {
      details.push({ field: 'assigneeMembershipId', message: 'must be a membership id' });
    } else {
      assigneeMembershipId = rawAssignee;
    }
  }

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The request triage is invalid', details);
  }

  return { category: rawCategory as string, assigneeMembershipId };
}

/**
 * x265's wiring — a self-contained module registered from `app.module.ts` (the shared append point)
 * rather than folded into {@link RequestsModule}, so the requests slices stay file-disjoint. The
 * repository is a stateless collection of tenant-scoped queries, constructed here; the controller
 * injects it and the `@Global` `TENANT_DATABASE` and builds the service.
 */
@Module({})
export class RequestTriageModule {
  static register(): DynamicModule {
    return {
      module: RequestTriageModule,
      providers: [
        { provide: RequestTriageRepository, useFactory: () => new RequestTriageRepository() },
      ],
      controllers: [RequestTriageController],
    };
  }
}
