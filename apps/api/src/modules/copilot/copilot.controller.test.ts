import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { CopilotController } from './copilot.controller.js';
import { CopilotService } from './copilot.service.js';
import { LocalStubProvider } from './copilot.provider.js';
import type { FeatureFlagsRepository } from '../admin/feature-flags.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { OrgFeatureFlagRow } from '../../common/database/schema.js';

/**
 * AI copilot shell (Module 16) over fakes with the **real** `authorize`: the two refusals that are
 * the whole of this slice's safety — the `copilot` flag off is a 404 with no answer, a caller
 * without `search.use` is a 403 with no answer — plus a well-formed, scope-aware answer view when
 * the flag is on, and the determinism of the offline stub.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';

function member(): Principal {
  return {
    userId: '00000000-0000-4000-8000-0000000000c1',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: ['00000000-0000-4000-8000-0000000000f1'],
    hasOrgWideScope: false,
  };
}

/** A client_viewer does not hold `search.use`, so the real authorize denies. */
function clientViewer(): Principal {
  return {
    ...member(),
    kind: 'client',
    role: 'client_viewer',
    clientOrganizationId: '00000000-0000-4000-8000-0000000000b1',
    projectIds: [],
  };
}

const context = { organizationId: ORG, membershipId: MEMBERSHIP } as unknown as TenantContext;

function flagRow(enabled: boolean): OrgFeatureFlagRow {
  return {
    id: 'f-1',
    organizationId: ORG,
    flagKey: 'copilot',
    enabled,
    updatedBy: MEMBERSHIP,
    updatedAt: new Date('2026-10-16T00:00:00.000Z'),
  };
}

class FakeRepo {
  constructor(readonly rows: OrgFeatureFlagRow[] = []) {}
  list(): Promise<OrgFeatureFlagRow[]> {
    return Promise.resolve(this.rows);
  }
}

function database(): TenantDatabase {
  return {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
}

function service(rows: OrgFeatureFlagRow[]): CopilotService {
  return new CopilotService(database(), new FakeRepo(rows) as unknown as FeatureFlagsRepository);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('CopilotService (AI copilot shell, Module 16)', () => {
  it('returns a well-formed answer view with evidence and a next safe action when the flag is on', async () => {
    const view = await service([flagRow(true)]).ask(context, member(), 'What is overdue?');
    expect(view.answer.length).toBeGreaterThan(0);
    expect(view.evidence.length).toBeGreaterThanOrEqual(1);
    for (const item of view.evidence) {
      expect(item.source.length).toBeGreaterThan(0);
      expect(item.link.startsWith('/')).toBe(true);
    }
    expect(view.nextSafeAction.length).toBeGreaterThan(0);
    expect(view.permissionBoundary.scope).toBe('assigned-projects');
    expect(view.provider).toBe('local-stub');
  });

  it('404s when the copilot flag is off (default), leaking no answer', async () => {
    await expectStatus(service([]).ask(context, member(), 'What is overdue?'), 404);
  });

  it('403s a caller without search.use (real authorize), even with the flag on', async () => {
    await expectStatus(service([flagRow(true)]).ask(context, clientViewer(), 'hi'), 403);
  });

  it('400s a blank question when the flag is on and the caller may use the copilot', async () => {
    await expectStatus(service([flagRow(true)]).ask(context, member(), '   '), 400);
  });

  it('gates the ask route with search.use', () => {
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, CopilotController.prototype.ask)).toBe(
      'search.use',
    );
  });
});

describe('LocalStubProvider', () => {
  it('is deterministic and performs no I/O for identical inputs', () => {
    const provider = new LocalStubProvider();
    const ctx = {
      principalKind: 'internal' as const,
      role: 'member' as const,
      hasOrgWideScope: false,
      reachableProjectCount: 2,
    };
    const first = provider.ask('Where are my approvals?', ctx);
    const second = provider.ask('Where are my approvals?', ctx);
    expect(second).toEqual(first);
    expect(first.evidence.length).toBeGreaterThanOrEqual(1);
  });
});
