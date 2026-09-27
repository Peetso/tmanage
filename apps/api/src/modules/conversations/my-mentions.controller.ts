import { Controller, Get, Inject, Module, Query } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { Ctx, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { MyMentionsService } from './my-mentions.service.js';
import type { MentionView } from './my-mentions.service.js';

/**
 * CHAT "my mentions" (x254) — `GET .../me/mentions?page=` behind `conversation.read`.
 *
 * A read-only, own-principal list: the messages that mention the acting member across the
 * conversations they belong to, newest first. It has no path id to resolve — the scope is the
 * caller's memberships, resolved inside {@link MyMentionsService} — so the only authorization
 * layers are the `conversation.read` capability this decorator requires (the guard refuses a
 * caller without it, 403, before the handler runs) and the relation filter the service applies.
 * It mounts under the organization slug like every other route, so `TenantContextGuard` has a
 * tenant to build; `13-ENGINEERING`'s bare `/me/…` shorthand has no slug for that guard.
 */
@Controller('v1/organizations/:orgSlug/me')
export class MyMentionsController {
  constructor(@Inject(MyMentionsService) private readonly mentions: MyMentionsService) {}

  @Get('mentions')
  @RequireCapability('conversation.read')
  async list(
    @Ctx() context: TenantContext,
    @Query('page') page?: string,
  ): Promise<{ readonly mentions: readonly MentionView[] }> {
    let parsedPage: number | undefined;
    if (page !== undefined) {
      parsedPage = Number(page);
      if (!Number.isSafeInteger(parsedPage) || parsedPage < 1) {
        throw new ApiError(400, 'validation_failed', 'The query is invalid', [
          { field: 'page', message: 'must be a positive integer' },
        ]);
      }
    }

    return {
      mentions: await this.mentions.listMyMentions(context, {
        ...(parsedPage === undefined ? {} : { page: parsedPage }),
      }),
    };
  }
}

/**
 * CHAT "my mentions" (x254) — the wiring for the read-only mentions list.
 *
 * Its own module, registered in `app.module.ts` beside `ConversationsModule`, so the sibling chat
 * slices stay file-disjoint (each registers its own module rather than all editing
 * `conversations.module.ts`). The stateless {@link MyMentionsService} is provided by a factory
 * over the global tenant database; it constructs its own (equally stateless) repository.
 */
@Module({})
export class MyMentionsModule {
  static register(): DynamicModule {
    return {
      module: MyMentionsModule,
      providers: [
        {
          provide: MyMentionsService,
          useFactory: (database: TenantDatabase) => new MyMentionsService(database),
          inject: [TENANT_DATABASE],
        },
      ],
      controllers: [MyMentionsController],
    };
  }
}
