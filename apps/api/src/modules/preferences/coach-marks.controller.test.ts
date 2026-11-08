import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { CoachMarksController } from './coach-marks.controller.js';
import type { CoachMarksRepository, CoachMarksState } from './coach-marks.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

const ME = '00000000-0000-4000-8000-0000000000e1';
const principal = { membershipId: ME, kind: 'internal' } as unknown as Principal;
const context = { organizationId: 'org', membershipId: ME } as unknown as TenantContext;

class FakeStore {
  readonly rows = new Map<string, CoachMarksState>();
  read(_r: unknown, _c: unknown, id: string): Promise<CoachMarksState> {
    return Promise.resolve(this.rows.get(id) ?? {});
  }
  merge(_r: unknown, _c: unknown, id: string, patch: CoachMarksState): Promise<void> {
    this.rows.set(id, { ...this.rows.get(id), ...patch });
    return Promise.resolve();
  }
}

function make(store = new FakeStore()) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return {
    store,
    controller: new CoachMarksController(database, store as unknown as CoachMarksRepository),
  };
}

describe('CoachMarksController (55-09)', () => {
  it('reads nothing seen when never saved', async () => {
    const { controller } = make();
    expect(await controller.get(context, principal)).toEqual({
      tours: { my_day: null, projects: null, work_board: null },
      neverAgain: false,
    });
  });

  it('merges one tour outcome without forgetting another, for the caller only', async () => {
    const { controller, store } = make();
    await controller.put(context, principal, { tour: 'my_day', outcome: 'done' });
    const view = await controller.put(context, principal, { tour: 'projects', outcome: 'skipped' });
    expect(view.tours).toEqual({ my_day: 'done', projects: 'skipped', work_board: null });
    expect([...store.rows.keys()]).toEqual([ME]);
  });

  it('stores never-again', async () => {
    const { controller } = make();
    expect((await controller.put(context, principal, { neverAgain: true })).neverAgain).toBe(true);
  });

  it('refuses an unknown tour or outcome with 400 and no write', async () => {
    const { controller, store } = make();
    for (const body of [{ tour: 'admin', outcome: 'done' }, { tour: 'my_day', outcome: 'x' }, {}]) {
      const error = await controller.put(context, principal, body).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(400);
    }
    expect(store.rows.size).toBe(0);
  });

  it('sits behind work.read', () => {
    for (const name of ['get', 'put'] as const) {
      expect(Reflect.getMetadata(REQUIRED_CAPABILITY, CoachMarksController.prototype[name])).toBe(
        'work.read',
      );
    }
  });
});
