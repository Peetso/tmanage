import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PlatformPermission } from '@tmanage/domain';
import { ensureRequestState } from '../../../common/http/request-state.js';
import { PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor, PlatformAdminLookup } from '../platform-admin.guard.js';
import type { PlatformAuditInput } from '../platform-admin.repository.js';
import { PlatformIncidentsController } from './incidents.controller.js';
import type {
  IncidentGuard,
  IncidentInput,
  IncidentRecord,
  PlatformIncidentsRepository,
} from './incidents.repository.js';
import { PlatformIncidentsService } from './incidents.service.js';

const USER = '0199aa00-0000-7000-8000-0000000000c1';
const ORG = '0199aa00-0000-7000-8000-0000000000aa';
const ID = '0199aa00-0000-7000-8000-0000000000e1';
const NOW = new Date('2026-11-02T10:00:00.000Z');
const CONTEXT = { correlationId: 'corr', ip: null, userAgent: null };
const ACTOR = { account: { userId: USER, email: 'ops@example.com' } } as PlatformAdminActor;

async function guardStatus(permissions: PlatformPermission[]): Promise<number> {
  const lookup: PlatformAdminLookup = {
    findAccount: async () => ({
      userId: USER,
      email: 'ops@example.com',
      displayName: 'O',
      emailVerified: true,
      mfaEnabled: true,
    }),
    findLiveStepUp: async () => ({ expiresAt: new Date(Date.now() + 600_000), mfaVerified: true }),
    findPlatformAdmin: async () => ({
      id: 'admin-1',
      userId: USER,
      preset: 'support',
      customPermissions: null,
      permissions,
      status: 'active',
    }),
    hasActivePlatformAdmins: async () => true,
  };
  const guard = new PlatformAdminGuard(new Reflector(), [], lookup);
  const request = { headers: {} };
  const state = ensureRequestState(request);
  state.session = { sessionId: 's', userId: USER };
  state.authScheme = 'cookie';
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => PlatformIncidentsController.prototype.create,
    getClass: () => PlatformIncidentsController,
  } as unknown as ExecutionContext;
  return guard.canActivate(context).then(
    () => 200,
    (error: { status: number }) => error.status,
  );
}

/** An in-memory register: one row, the audit rows it was asked to write. */
function fakeRepository(seed: IncidentRecord | null) {
  let row = seed;
  const audits: PlatformAuditInput[] = [];
  const repository = {
    list: async () => (row ? [row] : []),
    find: async () => row,
    create: async (
      input: IncidentInput,
      createdBy: string,
      audit: (id: string) => PlatformAuditInput,
    ) => {
      audits.push(audit(ID));
      row = { ...input, id: ID, published: false, createdBy, createdAt: NOW, updatedAt: NOW };
      return ID;
    },
    resolve: async (_id: string, at: Date, guard: IncidentGuard, audit: PlatformAuditInput) => {
      if (!row) return false;
      guard(row);
      audits.push(audit);
      row = { ...row, status: 'resolved', resolvedAt: at };
      return true;
    },
  } as unknown as PlatformIncidentsRepository;
  return { repository, audits };
}

describe('56-13 platform incident register', () => {
  it('refuses a principal without platform.settings.edit (403) and admits one with it', async () => {
    expect(await guardStatus(['platform.orgs.view'])).toBe(403);
    expect(await guardStatus(['platform.settings.edit'])).toBe(200);
  });

  it('creates unpublished with detected_at = now, the clocks, and an audit row with no org names', async () => {
    const { repository, audits } = fakeRepository(null);
    const view = await new PlatformIncidentsService(repository, () => NOW).create(
      ACTOR,
      {
        severity: 'SEV1',
        component: 'API',
        title: 'Files readable across tenants',
        body: 'We are investigating.',
        affectedOrgIds: [ORG],
        countries: ['sa', 'EG'],
        personalData: true,
      },
      CONTEXT,
    );
    expect(view.published).toBe(false);
    expect(view.detectedAt).toBe(NOW.toISOString());
    expect(view.clocks.authority.map((c) => c.jurisdiction)).toEqual(['SA', 'EG']);
    expect(view.clocks.customers?.dueAt).toBe('2026-11-04T10:00:00.000Z');
    const [audit] = audits;
    expect(audit?.action).toBe('platform.incident_created');
    expect(JSON.parse(audit?.afterJson ?? '{}')).toMatchObject({ severity: 'SEV1' });
    expect(audit?.afterJson).not.toMatch(/Files readable|investigating\./u);
    expect(audit?.targetLabel).toBe('SEV1');
  });

  it('refuses resolve with 422 clock_open while a notice is owed, and writes nothing', async () => {
    const open: IncidentRecord = {
      id: ID,
      component: 'API',
      status: 'identified',
      title: 't',
      body: 'b',
      startedAt: NOW,
      resolvedAt: null,
      severity: 'SEV0',
      detectedAt: NOW,
      containedAt: NOW,
      affectedOrgIds: [ORG],
      dataCategories: ['email'],
      countries: ['DE'],
      personalData: true,
      notifiedAuthorityAt: null,
      notifiedCustomersAt: NOW,
      postmortemUrl: null,
      published: true,
      createdBy: USER,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const { repository, audits } = fakeRepository(open);
    const service = new PlatformIncidentsService(repository, () => NOW);
    await expect(service.resolve(ACTOR, ID, {}, CONTEXT)).rejects.toMatchObject({
      status: 422,
      code: 'clock_open',
    });
    expect(audits).toHaveLength(0);
    const resolved = await service.resolve(
      ACTOR,
      ID,
      { authorityNotRequiredReason: 'Encrypted at rest; key not exposed.' },
      CONTEXT,
    );
    expect(resolved.status).toBe('resolved');
    expect(audits[0]?.action).toBe('platform.incident_resolved');
  });
});
