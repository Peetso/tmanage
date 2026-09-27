import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { Principal, Role } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { MaintenanceWindowRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  AdminMaintenanceController,
  PublicMaintenanceController,
} from './maintenance.controller.js';
import type { MaintenanceWindowsRepository } from './maintenance.repository.js';

/**
 * Platform states (x185) — the maintenance window, proved without a database.
 *
 * The properties that matter here are boundaries, so they are proved over fakes with the **real**
 * authorize and the real validation: the public read shows only a published, currently-active window
 * and needs no session; the admin write is `org.manage` (a privileged `org_admin` that lacks it is
 * refused, because the flag is platform-wide), validates the severity enum and the `startsAt<endsAt`
 * order, and writes nothing on a bad body. The repository is a spy, so "no write" is a fact about the
 * call, not a mock of one.
 */

const ORG = 'organization-0000-0000-0000-000000000001';

function principal(role: Role, overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-0000000000aa',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
    ...overrides,
  } as Principal;
}

const context = { organizationId: ORG } as unknown as TenantContext;

/** A window that is active against the controller's real clock: started in the past, ends far ahead. */
function windowRow(overrides: Partial<MaintenanceWindowRow> = {}): MaintenanceWindowRow {
  return {
    id: '0199aa00-0000-7000-8000-0000000000f0',
    message: 'Scheduled maintenance',
    severity: 'degraded',
    startsAt: new Date('2000-01-01T00:00:00.000Z'),
    endsAt: new Date('2999-01-01T00:00:00.000Z'),
    published: true,
    createdAt: new Date('2000-01-01T00:00:00.000Z'),
    ...overrides,
  } as MaintenanceWindowRow;
}

function publicHarness(rows: readonly MaintenanceWindowRow[]) {
  const listPublishableWindows = vi.fn(async () => rows);
  const repository = { listPublishableWindows } as unknown as MaintenanceWindowsRepository;
  const database = {
    identityRead: async <T>(_opts: unknown, work: (runner: unknown) => Promise<T>): Promise<T> =>
      work({}),
  } as unknown as TenantDatabase;
  return {
    controller: new PublicMaintenanceController(database, repository),
    listPublishableWindows,
  };
}

function adminHarness() {
  const insert = vi.fn(async () => ({
    id: '0199aa00-0000-7000-8000-0000000000ff',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  }));
  const repository = { insert } as unknown as MaintenanceWindowsRepository;
  return { controller: new AdminMaintenanceController(repository), insert };
}

const VALID = {
  message: 'Upgrading the database; some features are read-only.',
  severity: 'degraded',
  startsAt: '2999-01-01T00:00:00.000Z',
  endsAt: '2999-01-01T02:00:00.000Z',
};

describe('PublicMaintenanceController.current', () => {
  it('returns the current active window with no session, and marks it active', async () => {
    const { controller } = publicHarness([windowRow()]);
    const view = await controller.current();
    expect(view.window).not.toBeNull();
    expect(view.window?.severity).toBe('degraded');
    expect(view.window?.id).toBe('0199aa00-0000-7000-8000-0000000000f0');
    expect(view.window?.active).toBe(true);
  });

  it('returns no window when nothing published is active', async () => {
    const { controller } = publicHarness([]);
    const view = await controller.current();
    expect(view.window).toBeNull();
    expect(typeof view.asOf).toBe('string');
  });
});

describe('AdminMaintenanceController.schedule', () => {
  it('schedules exactly one window for a valid request (org.manage)', async () => {
    const { controller, insert } = adminHarness();
    const view = await controller.schedule(context, principal('owner'), { ...VALID });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'degraded', published: true }),
    );
    expect(view.severity).toBe('degraded');
    expect(view.active).toBe(false); // starts in the far future
  });

  it('refuses a caller without org.manage with 403 and writes nothing', async () => {
    const { controller, insert } = adminHarness();
    // org_admin holds every capability except org.manage — the platform-wide toggle is still refused.
    await expect(
      controller.schedule(context, principal('org_admin'), { ...VALID }),
    ).rejects.toThrow(ApiError);
    await controller
      .schedule(context, principal('org_admin'), { ...VALID })
      .catch((error: ApiError) => expect(error.status).toBe(403));
    expect(insert).not.toHaveBeenCalled();
  });

  it('rejects an unknown severity with 400 and writes nothing', async () => {
    const { controller, insert } = adminHarness();
    await controller
      .schedule(context, principal('owner'), { ...VALID, severity: 'catastrophe' })
      .catch((error: ApiError) => expect(error.status).toBe(400));
    expect(insert).not.toHaveBeenCalled();
  });

  it('rejects startsAt >= endsAt with 400 and writes nothing', async () => {
    const { controller, insert } = adminHarness();
    await controller
      .schedule(context, principal('owner'), {
        ...VALID,
        startsAt: '2999-01-01T02:00:00.000Z',
        endsAt: '2999-01-01T02:00:00.000Z',
      })
      .catch((error: ApiError) => expect(error.status).toBe(400));
    expect(insert).not.toHaveBeenCalled();
  });
});
