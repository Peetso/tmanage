import { Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common';
import { Public } from '../../common/http/decorators.js';
import {
  PUBLIC_CONTENT_SERVICE,
  type PublicContentService,
  type PublicLegalView,
} from './public-content.service.js';

/**
 * Public & trust site (module 1) — the legal documents route (x188).
 *
 * `GET /v1/public/site/legal/:doc` where `:doc` is `terms` or `privacy` — the long-form legal copy
 * a prospect or a customer's counsel reads before anyone signs in. The controller is `@Public()`,
 * so the four global guards (`SessionAuthGuard`, `CsrfGuard`, `TenantContextGuard`,
 * `CapabilityGuard`) each short-circuit on `IS_PUBLIC`: no session, no CSRF token, no organization,
 * and no capability. `capabilities.ts` is untouched — a public page grants nothing and reads
 * nothing tenant-specific, so there is no capability for it to require.
 *
 * The one security concern this route does own is the `:doc` segment. It is an open path parameter,
 * so it is narrowed against a two-value allowlist before it reaches any lookup: the service returns
 * `undefined` for anything but `terms` or `privacy`, and this controller turns that into a 404. An
 * arbitrary segment therefore never indexes the content map and never reveals which keys exist —
 * `/legal/../secrets` or `/legal/home` is a plain 404, indistinguishable from a typo. The response
 * is deterministic, code-defined copy with a frozen effective date (ADR-0001 layer 4: the
 * controller touches no database).
 */
@Public()
@Controller('v1/public/site')
export class LegalController {
  constructor(@Inject(PUBLIC_CONTENT_SERVICE) private readonly content: PublicContentService) {}

  /** `GET /v1/public/site/legal/:doc` — the requested legal document, or 404 outside the allowlist. */
  @Get('legal/:doc')
  legal(@Param('doc') doc: string): PublicLegalView {
    const view = this.content.legal(doc);
    if (!view) throw new NotFoundException('unknown_legal_document');
    return view;
  }
}
