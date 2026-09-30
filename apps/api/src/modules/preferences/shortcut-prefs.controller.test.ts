import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ShortcutPrefsController } from './shortcut-prefs.controller.js';
import { DEFAULT_SHORTCUTS } from './shortcut-prefs.service.js';
import type { ShortcutPrefsRepository } from './shortcut-prefs.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { UserShortcutPrefRow } from '../../common/database/schema.js';

/**
 * PRF keyboard shortcuts (x286) — read/rebind/reset over fakes, always the caller's own membership.
 *
 * The database is faked; the properties proved are the ones the HTTP surface owns: the resolved map
 * overlays overrides on the shipped defaults, a rebind persists scoped to `principal.membershipId`, an
 * unknown action key is a 400 with no upsert, a malformed chord is a 400 with no upsert, a reset is an
 * idempotent scoped delete, and every route sits behind `work.read`. The refusal that matters — an
 * unknown action key writes nothing, and a write can only ever name the caller's own membership — is
 * proved directly.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const MY_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';
const OTHER_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e2';

function member(): Principal {
  return {
    userId: '00000000-0000-4000-8000-0000000000c1',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: MY_MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: false,
  };
}

const context = { organizationId: ORG, membershipId: MY_MEMBERSHIP } as unknown as TenantContext;

class FakeShortcutPrefsRepository {
  /** membershipId -> (actionKey -> chord) */
  readonly rows = new Map<string, Map<string, string>>();
  upsertCalls: { membershipId: string; actionKey: string; chord: string }[] = [];
  removeCalls: { membershipId: string; actionKey: string }[] = [];

  listForMembership(
    _r: unknown,
    _c: unknown,
    membershipId: string,
  ): Promise<UserShortcutPrefRow[]> {
    const overrides = this.rows.get(membershipId) ?? new Map<string, string>();
    const list = [...overrides].map(
      ([actionKey, chord]) => ({ actionKey, chord }) as UserShortcutPrefRow,
    );
    return Promise.resolve(list);
  }

  upsert(
    _r: unknown,
    _c: unknown,
    membershipId: string,
    actionKey: string,
    chord: string,
  ): Promise<void> {
    this.upsertCalls.push({ membershipId, actionKey, chord });
    const overrides = this.rows.get(membershipId) ?? new Map<string, string>();
    overrides.set(actionKey, chord);
    this.rows.set(membershipId, overrides);
    return Promise.resolve();
  }

  remove(_r: unknown, _c: unknown, membershipId: string, actionKey: string): Promise<void> {
    this.removeCalls.push({ membershipId, actionKey });
    this.rows.get(membershipId)?.delete(actionKey);
    return Promise.resolve();
  }
}

function controllerWith(service: FakeShortcutPrefsRepository): ShortcutPrefsController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new ShortcutPrefsController(database, service as unknown as ShortcutPrefsRepository);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('ShortcutPrefsController (PRF keyboard shortcuts, x286)', () => {
  it('resolves the shipped defaults when the member has no overrides', async () => {
    const { shortcuts } = await controllerWith(new FakeShortcutPrefsRepository()).get(
      context,
      member(),
    );
    const home = shortcuts.find((s) => s.actionKey === 'nav-home');
    expect(home?.chord).toBe(DEFAULT_SHORTCUTS['nav-home']);
    expect(home?.overridden).toBe(false);
    expect(shortcuts.every((s) => s.chord.length > 0)).toBe(true);
  });

  it('persists a valid rebind scoped to the caller and overlays it on read', async () => {
    const service = new FakeShortcutPrefsRepository();
    const controller = controllerWith(service);

    const saved = await controller.put(context, member(), 'nav-home', { chord: 'Ctrl+Alt+1' });
    expect(saved).toEqual({ actionKey: 'nav-home', chord: 'Ctrl+Alt+1' });
    expect(service.upsertCalls).toHaveLength(1);
    expect(service.upsertCalls[0]!.membershipId).toBe(MY_MEMBERSHIP);

    const { shortcuts } = await controller.get(context, member());
    const home = shortcuts.find((s) => s.actionKey === 'nav-home');
    expect(home?.chord).toBe('Ctrl+Alt+1');
    expect(home?.overridden).toBe(true);
  });

  it('400s an unknown action key and writes nothing (the refusal that matters)', async () => {
    const service = new FakeShortcutPrefsRepository();
    await expectStatus(
      controllerWith(service).put(context, member(), 'nav-nonexistent', { chord: 'Ctrl+K' }),
      400,
    );
    expect(service.upsertCalls).toHaveLength(0);
  });

  it('400s a malformed chord and writes nothing', async () => {
    const service = new FakeShortcutPrefsRepository();
    for (const bad of ['', 'Ctrl+Ctrl+K', 'Hyper+K', 'Ctrl+', 'Ctrl+ab']) {
      await expectStatus(
        controllerWith(service).put(context, member(), 'act-search', { chord: bad }),
        400,
      );
    }
    await expectStatus(
      controllerWith(service).put(context, member(), 'act-search', {} as unknown),
      400,
    );
    expect(service.upsertCalls).toHaveLength(0);
  });

  it('does not read or write another membership — the subject is always the principal', async () => {
    const service = new FakeShortcutPrefsRepository();
    service.rows.set(OTHER_MEMBERSHIP, new Map([['nav-home', 'Ctrl+Alt+9']]));

    // The caller has no override → the default, never the other member's stored chord.
    const { shortcuts } = await controllerWith(service).get(context, member());
    expect(shortcuts.find((s) => s.actionKey === 'nav-home')?.chord).toBe(
      DEFAULT_SHORTCUTS['nav-home'],
    );

    // A rebind writes only to the caller's membership — there is no path or body to redirect it.
    await controllerWith(service).put(context, member(), 'nav-home', { chord: 'Ctrl+Alt+2' });
    expect(service.upsertCalls.every((c) => c.membershipId === MY_MEMBERSHIP)).toBe(true);
    expect(service.rows.get(OTHER_MEMBERSHIP)?.get('nav-home')).toBe('Ctrl+Alt+9');
  });

  it('reset is an idempotent delete scoped to the caller', async () => {
    const service = new FakeShortcutPrefsRepository();
    await controllerWith(service).remove(context, member(), 'nav-home');
    await controllerWith(service).remove(context, member(), 'nav-home');
    expect(service.removeCalls).toHaveLength(2);
    expect(service.removeCalls.every((c) => c.membershipId === MY_MEMBERSHIP)).toBe(true);
  });

  it('guards every route with work.read, so a caller without it is refused 403 by CapabilityGuard', () => {
    for (const method of ['get', 'put', 'remove'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        ShortcutPrefsController.prototype[method],
      );
      expect(capability).toBe('work.read');
    }
  });
});
