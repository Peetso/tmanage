import { Controller, Get, Inject, Optional } from '@nestjs/common';
import { Public, NoTenant } from '../../common/http/decorators.js';
import { TrustContentService } from './trust-content.service.js';
import type { PublicTrustView } from './trust-content.service.js';
import { DataLocationService } from './data-location.service.js';
import type { PublicDataLocationView } from './data-location.service.js';

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
  constructor(
    @Inject(TrustContentService) private readonly trust: TrustContentService,
    @Optional()
    @Inject(DataLocationService)
    private readonly dataLocation: DataLocationService = new DataLocationService(),
  ) {}

  /** `GET /v1/public/site/trust` — the security controls, data handling, and subprocessor list. */
  @Get('trust')
  @Public()
  @NoTenant()
  getTrust(): PublicTrustView {
    return this.trust.getTrust();
  }

  /**
   * `GET /v1/public/site/data-location` (54-17) — the region and data-centre label behind the
   * "Where your data lives" page and every organization's Data-location card. Public: it names the
   * deployment's hosting, nothing about any organization (all are in `default` until 54-18).
   */
  @Get('data-location')
  @Public()
  @NoTenant()
  getDataLocation(): PublicDataLocationView {
    return this.dataLocation.getDataLocation();
  }
}
