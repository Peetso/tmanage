import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { CHANGELOG_REPOSITORY, ChangelogRepository } from './changelog.repository.js';
import { ChangelogController } from './changelog.controller.js';

/**
 * Public product changelog (x160) — the wiring for the read-only public changelog route.
 *
 * Its own module in the new `public-site` folder so the sibling Public-site slices (marketing home,
 * pricing, trust, status — x156–x159) each register their own controller in `app.module.ts` rather
 * than all editing one module file, keeping them file-disjoint. It depends on nothing but the
 * (global) tenant database: the stateless {@link ChangelogRepository} is provided by its class token
 * and the controller reads through it on the identity path.
 */
@Module({})
export class PublicChangelogModule {
  static register(): DynamicModule {
    return {
      module: PublicChangelogModule,
      providers: [{ provide: CHANGELOG_REPOSITORY, useClass: ChangelogRepository }],
      controllers: [ChangelogController],
    };
  }
}
