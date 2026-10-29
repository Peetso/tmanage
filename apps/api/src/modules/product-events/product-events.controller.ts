import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import {
  Ctx,
  CurrentPrincipal,
  CurrentSession,
  RequireCapability,
} from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { AuthenticatedSession } from '../identity/session.service.js';
import type { ProductEventsService } from './product-events.service.js';

export const PRODUCT_EVENTS_SERVICE = Symbol.for('tmanage.ProductEventsService');

/** What an ingest answers: how many events were kept, and how many were filtered out. */
export interface ProductEventsIngestView {
  readonly accepted: number;
  readonly droppedEvents: number;
  readonly droppedProperties: number;
}

/**
 * 55-21 ingest — `POST /v1/organizations/:orgSlug/events` (internal members) and
 * `POST /v1/organizations/:orgSlug/portal/events` (client principals).
 *
 * Two routes because a tenant route must name the capability it needs and no single capability
 * is held by both audiences: `work.read` is every internal role's and no client's,
 * `client_projection.read` is the one read every client role holds. Each route accepts only its
 * own audience (a client principal on the internal route, or the reverse, is a 403), so
 * `principal_kind` is a fact about the session, not a value the body supplies.
 *
 * Own events only: the organization is the verified tenant context and the actor is a quarterly
 * salted hash of the caller's membership — the body has no field for either.
 */
@Controller('v1/organizations/:orgSlug')
export class ProductEventsController {
  constructor(@Inject(PRODUCT_EVENTS_SERVICE) private readonly service: ProductEventsService) {}

  @Post('events')
  @RequireCapability('work.read')
  @HttpCode(202)
  internal(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @CurrentSession() session: AuthenticatedSession,
    @Body() body: unknown,
  ): Promise<ProductEventsIngestView> {
    if (principal.kind !== 'internal') throw forbidden();
    return this.service.ingest(context, principal, 'internal', session.sessionId, body);
  }

  @Post('portal/events')
  @RequireCapability('client_projection.read')
  @HttpCode(202)
  portal(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @CurrentSession() session: AuthenticatedSession,
    @Body() body: unknown,
  ): Promise<ProductEventsIngestView> {
    if (principal.kind !== 'client') throw forbidden();
    return this.service.ingest(context, principal, 'client', session.sessionId, body);
  }
}

function forbidden(): ApiError {
  return new ApiError(403, 'forbidden', 'This route is for another kind of account.');
}
