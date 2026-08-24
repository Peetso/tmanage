import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { API_CONFIG, SESSION_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { SessionService } from './session.service.js';
import { DevelopmentSignInController, SessionController } from './session.controller.js';

/**
 * ID-001's HTTP surface.
 *
 * The one decision worth reading here is the conditional controller list.
 * `DevelopmentSignInController` accepts a `userId` on trust, because ID-002 is not written and
 * nothing in this application yet authenticates a person. In production that route is **not
 * registered at all** rather than registered and refusing.
 *
 * The difference matters. A route that exists and returns 403 is one flipped condition away
 * from existing and returning a valid session, and the flip could come from a guard edit, a
 * misordered `APP_GUARD`, or an environment variable set wrongly during a deploy. A route that
 * was never added to the module has no code path at all: the router has no entry, and the 404
 * it returns is the same 404 as any other unknown path. `http-pipeline.db.test.ts` asserts it.
 */
@Module({})
export class IdentityModule {
  static register(): DynamicModule {
    const sessionService: Provider = {
      provide: SESSION_SERVICE,
      inject: [TENANT_DATABASE, API_CONFIG],
      useFactory: (database: TenantDatabase, config: ApiConfig) =>
        new SessionService(database, config),
    };

    return {
      module: IdentityModule,
      providers: [sessionService],
      exports: [sessionService],
      controllers: [SessionController],
    };
  }

  /** Everything in {@link register}, plus the development-only sign-in route. */
  static registerWithDevelopmentSignIn(): DynamicModule {
    const base = IdentityModule.register();
    return {
      ...base,
      controllers: [...(base.controllers ?? []), DevelopmentSignInController],
    };
  }
}
