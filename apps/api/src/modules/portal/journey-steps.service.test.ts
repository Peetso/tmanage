import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { TemplatePacksRepository } from '../projects/template-packs.repository.js';
import type { JourneyStepsRepository } from './journey-steps.repository.js';
import { JourneyStepsService } from './journey-steps.service.js';

const owner = {
  kind: 'internal',
  role: 'owner',
  organizationId: 'org',
  clientOrganizationId: null,
  projectIds: ['p1'],
  hasOrgWideScope: true,
  membershipStatus: 'active',
} as unknown as Principal;
const context = { organizationId: 'org', userId: 'u1' } as TenantContext;
const database = {
  read: (_: unknown, work: (runner: unknown) => unknown) => work({}),
  transaction: (_: unknown, work: (runner: unknown) => unknown) => work({}),
} as unknown as TenantDatabase;

function service(installed: boolean, refBelongs: boolean, appended: unknown[][]) {
  const steps = {
    isProjectClient: () => Promise.resolve(true),
    refBelongs: () => Promise.resolve(refBelongs),
    listForClient: () => Promise.resolve([]),
    append: (_r: unknown, _c: unknown, rows: unknown[]) => (
      appended.push(rows),
      Promise.resolve([])
    ),
  } as unknown as JourneyStepsRepository;
  const packs = {
    findByKey: () => Promise.resolve(installed ? { packKey: 'agency-client-launch' } : null),
  } as unknown as TemplatePacksRepository;
  return new JourneyStepsService(database, steps, packs);
}

const template = {
  clientOrganizationId: 'c1',
  packKey: 'agency-client-launch',
  templateKey: 'new-client-onboarding',
};

describe('52-27 journey steps (studio)', () => {
  it('applies a journey template only from an installed pack', async () => {
    await expect(
      service(false, true, []).applyTemplate(context, owner, 'p1', template),
    ).rejects.toMatchObject({
      status: 404,
    });
    const appended: unknown[][] = [];
    await service(true, true, appended).applyTemplate(context, owner, 'p1', template);
    expect(appended[0]?.map((row) => (row as { kind: string }).kind)).toEqual([
      'form',
      'upload',
      'sign',
      'meeting',
    ]);
  });

  it("refuses to link a step to another project's object", async () => {
    const appended: unknown[][] = [];
    const body = { clientOrganizationId: 'c1', kind: 'sign', title: 'Sign', refId: 'req-x' };
    await expect(
      service(true, false, appended).create(context, owner, 'p1', body),
    ).rejects.toMatchObject({
      status: 400,
    });
    expect(appended).toEqual([]);
  });
});
