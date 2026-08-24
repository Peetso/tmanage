import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  MEMBERSHIP_RESOLVER,
  PRINCIPAL_REPOSITORY,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { MembershipResolver } from './membership-resolver.repository.js';
import { PrincipalRepository } from './principal.repository.js';

/**
 * Spec §3 steps 2 to 4, made injectable.
 *
 * No controllers. Nothing here is an endpoint — organization creation is still unimplemented
 * (an unscoped write; see the named gaps under TEN-001), and the resolver is not something a
 * caller invokes directly. These providers exist so `TenantContextGuard` can reach them.
 */
@Module({})
export class TenancyModule {
  static register(): DynamicModule {
    const resolver: Provider = {
      provide: MEMBERSHIP_RESOLVER,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new MembershipResolver(database),
    };
    const principals: Provider = {
      provide: PRINCIPAL_REPOSITORY,
      useFactory: () => new PrincipalRepository(),
    };

    return {
      module: TenancyModule,
      providers: [resolver, principals],
      exports: [resolver, principals],
    };
  }
}
