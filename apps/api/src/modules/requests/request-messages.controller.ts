import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  MAX_REQUEST_MESSAGE_LENGTH,
  REQUEST_MESSAGES_SERVICE,
  type RequestMessageClientView,
  type RequestMessageView,
  type RequestMessagesService,
} from './request-messages.service.js';

/**
 * The client <-> studio thread on a client request (0212, audit gap 4) — two controllers, one per
 * side of the boundary, the split `ClientRequestsController` / `PortalController` already make.
 *
 * - Team: `/client-requests/:id/messages`, behind `client_request.triage` (internal-only). The body
 *   may mark a message team-only (`clientVisible: false`); it defaults to visible.
 * - Client: `/portal/requests/:id/messages`, behind `client_request.submit`. No visibility field —
 *   a client message is always client-visible — and the response is the client projection, swept
 *   by `ClientProjectionInterceptor` because the path contains `/portal`.
 *
 * Neither body can name an organization, a client organization or an author: those come from the
 * session-built `TenantContext` and principal.
 */

interface PostMessageBody {
  readonly body?: unknown;
  readonly clientVisible?: unknown;
}

@Controller('v1/organizations/:orgSlug/client-requests/:clientRequestId/messages')
export class RequestMessagesController {
  constructor(
    @Inject(REQUEST_MESSAGES_SERVICE) private readonly messages: RequestMessagesService,
  ) {}

  @Get()
  @RequireCapability('client_request.triage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientRequestId') clientRequestId: string,
  ): Promise<{ readonly messages: readonly RequestMessageView[] }> {
    return { messages: await this.messages.listForTeam(context, principal, clientRequestId) };
  }

  @Post()
  @RequireCapability('client_request.triage')
  @HttpCode(201)
  async post(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientRequestId') clientRequestId: string,
    @Body() body: PostMessageBody,
  ): Promise<RequestMessageView> {
    return this.messages.postForTeam(context, principal, clientRequestId, {
      body: requiredBody(body?.body),
      clientVisible: optionalVisibility(body?.clientVisible),
    });
  }
}

@Controller('v1/organizations/:orgSlug/portal/requests/:clientRequestId/messages')
export class PortalRequestMessagesController {
  constructor(
    @Inject(REQUEST_MESSAGES_SERVICE) private readonly messages: RequestMessagesService,
  ) {}

  @Get()
  @RequireCapability('client_request.submit')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientRequestId') clientRequestId: string,
  ): Promise<{ readonly messages: readonly RequestMessageClientView[] }> {
    return { messages: await this.messages.listForClient(context, principal, clientRequestId) };
  }

  @Post()
  @RequireCapability('client_request.submit')
  @HttpCode(201)
  async post(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientRequestId') clientRequestId: string,
    @Body() body: PostMessageBody,
  ): Promise<RequestMessageClientView> {
    return this.messages.postForClient(context, principal, clientRequestId, {
      body: requiredBody(body?.body),
    });
  }
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

function requiredBody(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw invalid('body', 'must be a non-empty string');
  }
  const text = raw.trim();
  if (text.length > MAX_REQUEST_MESSAGE_LENGTH) {
    throw invalid('body', `must be ${MAX_REQUEST_MESSAGE_LENGTH} characters or fewer`);
  }
  return text;
}

function optionalVisibility(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  if (typeof raw !== 'boolean') throw invalid('clientVisible', 'must be a boolean');
  return raw;
}
