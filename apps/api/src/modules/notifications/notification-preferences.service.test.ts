import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { NotificationPreferencesRepository } from './notification-preferences.repository.js';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NotificationPreferencesService,
  defaultsFor,
} from './notification-preferences.service.js';

/** 55-18 — the defaults resolver for a member with no saved row. */
const context = { organizationId: 'o1' } as unknown as TenantContext;
const principal = { userId: 'u1' } as unknown as Principal;

function serviceWith(settings: Record<string, string>, saved: object | null = null) {
  const database = {
    read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const preferences = {
    findForUser: async () => saved,
  } as unknown as NotificationPreferencesRepository;
  const store = {
    findByKey: async (_r: unknown, _c: unknown, key: string) =>
      key in settings ? ({ settingValue: settings[key] } as never) : undefined,
  };
  return new NotificationPreferencesService(database, preferences, store);
}

describe('notification defaults resolver (55-18)', () => {
  it('an org without a profile reads calm, quiet hours in the org zone', async () => {
    const view = await serviceWith({ default_timezone: 'Asia/Riyadh' }).getPreferences(
      context,
      principal,
    );
    expect(view).toEqual({
      inAppEnabled: true,
      emailEnabled: true,
      digestFrequency: 'daily',
      quietHoursStart: '19:00:00',
      quietHoursEnd: '08:00:00',
      quietHoursTimezone: 'Asia/Riyadh',
    });
  });

  it('standard reads the pre-55-18 defaults, and a saved row is never rewritten', async () => {
    const view = await serviceWith({ notification_profile: 'standard' }).getPreferences(
      context,
      principal,
    );
    expect(view).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(defaultsFor('calm', null).quietHoursTimezone).toBe('UTC');

    const saved = {
      inAppEnabled: false,
      emailEnabled: true,
      digestFrequency: 'off',
      quietHoursStart: null,
      quietHoursEnd: null,
      quietHoursTimezone: null,
    };
    const own = await serviceWith({}, saved).getPreferences(context, principal);
    expect(own).toEqual(saved);
  });
});
