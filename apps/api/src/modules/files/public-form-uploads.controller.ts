import { Body, Controller, Headers, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { Public } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { API_CONFIG, FILES_SERVICE } from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import { Throttle } from '../rate-limits/throttle-policies.js';
import { PUBLIC_FORM_UPLOAD_LIMITS } from '../public-forms/public-form-attachments.js';
import type { PublicFormAttachmentGate } from '../public-forms/public-form-attachments.js';
import {
  PUBLIC_FORM_ATTACHMENT_GATE,
  privateHeaders,
} from '../public-forms/public-forms.controller.js';
import type { PublicReply, PublicRequest } from '../public-forms/public-forms.controller.js';
import type { FilesService, PublicFormFileView, PublicFormUploadView } from './files.service.js';
import { parseParts, parseUploadBody, requiredIdempotencyKey } from './upload-input.js';
import type { ValidationDetail } from './upload-input.js';

/** The header a visitor's page sends its draft token in — never the URL, which gets logged. */
const TOKEN_HEADER = 'x-form-upload-token';
const THROTTLE = { ...PUBLIC_FORM_UPLOAD_LIMITS, linkParam: 'slug' } as const;

const invalid = (details: ValidationDetail[]): ApiError =>
  new ApiError(400, 'validation_failed', 'The request body is invalid', details);

/**
 * 52-20a — the anonymous attachment door of a public form: open, complete and cancel one upload.
 *
 * No session and no tenant from the request. Every call first asks the gate, which resolves the
 * slug to the published form, re-checks the owner's attachment setting (409 when off) and opens the
 * visit's draft token (400 when forged, expired or for another form). The files door then pins the
 * upload to the owner's project and the token's submission; the visitor's body supplies only the
 * file's name, type, size and hash. The part PUTs go to `UploadPartsController`, as for any upload.
 */
@Controller('v1/public/forms/:slug/uploads')
export class PublicFormUploadsController {
  constructor(
    @Inject(FILES_SERVICE) private readonly files: FilesService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(PUBLIC_FORM_ATTACHMENT_GATE) private readonly gate: PublicFormAttachmentGate,
  ) {}

  @Post()
  @Public()
  @Throttle('public_form_upload', THROTTLE)
  @HttpCode(201)
  async create(
    @Param('slug') slug: string,
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Headers('idempotency-key') idempotencyHeader: string | undefined,
    @Body() body: unknown,
    @Req() request: PublicRequest,
    @Res({ passthrough: true }) reply: PublicReply,
  ): Promise<PublicFormUploadView> {
    privateHeaders(reply);
    const { context, target } = await this.gate.uploadTarget(
      slug,
      token,
      requireRequestState(request).correlationId,
    );
    const fields = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    const details: ValidationDetail[] = [];
    const idempotencyKey = requiredIdempotencyKey(idempotencyHeader, details);
    // Only the file's own facts come from the visitor; where it goes comes from the gate.
    const parsed = parseUploadBody(
      {
        fileName: fields['fileName'],
        mimeType: fields['mimeType'],
        sizeBytes: fields['sizeBytes'],
        contentHash: fields['contentHash'],
        projectId: target.projectId,
        purpose: 'form_attachment',
        objectId: target.submissionId,
      },
      this.config.uploadMaxBytes,
      details,
    );
    if (details.length > 0 || !idempotencyKey || !parsed) throw invalid(details);
    return this.files.createForPublicForm(context, target, { ...parsed, idempotencyKey });
  }

  @Post(':uploadSessionId/complete')
  @Public()
  @Throttle('public_form_upload', THROTTLE)
  @HttpCode(202)
  async complete(
    @Param('slug') slug: string,
    @Param('uploadSessionId') uploadSessionId: string,
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Body() body: unknown,
    @Req() request: PublicRequest,
    @Res({ passthrough: true }) reply: PublicReply,
  ): Promise<PublicFormFileView> {
    privateHeaders(reply);
    const { context, target } = await this.gate.uploadTarget(
      slug,
      token,
      requireRequestState(request).correlationId,
    );
    const details: ValidationDetail[] = [];
    const parts = parseParts(body, details);
    if (details.length > 0) throw invalid(details);
    return this.files.completeForPublicForm(context, target, uploadSessionId, parts);
  }

  @Post(':uploadSessionId/cancel')
  @Public()
  @Throttle('public_form_upload', THROTTLE)
  @HttpCode(200)
  async cancel(
    @Param('slug') slug: string,
    @Param('uploadSessionId') uploadSessionId: string,
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Req() request: PublicRequest,
    @Res({ passthrough: true }) reply: PublicReply,
  ): Promise<PublicFormUploadView> {
    privateHeaders(reply);
    const { context, target } = await this.gate.uploadTarget(
      slug,
      token,
      requireRequestState(request).correlationId,
    );
    return this.files.cancelForPublicForm(context, target, uploadSessionId);
  }
}
