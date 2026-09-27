import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import {
  PortalSettingsClientController,
  PortalSettingsController,
  parseSaveBody,
} from './portal-settings.controller.js';
import { PortalSettingsService } from './portal-settings.service.js';
import type { PortalSettingsInput } from './portal-settings.repository.js';
import type { PortalSettingsRepository } from './portal-settings.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PortalSettingsRow, ProjectRow } from '../../common/database/schema.js';

/**
 * SEC / Client portal settings (x238) — internal read/write and the client projection, over fakes with
 * **real** `authorize()`.
 *
 * The fakes stand in only for the database and the two repositories. `authorize()` is the real policy,
 * so these cases prove the actual security decisions: an internal manager may save and read the full
 * record (with `updatedBy`), a client reads only their own project's presentation fields (never
 * `updatedBy`), a cross-tenant `projectId` is a 404 with no write, and a client reading a project
 * outside their scope is a 404. The route-ceiling test pins the guard wiring that turns a caller
 * without `project.manage` into a 403. No DB in this suite (the chain owns the round-trip).
 */

const ORG = 'org-under-test';
const CLIENT_ORG = 'client-org-under-test';
const INTERNAL_USER = 'user-internal-1';
const PROJECT = 'project-visible';

function internalManager(): Principal {
  return {
    userId: INTERNAL_USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: 'membership-internal-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

function clientPrincipal(readableProjectId: string): Principal {
  return {
    userId: 'client-user-1',
    organizationId: ORG,
    kind: 'client',
    role: 'client_viewer',
    membershipId: 'membership-client-1',
    membershipStatus: 'active',
    clientOrganizationId: CLIENT_ORG,
    projectIds: [readableProjectId],
    hasOrgWideScope: false,
  };
}

const context = { organizationId: ORG, userId: INTERNAL_USER } as unknown as TenantContext;
const clientContext = { organizationId: ORG, userId: 'client-user-1' } as unknown as TenantContext;

/** A fake database whose `read` and `transaction` both run the unit of work with an ignored runner. */
function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
    transaction: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> =>
      work(runner),
  } as unknown as TenantDatabase;
}

/** A projects repo that resolves exactly the ids it was told exist (tenant-scoped `findById`). */
function fakeProjects(existing: readonly string[]): ProjectsRepository {
  return {
    findById: (_r: never, _c: TenantContext, id: string) =>
      Promise.resolve(existing.includes(id) ? ({ id } as unknown as ProjectRow) : null),
  } as unknown as ProjectsRepository;
}

/** A stateful settings store: `upsert` replaces the one row per project, `findForProject` reads it. */
function fakeSettings(): {
  repo: PortalSettingsRepository;
  saved: { projectId: string; input: PortalSettingsInput }[];
} {
  const rows = new Map<string, PortalSettingsRow>();
  const saved: { projectId: string; input: PortalSettingsInput }[] = [];
  const repo = {
    findForProject: (_r: never, _c: TenantContext, projectId: string) =>
      Promise.resolve(rows.get(projectId) ?? null),
    upsert: (_r: never, _c: TenantContext, projectId: string, input: PortalSettingsInput) => {
      saved.push({ projectId, input });
      const existing = rows.get(projectId);
      const row = {
        id: existing?.id ?? `ps-${projectId}`,
        organizationId: ORG,
        projectId,
        welcomeMessage: input.welcomeMessage,
        accentColor: input.accentColor,
        showTeam: input.showTeam,
        showTimeline: input.showTimeline,
        updatedBy: input.updatedBy,
        createdAt: existing?.createdAt ?? new Date('2026-09-01T00:00:00.000Z'),
        updatedAt: new Date('2026-09-27T00:00:00.000Z'),
      } as unknown as PortalSettingsRow;
      rows.set(projectId, row);
      return Promise.resolve(row);
    },
  } as unknown as PortalSettingsRepository;
  return { repo, saved };
}

function serviceFor(
  existingProjects: readonly string[],
  settings: ReturnType<typeof fakeSettings>,
): PortalSettingsService {
  return new PortalSettingsService(fakeDatabase(), fakeProjects(existingProjects), settings.repo);
}

