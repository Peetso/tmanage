import { Controller, Get, Inject, Module, NotFoundException, Param } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { Public } from '../../common/http/decorators.js';
import {
  PUBLIC_CONTENT_SERVICE,
  PublicContentService,
  type PublicResourceListView,
  type PublicResourceView,
} from './public-content.service.js';

/**
 * Public & trust site (module 1) — the resources/guides surface (x187).
 *
 * `GET /v1/public/site/resources` — the index of resource cards; `GET /v1/public/site/resources/:slug`
 * — one article body. Both are `@Public()` at the class level, the deliberate opposite of every
 * authed controller: the four global guards (`SessionAuthGuard`, `CsrfGuard`, `TenantContextGuard`,
 * `CapabilityGuard`) each short-circuit on `IS_PUBLIC`, so these routes need no session, no CSRF, no
 * organization and no capability — exactly the marketing home's posture, because a public visitor
 * reads guides before signing in.
 *
 * The controller touches no database (ADR-0001 layer 4) and reads only the deterministic content the
 * service holds. The `:slug` read is the one place untrusted input reaches a handler: the slug is not
 * a path or a key into anything mutable — it is looked up by membership in a frozen, code-defined map,
 * so a value outside that set (unknown, crafted, or traversal-shaped) can only miss and become a 404.
 * Nothing is read from the filesystem, no query is built, and no slug the catalog does not name is
 * ever served.
 */
@Public()
@Controller('v1/public/site/resources')
export class PublicResourcesController {
  constructor(@Inject(PUBLIC_CONTENT_SERVICE) private readonly content: PublicContentService) {}

  @Get()
  list(): PublicResourceListView {
    return this.content.resources();
  }

  @Get(':slug')
  one(@Param('slug') slug: string): PublicResourceView {
    const entry = this.content.resource(slug);
    if (!entry) throw new NotFoundException();
    return entry;
  }
}

/**
 * Wiring for the resources/guides routes (x187).
 *
 * Its own module registered in `app.module.ts`, matching the sibling public-site slices which each
 * register their own controller rather than all editing one module file (file-disjoint). It reuses
 * the deterministic {@link PublicContentService} — the resource catalog lives there beside the
 * marketing-home copy — providing a fresh, stateless instance under the shared token (ADR-0003);
 * the payload is frozen, so a per-module instance is safe and depends on nothing (no database, no
 * tenant, no mailer). Its position in the app module is therefore free.
 */
@Module({})
export class PublicResourcesModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: PUBLIC_CONTENT_SERVICE,
      useFactory: () => new PublicContentService(),
    };

    return {
      module: PublicResourcesModule,
      providers: [service],
      controllers: [PublicResourcesController],
    };
  }
}
