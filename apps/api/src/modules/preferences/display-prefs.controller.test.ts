import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { DisplayPreferencesController } from './display-prefs.controller.js';
import { DEFAULT_DISPLAY_PREFERENCES, DisplayPreferencesService } from './display-prefs.service.js';
import type { DisplayPreferencesRepository } from './display-prefs.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { DisplayPreferences, UserDisplayPreferenceRow } from '../../common/database/schema.js';

/**
 * PREF-DISPLAY display preferences (x285) — read/upsert over fakes, always the caller's own.
 *
 * The database is faked; the properties proved are the ones the HTTP surface owns and nothing else
 * does: absence reads the shipped defaults, a valid save persists and reads back, a value off any
 * closed vocabulary is rejected (400, no write), the subject is `principal.membershipId` and never a
 * body value (so no caller can write another membership's row — the refusal the brief requires), and
 * both routes sit behind `work.read` (a caller without it is refused 403 by `CapabilityGuard`,
 * asserted through the route metadata the guard reads).
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

const VALID: DisplayPreferences = {
  theme: 'dark',
  density: 'compact',
  locale: 'fr-FR',
  timezone: 'Europe/Paris',
  dateFormat: 'eu',
};

/** An in-memory store keyed by membership, so a save is visible to the read-back it does. */
class FakeDisplayPreferencesRepository {
  readonly rows = new Map<string, DisplayPreferences>();
  upsertCalls: { membershipId: string; settings: DisplayPreferences }[] = [];

  findForMembership(
    _r: unknown,
    _c: unknown,
    membershipId: string,
  ): Promise<UserDisplayPreferenceRow | null> {
    const settings = this.rows.get(membershipId);
    return Promise.resolve(
      settings ? ({ displayJson: settings } as UserDisplayPreferenceRow) : null,
    );
  }

  upsert(
    _r: unknown,
    _c: unknown,
    membershipId: string,
    settings: DisplayPreferences,
  ): Promise<void> {
    this.upsertCalls.push({ membershipId, settings });
    this.rows.set(membershipId, settings);
    return Promise.resolve();
  }
}

function controllerWith(repo: FakeDisplayPreferencesRepository): DisplayPreferencesController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const service = new DisplayPreferencesService(
    database,
    repo as unknown as DisplayPreferencesRepository,
  );
  return new DisplayPreferencesController(service);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('DisplayPreferencesController (PREF-DISPLAY, x285)', () => {
  it('reads the shipped defaults when the member has never saved', async () => {
    const repo = new FakeDisplayPreferencesRepository();
    const result = await controllerWith(repo).get(context, member());
    expect(result).toEqual(DEFAULT_DISPLAY_PREFERENCES);
  });

  it('persists a valid update and reads it back — always the caller’s own membership', async () => {
    const repo = new FakeDisplayPreferencesRepository();
    const controller = controllerWith(repo);

    const saved = await controller.put(context, member(), { ...VALID });
    expect(saved).toEqual({ ...VALID, numerals: 'latin', calendarDisplay: 'gregorian' });

    // The subject is the authenticated principal's membership, never a value the request named.
    expect(repo.upsertCalls).toHaveLength(1);
    expect(repo.upsertCalls[0]!.membershipId).toBe(MY_MEMBERSHIP);

    const readBack = await controller.get(context, member());
    expect(readBack).toEqual({ ...VALID, numerals: 'latin', calendarDisplay: 'gregorian' });
  });

  it('accepts any IANA time zone, not a short allow-list (R9: every country)', async () => {
    const repo = new FakeDisplayPreferencesRepository();
    for (const timezone of ['Africa/Cairo', 'Asia/Riyadh', 'Asia/Kolkata', 'Pacific/Chatham']) {
      const saved = await controllerWith(repo).put(context, member(), { ...VALID, timezone });
      expect(saved.timezone).toBe(timezone);
    }
  });

  it('400s a theme off the closed vocabulary and writes nothing', async () => {
    const repo = new FakeDisplayPreferencesRepository();
    await expectStatus(
      controllerWith(repo).put(context, member(), { ...VALID, theme: 'neon' }),
      400,
    );
    expect(repo.upsertCalls).toHaveLength(0);
  });

  it('400s an off-allowlist locale / timezone / date format and writes nothing', async () => {
    const repo = new FakeDisplayPreferencesRepository();
    await expectStatus(
      controllerWith(repo).put(context, member(), {
        ...VALID,
        locale: 'xx-YY',
        timezone: 'Mars/Phobos',
        dateFormat: 'runic',
      }),
      400,
    );
    expect(repo.upsertCalls).toHaveLength(0);
  });

  it('400s a body naming another membership and writes nothing — the write stays the caller’s own', async () => {
    const repo = new FakeDisplayPreferencesRepository();
    // `membershipId` is exactly the field a caller might try to redirect the write with — it is not a
    // known preference, so it is a 400 and the subject stays the authenticated principal's.
    await expectStatus(
      controllerWith(repo).put(context, member(), {
        ...VALID,
        membershipId: OTHER_MEMBERSHIP,
      }),
      400,
    );
    expect(repo.upsertCalls).toHaveLength(0);
  });

  it('guards both routes with work.read, so a caller without it is refused 403 by CapabilityGuard', () => {
    for (const method of ['get', 'put'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        DisplayPreferencesController.prototype[method],
      );
      expect(capability).toBe('work.read');
    }
  });

  it('55-07: numerals/calendarDisplay are validated, saved, and default on an old row', async () => {
    const repo = new FakeDisplayPreferencesRepository();
    // An old row without the keys reads the defaults.
    repo.rows.set(MY_MEMBERSHIP, { ...VALID });
    const old = await controllerWith(repo).get(context, member());
    expect(old.numerals).toBe('latin');
    expect(old.calendarDisplay).toBe('gregorian');

    const saved = await controllerWith(repo).put(context, member(), {
      ...VALID,
      numerals: 'arabic_indic',
      calendarDisplay: 'gregorian_hijri',
    });
    expect(saved.numerals).toBe('arabic_indic');
    expect(saved.calendarDisplay).toBe('gregorian_hijri');

    const before = repo.upsertCalls.length;
    await expectStatus(
      controllerWith(repo).put(context, member(), { ...VALID, numerals: 'roman' }),
      400,
    );
    await expectStatus(
      controllerWith(repo).put(context, member(), { ...VALID, calendarDisplay: 'hijri_only' }),
      400,
    );
    expect(repo.upsertCalls).toHaveLength(before);
  });

  it('55-07: Hijri is display-only — the service has no product-event emitter to send it to', () => {
    // The service is built from the database and the repository alone; nothing it holds can write
    // product_events, so the calendar choice never reaches an analytics stream (PDPL).
    expect(DisplayPreferencesService.length).toBe(2);
  });
});
