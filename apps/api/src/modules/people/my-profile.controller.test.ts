import 'reflect-metadata';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { analyzeStatement } from '../../common/database/tenant-guard.js';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { AuditService } from '../audit/audit.service.js';
import { MemberProfileModule } from './member-profile.controller.js';
import { MyProfileController } from './my-profile.controller.js';
import { MyProfileRepository } from './my-profile.repository.js';
import type { MyProfileRow } from './my-profile.repository.js';

/**
 * t2-b — the signed-in member's own profile card (`GET/PUT …/me/profile`). Database-free proofs over
 * fakes: the read is the caller's own membership in the exact web shape; an unknown membership is a
 * 404; a save writes the caller's own name and title and audits which changed; a bad body is a 400
 * with no write; an unchanged save writes and audits nothing; the module resolves its dependencies;
 * and the repository's SQL passes the tenant guard.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const MEMBERSHIP = 'membership-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';

const context = {
  organizationId: ORG,
  correlationId: 'correlation-0000-0000-0000-000000000001',
} as unknown as TenantContext;

const principal = {
  userId: USER,
  organizationId: ORG,
  kind: 'internal',
  role: 'member',
  membershipId: MEMBERSHIP,
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: false,
} as unknown as Principal;

const STORED: MyProfileRow = {
  userId: USER,
  displayName: 'Mona Saleh',
  email: 'mona@studio.test',
  jobTitle: null,
};

function harness(stored: MyProfileRow | null = STORED) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const findOwn = vi.fn(async () => stored);
  const updateDisplayName = vi.fn(async () => undefined);
  const upsertJobTitle = vi.fn(async () => undefined);
  const repository = {
    findOwn,
    updateDisplayName,
    upsertJobTitle,
  } as unknown as MyProfileRepository;
  const record = vi.fn(async () => ({}));
  const audit = { record } as unknown as AuditService;
  const controller = new MyProfileController(database, repository, audit);
  return { controller, findOwn, updateDisplayName, upsertJobTitle, record };
}

describe('MyProfileController', () => {
  it('GET returns the caller’s own name, sign-in email and job title in the web shape', async () => {
    const { controller, findOwn } = harness({ ...STORED, jobTitle: 'Art director' });
    const view = await controller.get(context, principal);
    expect(view).toEqual({
      displayName: 'Mona Saleh',
      email: 'mona@studio.test',
      jobTitle: 'Art director',
    });
    expect(findOwn).toHaveBeenCalledWith({}, context, MEMBERSHIP);
  });

  it('GET is a 404 when the caller’s membership is not in this tenant', async () => {
    const { controller } = harness(null);
    await expect(controller.get(context, principal)).rejects.toMatchObject({ status: 404 });
  });

  it('PUT writes the caller’s own name and title, ignores email, and audits what changed', async () => {
    const { controller, updateDisplayName, upsertJobTitle, record } = harness();
    const view = await controller.put(context, principal, {
      displayName: '  Mona S.  ',
      jobTitle: ' Art director ',
      email: 'someone-else@studio.test',
    });
    expect(view).toEqual({
      displayName: 'Mona S.',
      email: 'mona@studio.test',
      jobTitle: 'Art director',
    });
    expect(updateDisplayName).toHaveBeenCalledWith({}, USER, 'Mona S.');
    expect(upsertJobTitle).toHaveBeenCalledWith({}, context, USER, 'Art director');
    expect(record).toHaveBeenCalledWith({}, context, {
      action: 'member.profile_updated',
      objectId: MEMBERSHIP,
      result: 'allowed',
      metadata: { name_changed: true, job_changed: true },
    });
  });

  it('PUT refuses a blank name or an oversize title with a 400 and writes nothing', async () => {
    const { controller, findOwn, updateDisplayName, upsertJobTitle, record } = harness();
    await expect(
      controller.put(context, principal, { displayName: '   ', jobTitle: 'x'.repeat(121) }),
    ).rejects.toMatchObject({
      status: 400,
      details: [
        { field: 'displayName', message: 'is required' },
        { field: 'jobTitle', message: 'must be at most 120 characters' },
      ],
    });
    expect(findOwn).not.toHaveBeenCalled();
    expect(updateDisplayName).not.toHaveBeenCalled();
    expect(upsertJobTitle).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('PUT with nothing changed writes and audits nothing (an empty title stays cleared)', async () => {
    const { controller, updateDisplayName, upsertJobTitle, record } = harness();
    const view = await controller.put(context, principal, {
      displayName: 'Mona Saleh',
      jobTitle: '',
    });
    expect(view.jobTitle).toBeNull();
    expect(updateDisplayName).not.toHaveBeenCalled();
    expect(upsertJobTitle).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});

@Global()
@Module({
  providers: [
    { provide: TENANT_DATABASE, useValue: {} },
    { provide: AUDIT_SERVICE, useValue: {} },
  ],
  exports: [TENANT_DATABASE, AUDIT_SERVICE],
})
class FakeGlobalsModule {}

describe('MyProfile wiring', () => {
  it('the member profile module resolves every MyProfileController dependency', async () => {
    const ref = await Test.createTestingModule({
      imports: [FakeGlobalsModule, MemberProfileModule.register()],
    }).compile();
    const instance = ref.get(MyProfileController) as unknown as Record<string, unknown>;
    await ref.close();
    for (const field of ['database', 'profiles', 'audit']) {
      expect(instance[field], field).toBeDefined();
    }
  });

  it('the repository’s tenant-table SQL passes the tenant guard', async () => {
    const org = uuidv7();
    const captured: { sql: string; params: readonly unknown[] }[] = [];
    const respond = ((sql: string, params: readonly unknown[]) => {
      captured.push({ sql, params });
      // A select reads rows; an insert reads the header's `insertId` from the first element.
      return Promise.resolve(sql.startsWith('insert') ? [{ insertId: 0, affectedRows: 1 }] : []);
    }) as unknown as TenantQueryRunner['query'];
    const runner = { query: respond, execute: respond } as unknown as TenantQueryRunner;
    const tenant = createTenantContext({
      organizationId: org,
      userId: uuidv7(),
      principalKind: 'internal',
      membershipId: uuidv7(),
      capabilities: [],
      policyVersion: 'test',
      correlationId: uuidv7(),
    });
    const repository = new MyProfileRepository();

    await repository.findOwn(runner, tenant, uuidv7());
    await repository.upsertJobTitle(runner, tenant, uuidv7(), 'Art director');

    expect(captured).toHaveLength(2);
    for (const { sql, params } of captured) {
      const analysis = analyzeStatement(sql, params, org);
      expect(analysis.violations, `${sql}\n${analysis.violations.join('\n')}`).toEqual([]);
    }
  });
});
