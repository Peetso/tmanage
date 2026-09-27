import { Controller, Get, Inject } from '@nestjs/common';
import { Public, NoTenant } from '../../common/http/decorators.js';
import { PUBLIC_FAQ_SERVICE, type FaqContentService, type PublicFaqView } from './faq.service.js';

/**
 * Public & trust site (module 1) — the public FAQ route (x186).
 *
 * `GET /v1/public/site/faq` — the FAQ page's content. `@Public()` and `@NoTenant()`: this is read
 * by a prospect who has no account and no organization, so there is no session to authenticate and
 * no tenant to resolve. Both annotations are visible lines rather than the silent consequence of a
 * missing one — the four global guards (`SessionAuthGuard`, `CsrfGuard`, `TenantContextGuard`,
 * `CapabilityGuard`) each short-circuit on `IS_PUBLIC`, so this route needs no session, no CSRF
 * token, no organization, and no capability, exactly like the sign-in and refresh doors.
 *
 * There is **no capability** and no `authorize()` call, and `capabilities.ts` is untouched: a
 * public page grants nothing and reads nothing tenant-specific. The controller touches no database
 * (ADR-0001 layer 4); it reads nothing from the request and returns the deterministic payload the
 * service holds. Any sub-path other than `faq` matches no handler and is a 404 from the router,
 * before any guard runs.
 */
@Controller('v1/public/site')
export class FaqContentController {
  constructor(@Inject(PUBLIC_FAQ_SERVICE) private readonly content: FaqContentService) {}

  /** `GET /v1/public/site/faq` — the grouped FAQ content. */
  @Get('faq')
  @Public()
  @NoTenant()
  getFaq(): PublicFaqView {
    return this.content.getFaq();
  }
}
