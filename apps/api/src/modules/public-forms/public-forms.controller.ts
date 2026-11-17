import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, Public, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { requireRequestState } from '../../common/http/request-state.js';
import {
  INTAKE_SUBMIT_LIMITS,
  PUBLIC_LINK_VIEW_LIMITS,
  Throttle,
} from '../rate-limits/throttle-policies.js';
import type { ChallengeView } from '../public-abuse/challenge.service.js';
import type {
  PublicFormAttachmentSetting,
  PublicFormState,
  PublicFormsService,
  PublicFormView,
} from './public-forms.service.js';
import type { SubmissionView } from './public-forms.service.js';
import { PUBLIC_FORM_UPLOAD_LIMITS } from './public-form-attachments.js';
import type { DraftTokenView, PublicFormAttachmentGate } from './public-form-attachments.js';

export const PUBLIC_FORMS_SERVICE = Symbol.for('tmanage.PublicFormsService');
/** 52-20a. The attachment gate (stateless): built by this module and by the files module. */
export const PUBLIC_FORM_ATTACHMENT_GATE = Symbol.for('tmanage.PublicFormAttachmentGate');

/**
 * 52-20 — the signed-in half: publish / unpublish a work form and triage its public submissions.
 * The route guard asks the coarse capability; {@link PublicFormsService} resolves the form or
 * submission tenant-scoped first (another organization's id is a 404) and then authorizes again.
 */
@Controller('v1/organizations/:orgSlug/work-forms')
export class PublicFormsAdminController {
  constructor(@Inject(PUBLIC_FORMS_SERVICE) private readonly service: PublicFormsService) {}

  @Post(':formId/publish')
  @RequireCapability('work.create')
  @HttpCode(200)
  publish(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('formId') formId: string,
  ): Promise<PublicFormState> {
    return this.service.publish(context, principal, formId);
  }

  @Post(':formId/unpublish')
  @RequireCapability('work.create')
  @HttpCode(200)
  unpublish(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('formId') formId: string,
  ): Promise<PublicFormState> {
    return this.service.unpublish(context, principal, formId);
  }

  /** 52-20a. The owner's attachment setting: `{ projectId }` turns it on, `{ projectId: null }` off. */
  @Put(':formId/attachments')
  @RequireCapability('work.create')
  @HttpCode(200)
  setAttachments(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('formId') formId: string,
    @Body() body: { readonly projectId?: unknown } | undefined,
  ): Promise<PublicFormAttachmentSetting> {
    return this.service.setAttachments(context, principal, formId, body);
  }

  @Get(':formId/submissions')
  @RequireCapability('client_request.triage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('formId') formId: string,
    @Query('state') state?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly submissions: readonly SubmissionView[] }> {
    const submissions = await this.service.listSubmissions(context, principal, formId, {
      state,
      limit,
    });
    return { submissions };
  }

  @Post(':formId/submissions/:submissionId/spam')
  @RequireCapability('client_request.triage')
  @HttpCode(200)
  spam(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('formId') formId: string,
    @Param('submissionId') submissionId: string,
  ): Promise<SubmissionView> {
    return this.service.markSpam(context, principal, formId, submissionId);
  }

  @Post(':formId/submissions/:submissionId/convert')
  @RequireCapability('client_request.triage')
  @HttpCode(200)
  convert(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('formId') formId: string,
    @Param('submissionId') submissionId: string,
    @Body() body: { readonly projectId?: unknown; readonly title?: unknown } | undefined,
  ): Promise<SubmissionView> {
    return this.service.convertToWorkItem(context, principal, formId, submissionId, body);
  }
}

export interface PublicRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly ip?: string;
}

export interface PublicReply {
  header(name: string, value: string): unknown;
  status(code: number): unknown;
}

/** Never cached, never indexed, never sent on as a referrer. */
export function privateHeaders(reply: PublicReply): void {
  reply.header('cache-control', 'no-store');
  reply.header('x-robots-tag', 'noindex');
  reply.header('referrer-policy', 'no-referrer');
}

/**
 * 52-20 — the anonymous door: `GET /v1/public/forms/:slug` (the opaque definition) and
 * `POST /v1/public/forms/:slug/submissions` (→ `{ reference }` only). No session, no tenant from
 * the request: the service derives the organization from the form row.
 */
@Controller('v1/public/forms')
export class PublicFormsController {
  constructor(
    @Inject(PUBLIC_FORMS_SERVICE) private readonly service: PublicFormsService,
    @Inject(PUBLIC_FORM_ATTACHMENT_GATE) private readonly gate: PublicFormAttachmentGate,
  ) {}

  @Get(':slug')
  @Public()
  @Throttle('public_form_view', { ...PUBLIC_LINK_VIEW_LIMITS, key: 'ip' })
  definition(
    @Param('slug') slug: string,
    @Req() request: PublicRequest,
    @Res({ passthrough: true }) reply: PublicReply,
  ): Promise<PublicFormView> {
    privateHeaders(reply);
    return this.service.publicDefinition(slug, requireRequestState(request).correlationId);
  }

  /**
   * 52-20a. A draft token for this visit's attachments (`uploadToken`, sent with every upload and
   * with the submission). 409 `attachments_disabled` when the owner allows none or nothing scans.
   */
  @Post(':slug/upload-token')
  @Public()
  @Throttle('public_form_upload', { ...PUBLIC_FORM_UPLOAD_LIMITS, linkParam: 'slug' })
  @HttpCode(201)
  uploadToken(
    @Param('slug') slug: string,
    @Req() request: PublicRequest,
    @Res({ passthrough: true }) reply: PublicReply,
  ): Promise<DraftTokenView> {
    privateHeaders(reply);
    return this.gate.openDraft(slug, requireRequestState(request).correlationId);
  }

  @Post(':slug/submissions')
  @Public()
  @Throttle('intake_submit', { ...INTAKE_SUBMIT_LIMITS, linkParam: 'slug' })
  @HttpCode(201)
  async submit(
    @Param('slug') slug: string,
    @Body() body: Readonly<Record<string, unknown>> | undefined,
    @Req() request: PublicRequest,
    @Res({ passthrough: true }) reply: PublicReply,
  ): Promise<{ readonly reference: string } | { readonly challenge: ChallengeView }> {
    privateHeaders(reply);
    const acceptLanguage = request.headers['accept-language'];
    const result = await this.service.submit({
      slug,
      body: typeof body === 'object' && body !== null ? body : {},
      ip: request.ip,
      acceptLanguage: typeof acceptLanguage === 'string' ? acceptLanguage : undefined,
      correlationId: requireRequestState(request).correlationId,
    });
    switch (result.kind) {
      case 'stored':
        return { reference: result.reference };
      case 'challenge':
        reply.status(202);
        return { challenge: result.challenge };
      case 'blocked':
        if (result.retryAfterSeconds !== undefined) {
          reply.header('retry-after', String(result.retryAfterSeconds));
          throw new ApiError(429, 'rate_limited', 'Too many submissions. Try again later.');
        }
        // The organization's own block list: calm, and nothing to learn from it.
        throw new ApiError(
          400,
          'validation_failed',
          'This form could not be sent.',
          undefined,
          'public_form_refused',
        );
    }
  }
}