describe('PortalSettingsService (x238)', () => {
  it('saves as the context user and reads back the full internal record, including updatedBy', async () => {
    const store = fakeSettings();
    const service = serviceFor([PROJECT], store);

    const saved = await service.save(context, internalManager(), PROJECT, {
      welcomeMessage: 'Welcome to your project portal.',
      accentColor: '#7c3aed',
      showTeam: true,
      showTimeline: false,
    });

    // The author is the context user, never a body field.
    expect(store.saved[0]?.input.updatedBy).toBe(INTERNAL_USER);
    expect(saved).toMatchObject({
      projectId: PROJECT,
      welcomeMessage: 'Welcome to your project portal.',
      accentColor: '#7c3aed',
      showTeam: true,
      showTimeline: false,
      updatedBy: INTERNAL_USER,
    });

    const read = await service.getInternal(context, internalManager(), PROJECT);
    expect(read.welcomeMessage).toBe('Welcome to your project portal.');
    expect(read.updatedBy).toBe(INTERNAL_USER);
  });

  it('projects only the presentation fields to a client, never updatedBy or timestamps', async () => {
    const store = fakeSettings();
    const service = serviceFor([PROJECT], store);
    await service.save(context, internalManager(), PROJECT, {
      welcomeMessage: 'Hello',
      accentColor: '#059669',
      showTeam: false,
      showTimeline: true,
    });

    const seen = await service.getForClient(clientContext, clientPrincipal(PROJECT), PROJECT);

    expect(Object.keys(seen).sort()).toEqual(
      ['accentColor', 'showTeam', 'showTimeline', 'welcomeMessage'].sort(),
    );
    expect(seen).not.toHaveProperty('updatedBy');
    expect(seen).not.toHaveProperty('updatedAt');
    expect(seen).not.toHaveProperty('projectId');
    expect(seen.accentColor).toBe('#059669');
  });

  it('reads defaults (no updatedBy) for a project that has never been configured', async () => {
    const store = fakeSettings();
    const service = serviceFor([PROJECT], store);

    const read = await service.getInternal(context, internalManager(), PROJECT);
    expect(read).toMatchObject({
      projectId: PROJECT,
      welcomeMessage: null,
      accentColor: '#2563eb',
      showTeam: true,
      showTimeline: true,
      updatedBy: null,
      updatedAt: null,
    });
  });

  it('answers 404 and writes nothing for an unknown or cross-tenant projectId', async () => {
    const store = fakeSettings();
    const service = serviceFor([PROJECT], store); // the named project does NOT exist

    await expect(
      service.save(context, internalManager(), 'project-elsewhere', {
        welcomeMessage: 'x',
        accentColor: '#2563eb',
        showTeam: true,
        showTimeline: true,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(store.saved).toHaveLength(0);
  });

  it('answers 404 and writes nothing when the caller cannot manage the project', async () => {
    const store = fakeSettings();
    const service = serviceFor([PROJECT], store);

    // A client principal never holds `project.manage`; the project resolves, authorize denies.
    await expect(
      service.save(context, clientPrincipal(PROJECT), PROJECT, {
        welcomeMessage: 'x',
        accentColor: '#2563eb',
        showTeam: true,
        showTimeline: true,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(store.saved).toHaveLength(0);
  });

  it('answers 404 when a client reads a project outside their own scope', async () => {
    const store = fakeSettings();
    const service = serviceFor([PROJECT], store);

    await expect(
      service.getForClient(clientContext, clientPrincipal(PROJECT), 'project-someone-elses'),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('portal settings body validation (x238)', () => {
  it('rejects an off-palette accent colour with 400', () => {
    expect(() => parseSaveBody({ accentColor: '#123456' })).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
  });

  it('rejects an oversize welcome message with 400', () => {
    expect(() => parseSaveBody({ welcomeMessage: 'a'.repeat(2001) })).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
  });

  it('accepts a palette accent, bounded message and toggles, defaulting the rest', () => {
    expect(parseSaveBody({ accentColor: '#dc2626', showTeam: false })).toEqual({
      welcomeMessage: null,
      accentColor: '#dc2626',
      showTeam: false,
      showTimeline: true,
    });
  });
});

/**
 * The route-ceiling that produces the client → 403 on the internal path.
 *
 * A client role never holds `project.manage`, so `CapabilityGuard` refuses the internal routes with
 * 403 before the handler runs — the guard reads exactly the `@RequireCapability` metadata asserted
 * here. The client route requires `client_projection.read` instead. The live 403/guard round-trip is
 * the chain's e2e; this pins the wiring the guard depends on.
 */
describe('portal settings route capabilities', () => {
  const capabilityOf = (proto: object, key: string): unknown =>
    Reflect.getMetadata(REQUIRED_CAPABILITY, (proto as Record<string, unknown>)[key] as object);

  it('guards the internal get and save with project.manage', () => {
    expect(capabilityOf(PortalSettingsController.prototype, 'get')).toBe('project.manage');
    expect(capabilityOf(PortalSettingsController.prototype, 'save')).toBe('project.manage');
  });

  it('guards the client projection with client_projection.read', () => {
    expect(capabilityOf(PortalSettingsClientController.prototype, 'get')).toBe(
      'client_projection.read',
    );
  });
});
