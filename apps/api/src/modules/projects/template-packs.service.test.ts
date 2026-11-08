import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { TemplatePacksService } from './template-packs.service.js';
import { DuplicateProjectTemplateNameError } from './templates.repository.js';
import type {
  CreateProjectTemplateInput,
  ProjectTemplatesRepository,
} from './templates.repository.js';
import type { TemplatePacksRepository } from './template-packs.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { TemplatePackRow } from '../../common/database/schema.js';

/** 54-22. The template-packs service over fakes, with the real `authorize()` evaluator. */

const ORG = 'organization-0000-0000-0000-000000000001';
const context = { organizationId: ORG, userId: 'user-1' } as unknown as TenantContext;

function principal(role: Principal['role']): Principal {
  return {
    userId: 'user-1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: role === 'owner',
  };
}

function build(existingTemplateNames: readonly string[] = []) {
  const installs: TemplatePackRow[] = [];
  const created: CreateProjectTemplateInput[] = [];
  const database = {
    read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const packs = {
    listInstalled: async () => installs,
    findByKey: async (_r: unknown, _c: unknown, key: string) =>
      installs.find((row) => row.packKey === key) ?? null,
    recordInstall: async (
      _r: unknown,
      _c: unknown,
      input: { packKey: string; templatesCreated: number },
    ) => {
      installs.push({
        id: `pack-${installs.length}`,
        organizationId: ORG,
        packKey: input.packKey,
        templatesCreated: input.templatesCreated,
        installedBy: 'user-1',
        installedAt: new Date('2026-11-08T10:00:00.000Z'),
      });
    },
  } as unknown as TemplatePacksRepository;
  const templates = {
    create: async (_r: unknown, _c: unknown, input: CreateProjectTemplateInput) => {
      if (existingTemplateNames.includes(input.name)) {
        throw new DuplicateProjectTemplateNameError(input.name);
      }
      created.push(input);
      return {};
    },
  } as unknown as ProjectTemplatesRepository;
  return { service: new TemplatePacksService(database, packs, templates), installs, created };
}

describe('TemplatePacksService (54-22)', () => {
  it('lists the built-in packs with their install state', async () => {
    const { service } = build();
    await service.install(context, principal('owner'), 'monthly-retainer');
    const packs = await service.list(context, principal('owner'));
    expect(packs.length).toBeGreaterThanOrEqual(3);
    expect(packs.find((pack) => pack.key === 'monthly-retainer')?.installed).toBe(true);
    expect(packs.find((pack) => pack.key === 'agency-client-launch')?.installed).toBe(false);
  });

  it('narrows the gallery to one role and carries language and work week (55-02, 54-23)', async () => {
    const { service } = build();
    const packs = await service.list(context, principal('owner'), 'marketing');
    expect(packs.map((pack) => pack.key)).toEqual(['starter-marketing', 'ar-agency-gulf']);
    expect(packs[1]).toMatchObject({ language: 'ar', workWeek: 'sun_thu' });
    expect(packs.every((pack) => pack.roles.includes('marketing'))).toBe(true);
  });

  it('installs a pack by creating its templates, skipping names already in use', async () => {
    const { service, created, installs } = build(['Brand sprint']);
    const result = await service.install(context, principal('owner'), 'agency-client-launch');
    expect(created.map((input) => input.name)).toEqual(['Client kick-off', 'Website launch']);
    expect(created[0]?.description).toContain('Creative brief');
    expect(result).toMatchObject({ templatesCreated: 2, templatesSkipped: 1 });
    expect(installs).toHaveLength(1);
  });

  it('refuses a second install, an unknown pack, and a role that cannot manage templates', async () => {
    const { service } = build();
    await service.install(context, principal('owner'), 'product-sprint-kit');
    await expect(
      service.install(context, principal('owner'), 'product-sprint-kit'),
    ).rejects.toMatchObject({ status: 409 });
    await expect(service.install(context, principal('owner'), 'nope')).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.install(context, principal('member'), 'monthly-retainer'),
    ).rejects.toMatchObject({ status: 403 });
  });
});
