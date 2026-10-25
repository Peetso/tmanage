import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { ApiError } from '../../common/http/errors.js';
import { SKIPS_TENANT } from '../../common/http/decorators.js';
import { ensureRequestState } from '../../common/http/request-state.js';
import type { MaintenanceWindowRow } from '../../common/database/schema.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { PlatformAdminGuard } from '../platform-admin/platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import {
  MaintenanceModule,
  PlatformMaintenanceController,
  PublicMaintenanceController,
} from './maintenance.controller.js';
import type { MaintenanceWindowsRepository } from './maintenance.repository.js';

/**
 * Platform states (x185) — the maintenance window, proved without a database.
 *
 * The properties that matter here are boundaries, so they are proved over fakes with the **real**
 * guard and the real validation: the public read shows only a published, currently-active window
 * and needs no session; the write is the platform operator's alone (F07: `@NoTenant()` behind
 * `PlatformAdminGuard`, no organization route), needs a typed reason, validates the severity enum
 * and the `startsAt<endsAt` order, and writes nothing on a bad body. The repository is a spy, so "no write" is a fact about the
 * call, not a mock of one.
 */

const OPERATOR: PlatformAdminActor = {
  account: {
    userId: 'user-0000-0000-0000-0000-0000000000ff',
    email: 'operator@tmanage.test',
    displayName: 'Operator',
    emailVerified: true,
    mfaEnabled: true,
  },
  sessionId: 'session-operator',
  stepUp: { expiresAt: new Date('2999-01-01T00:00:00.000Z'), mfaVerified: true },
};

const WINDOW_ID = '0199aa00-0000-7000-8000-0000000000ff';

function operatorRequest(): object {
  const request = { headers: {} };
  ensureRequestState(request);
  return request;
}

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
  const schedule = vi.fn(async () => ({
    id: WINDOW_ID,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  }));
  const unpublish = vi.fn(async () => true);
  const repository = { schedule, unpublish } as unknown as MaintenanceWindowsRepository;
  return { controller: new PlatformMaintenanceController(repository), schedule, unpublish };
}

const VALID = {
  message: 'Upgrading the database; some features are read-only.',
  severity: 'degraded',
  startsAt: '2999-01-01T00:00:00.000Z',
  endsAt: '2999-01-01T02:00:00.000Z',
  reason: 'Database upgrade window',
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

describe('PlatformMaintenanceController (F07: operator-only, audited)', () => {
  it('schedules exactly one window with the platform audit row for a platform admin', async () => {
    const { controller, schedule } = adminHarness();
    const view = await controller.schedule(OPERATOR, { ...VALID }, operatorRequest());
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'degraded', published: true }),
      expect.objectContaining({
        action: 'platform.maintenance_scheduled',
        actorUserId: OPERATOR.account.userId,
        actorEmail: OPERATOR.account.email,
        reason: VALID.reason,
      }),
    );
    expect(view.severity).toBe('degraded');
    expect(view.active).toBe(false); // starts in the far future
  });

  it('refuses a write without a typed reason with 400 and writes nothing', async () => {
    const { controller, schedule } = adminHarness();
    const { reason: _omit, ...withoutReason } = VALID;
    await controller
      .schedule(OPERATOR, withoutReason, operatorRequest())
      .catch((error: ApiError) => expect(error.status).toBe(400));
    expect(schedule).not.toHaveBeenCalled();
  });

  it('rejects an unknown severity with 400 and writes nothing', async () => {
    const { controller, schedule } = adminHarness();
    await controller
      .schedule(OPERATOR, { ...VALID, severity: 'catastrophe' }, operatorRequest())
      .catch((error: ApiError) => expect(error.status).toBe(400));
    expect(schedule).not.toHaveBeenCalled();
  });

  it('rejects startsAt >= endsAt with 400 and writes nothing', async () => {
    const { controller, schedule } = adminHarness();
    await controller
      .schedule(
        OPERATOR,
        { ...VALID, startsAt: '2999-01-01T02:00:00.000Z', endsAt: '2999-01-01T02:00:00.000Z' },
        operatorRequest(),
      )
      .catch((error: ApiError) => expect(error.status).toBe(400));
    expect(schedule).not.toHaveBeenCalled();
  });

  it('unpublishes a window with the audit row, and 404s an unknown window', async () => {
    const { controller, unpublish } = adminHarness();
    expect(
      await controller.unpublish(
        OPERATOR,
        WINDOW_ID,
        { reason: 'Window ended early' },
        operatorRequest(),
      ),
    ).toEqual({ unpublished: true });
    expect(unpublish).toHaveBeenCalledWith(
      WINDOW_ID,
      expect.objectContaining({ action: 'platform.maintenance_unpublished' }),
    );
    unpublish.mockResolvedValueOnce(false);
    await controller
      .unpublish(OPERATOR, WINDOW_ID, { reason: 'Window ended early' }, operatorRequest())
      .catch((error: ApiError) => expect(error.status).toBe(404));
  });
});

describe('wave9-S8 F07 regression: an organization owner cannot publish a platform banner', () => {
  it('no tenant route writes maintenance: the module serves no /v1/organizations/... path', () => {
    const registered = MaintenanceModule.register().controllers ?? [];
    const paths = registered.map((c) => Reflect.getMetadata('path', c as object) as string);
    expect(paths).toEqual(['public/site', 'v1/platform/maintenance']);
    // The only writer is behind PlatformAdminGuard and resolves no organization.
    const guards = Reflect.getMetadata(GUARDS_METADATA, PlatformMaintenanceController) as unknown[];
    expect(guards).toContain(PlatformAdminGuard);
    expect(Reflect.getMetadata(SKIPS_TENANT, PlatformMaintenanceController)).toBe(true);
  });

  it('PlatformAdminGuard refuses an organization owner who is not on the operator list (404)', async () => {
    const guard = new PlatformAdminGuard(new Reflector(), ['operator@tmanage.test'], {
      findAccount: async () => ({
        userId: 'user-owner',
        email: 'owner@customer.test',
        displayName: 'Owner',
        emailVerified: true,
        mfaEnabled: true,
      }),
      findLiveStepUp: async () => ({ expiresAt: new Date(), mfaVerified: true }),
    });
    const request = { headers: {} };
    const state = ensureRequestState(request);
    state.session = { sessionId: 's', userId: 'user-owner' } as NonNullable<typeof state.session>;
    state.authScheme = 'cookie';
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => PlatformMaintenanceController.prototype.schedule,
      getClass: () => PlatformMaintenanceController,
    } as unknown as ExecutionContext;
    const error = await guard.canActivate(context).catch((e: ApiError) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });
});
