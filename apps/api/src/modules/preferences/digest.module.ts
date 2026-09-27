import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { DIGEST_PREF_REPOSITORY } from '../../common/http/tokens.js';
import { DigestPreferenceController } from './digest.controller.js';
import { DigestPreferenceRepository } from './digest.repository.js';

/**
 * PREF-DIGEST digest-cadence wiring (module 20, x245).
 *
 * A repository (the member's-own store) and the caller's-own GET/PUT routes over `TENANT_DATABASE`.
 * Kept in a module of its own — file-disjoint from the sibling preferences slices (x182/x183/x215) —
 * so neither slice edits a file the other appends to. The controller depends only on the global
 * tenant database and this repository; there is no tenant object to resolve, so it imports nothing
 * else. Every provider carries an explicit token (ADR-0003).
 */
@Module({})
export class DigestPreferenceModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: DIGEST_PREF_REPOSITORY,
      useFactory: () => new DigestPreferenceRepository(),
    };

    return {
      module: DigestPreferenceModule,
      providers: [repository],
      controllers: [DigestPreferenceController],
    };
  }
}
