import 'reflect-metadata';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import { analyzeStatement } from '../../common/database/tenant-guard.js';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type { TenantQueryRunner } from '../../common/database/tenant-context.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import {
  PersonCertificationsController,
  PersonCertificationsModule,
} from './certifications.controller.js';
import { MemberProfileController, MemberProfileModule } from './member-profile.controller.js';
import { PersonProfileController, PersonProfileModule } from './profile.controller.js';
import { PersonProfileRepository } from './profile.repository.js';
import { PeopleTeamsController, PeopleTeamsModule } from './teams.controller.js';
import { PersonTimeOffController, PersonTimeOffModule } from './time-off.controller.js';

/**
 * The live 500s on People → Teams and People → Profile (2026-10-18). The API is compiled without
 * `emitDecoratorMetadata` (ADR-0003), so a constructor parameter without an explicit `@Inject` is
 * resolved to `undefined` and the first request dies on `this.service.…`. The controller unit tests
 * construct controllers by hand and never saw it; this compiles each module through Nest's injector.
 */
@Global()
@Module({ providers: [{ provide: TENANT_DATABASE, useValue: {} }], exports: [TENANT_DATABASE] })
class FakeGlobalsModule {}

async function instanceOf(module: unknown, controller: new (...args: never[]) => unknown) {
  const ref = await Test.createTestingModule({
    imports: [FakeGlobalsModule, module as never],
  }).compile();
  const instance = ref.get(controller) as Record<string, unknown>;
  await ref.close();
  return instance;
}

describe('people modules resolve every constructor dependency', () => {
  it.each([
    ['teams', PeopleTeamsModule.register(), PeopleTeamsController, ['service']],
    ['profile', PersonProfileModule.register(), PersonProfileController, ['database', 'profile']],
    ['member profile', MemberProfileModule.register(), MemberProfileController, ['profiles']],
    ['time off', PersonTimeOffModule.register(), PersonTimeOffController, ['service']],
    [
      'certifications',
      PersonCertificationsModule.register(),
      PersonCertificationsController,
      ['service', 'repository'],
    ],
  ] as const)('%s', async (_name, module, controller, fields) => {
    const instance = await instanceOf(module, controller as never);
    for (const field of fields) expect(instance[field], field).toBeDefined();
  });
});

describe('PersonProfileRepository.listProjects', () => {
  it('binds the joined projects table to the tenant, so the guard accepts it', async () => {
    const org = uuidv7();
    const captured: { sql: string; params: readonly unknown[] }[] = [];
    const respond = ((sql: string, params: readonly unknown[]) => {
      captured.push({ sql, params });
      return Promise.resolve([]);
    }) as unknown as TenantQueryRunner['query'];
    const runner = { query: respond, execute: respond } as unknown as TenantQueryRunner;
    const context = createTenantContext({
      organizationId: org,
      userId: uuidv7(),
      principalKind: 'internal',
      membershipId: uuidv7(),
      capabilities: [],
      policyVersion: 'test',
      correlationId: uuidv7(),
    });

    await new PersonProfileRepository().listProjects(runner, context, uuidv7());

    const analysis = analyzeStatement(captured[0]?.sql ?? '', captured[0]?.params ?? [], org);
    expect(analysis.violations, analysis.violations.join('\n')).toEqual([]);
    expect(analysis.tenantTables).toContain('projects');
  });
});
