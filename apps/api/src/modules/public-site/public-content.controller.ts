import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '../../common/http/decorators.js';
import {
  PUBLIC_CONTENT_SERVICE,
  type PublicContentService,
  type PublicHomeView,
} from './public-content.service.js';

/**
 * Public & trust site (module 1) — the marketing home route.
 *
 * `GET /v1/public/site/home` — the landing page's content. The controller is `@Public()` at the
 * class level, which is the deliberate opposite of every other controller in the app: the four
 * global guards (`SessionAuthGuard`, `CsrfGuard`, `TenantContextGuard`, `CapabilityGuard`) each
 * short-circuit on `IS_PUBLIC`, so this route needs no session, no CSRF token, no organization,
 * and no capability — exactly like the sign-in and refresh doors. That is the point of the module:
 * a page an unauthenticated visitor can read.
 *
 * The controller touches no database (ADR-0001 layer 4). It reads nothing from the request — there
 * is nothing to read — and returns the deterministic payload the service holds. Any sub-path other
 * than `home` matches no handler and is a 404 from the router, before any guard runs; the module
 * exposes exactly the one read and nothing else.
 */
@Public()
@Controller('v1/public/site')
export class PublicContentController {
  constructor(@Inject(PUBLIC_CONTENT_SERVICE) private readonly content: PublicContentService) {}

  @Get('home')
  home(): PublicHomeView {
    return this.content.home();
  }
}
