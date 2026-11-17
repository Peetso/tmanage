import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  Ctx,
  CurrentPrincipal,
  CurrentSession,
  RequireCapability,
} from '../../common/http/decorators.js';
import type { AuthenticatedSession } from '../identity/session.service.js';
import type { CertificateStatusView, EinvoiceSigningService } from './einvoice-signing.service.js';
import { RequireFeature } from '../admin/feature-gate.js';

export const EINVOICE_SIGNING_SERVICE = Symbol.for('tmanage.EinvoiceSigningService');

/**
 * 52-12 (R22-a) — the ZATCA signing certificate under
 * `/v1/organizations/:orgSlug/finance/einvoicing/certificate`.
 *
 * - `GET` (`finance.manage`): status only — issuer, subject, serial, validity, fingerprint,
 *   `sandbox` ("test certificate (sandbox)"), `expired`; 404 when none is active. Never a key.
 * - `PUT { certificatePem, privateKeyPem }` (`org.security.manage` + fresh `x-reauth-token`):
 *   stores the pair FieldCipher-encrypted and replaces the active one (old → `rotated`). 422
 *   `unsupported_curve` / `certificate_key_mismatch` / `certificate_expired` /
 *   `invalid_certificate` / `invalid_key`; 403 `step_up_required` without a fresh step-up.
 * - `DELETE` (same guard): the active certificate → `revoked`; new documents go out unsigned.
 *
 * The PUT body's two fields are redacted from logs by name (`common/observability/redact.ts`).
 * PUT and DELETE are NEVER AI tools; the GET is a status-only read op.
 */
@RequireFeature('einvoicing_ksa')
@Controller('v1/organizations/:orgSlug/finance/einvoicing')
export class EinvoicingCertificateController {
  constructor(@Inject(EINVOICE_SIGNING_SERVICE) private readonly service: EinvoiceSigningService) {}

  @Get('certificate')
  @RequireCapability('finance.manage')
  get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CertificateStatusView> {
    return this.service.certificate(context, principal);
  }

  @Put('certificate')
  @RequireCapability('org.security.manage')
  put(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Headers('x-reauth-token') reauthToken: string | undefined,
    @CurrentSession() session?: AuthenticatedSession,
  ): Promise<CertificateStatusView> {
    return this.service.replace(context, principal, body, {
      reauthToken,
      sessionId: session?.sessionId,
    });
  }

  @Delete('certificate')
  @HttpCode(204)
  @RequireCapability('org.security.manage')
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Headers('x-reauth-token') reauthToken: string | undefined,
    @CurrentSession() session?: AuthenticatedSession,
  ): Promise<void> {
    await this.service.revoke(context, principal, { reauthToken, sessionId: session?.sessionId });
  }
}
