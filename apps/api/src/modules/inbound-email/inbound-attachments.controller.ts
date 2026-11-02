import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Readable } from 'node:stream';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { attachmentDisposition, inlineDisposition } from '../files/download-response.js';
import type { HeaderWriter } from '../files/download-response.js';
import { InboundAttachmentsService } from './inbound-attachments.service.js';
import type { AskResendResult, ServedAttachment } from './inbound-attachments.service.js';

/**
 * R22-d (54-12a part 2) — the bytes of a clean inbound attachment, and the ask-resend reply.
 *
 * - `GET  …/inbound-email/attachments/:id/preview`  — clean images/PDF only, `inline`, inside a
 *   sandbox (SEC-54-68: `Content-Security-Policy: sandbox; default-src 'none'; style-src
 *   'unsafe-inline'`, `nosniff`, `private, no-store`, `Cross-Origin-Resource-Policy: same-site`).
 * - `GET  …/inbound-email/attachments/:id/download` — clean only, `attachment`, audited.
 * - `POST …/inbound-email/:id/ask-resend`           — the templated reply to the sender.
 *
 * Everything not servable is one 404 (`not_available`). The service re-checks every capability
 * with the org-scoped `authorize()` and refuses a client principal outright.
 */
export const PREVIEW_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
export const DOWNLOAD_CSP = "sandbox; default-src 'none'";

@Controller('v1/organizations/:orgSlug/inbound-email')
export class InboundAttachmentsController {
  constructor(
    @Inject(InboundAttachmentsService) private readonly service: InboundAttachmentsService,
  ) {}

  @Get('attachments/:id/preview')
  @RequireCapability('client_request.triage')
  async preview(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const served = await this.service.preview(context, principal, id);
    return respond(served, reply, 'inline');
  }

  @Get('attachments/:id/download')
  @RequireCapability('file.download')
  async download(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const served = await this.service.download(context, principal, id);
    return respond(served, reply, 'attachment');
  }

  @Post(':id/ask-resend')
  @RequireCapability('client_request.triage')
  @HttpCode(200)
  askResend(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<AskResendResult> {
    return this.service.askResend(context, principal, id);
  }
}

/** The one place the serving headers are written. */
export function respond(
  served: ServedAttachment,
  reply: HeaderWriter,
  disposition: 'inline' | 'attachment',
): StreamableFile {
  reply.header('content-type', served.mimeType);
  reply.header('content-length', String(served.sizeBytes));
  reply.header(
    'content-disposition',
    disposition === 'inline'
      ? inlineDisposition(served.fileName)
      : attachmentDisposition(served.fileName),
  );
  reply.header('content-security-policy', disposition === 'inline' ? PREVIEW_CSP : DOWNLOAD_CSP);
  reply.header('x-content-type-options', 'nosniff');
  reply.header('cache-control', 'private, no-store');
  reply.header('cross-origin-resource-policy', 'same-site');
  return new StreamableFile(served.stream as Readable, {
    type: served.mimeType,
    length: served.sizeBytes,
  });
}
