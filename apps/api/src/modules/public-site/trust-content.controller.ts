import { Controller, Get, Inject } from '@nestjs/common';
import { Public, NoTenant } from '../../common/http/decorators.js';
import { TrustContentService } from './trust-content.service.js';
import type { PublicTrustView } from './trust-content.service.js';

/**
 * The public security-and-trust page's HTTP surface — module 1 (x158).
 *
 * `@Public()` and `@NoTenant()`: this is read by a prospect or a security reviewer who has no
 * account and no organization, so there is no session to authenticate and no tenant to resolve.
 * Both annotations are visible lines rather than the silent consequence of a missing one — the
 * guards are registered globally, so a route that says nothing is fully protected, and opting a
 * public page out is an explicit act.
 *
 * There is **no capability** and no `authorize()` call, and `capabilities.ts` is untouched: a
 * public page grants nothing and reads nothing tenant-specific, so there is no capability for it
 * to require. The response is deterministic code-defined copy — it discloses the product’s
 * security posture, which is what a trust page exists to disclose.
 */
@Controller('v1/public/site')
export class TrustContentController {
  constructor(@Inject(TrustContentService) private readonly trust: TrustContentService) {}

  /** `GET /v1/public/site/trust` — the security controls, data handling, and subprocessor list. */
  @Get('trust')
  @Public()
  @NoTenant()
  getTrust(): PublicTrustView {
    return this.trust.getTrust();
  }
}
