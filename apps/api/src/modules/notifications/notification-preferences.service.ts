import {
  DEFAULT_NOTIFICATION_PROFILE,
  isNotificationProfile,
  notificationDefaultsFor,
} from '@tmanage/domain';
import type { NotificationProfile, Principal } from '@tmanage/domain';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { NotificationPreferenceRow } from '../../common/database/schema.js';
import { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import {
  NotificationPreferencesRepository,
  type NotificationPreferencesInput,
} from './notification-preferences.repository.js';

/**
 * NOTIF-001 preferences — the read/upsert of one person's settings, always their own.
 *
 * The recipient is `principal.userId` and nothing a request can name, the same rule the
 * inbox takes: a route reads the caller's settings, never another person's. The controller
 * has no path or query that could carry a different user, and this service would ignore one
 * if it did.
 *
 * ## Absence is the default, not an error
 *
 * A person who has never opened the settings screen has no row. {@link getPreferences}
 * returns {@link defaultsFor} the org's notification profile for that case (55-18: `calm` unless
 * the org chose `standard`, whose defaults — every channel on, digest off, no quiet hours — are
 * {@link DEFAULT_NOTIFICATION_PREFERENCES} and the column defaults in `0022_notification_preferences.sql`).
 *
 * ## This slice stores; it does not honour
 *
 * Nothing here suppresses or defers a delivery. Reading these settings in the bundler/relay
 * to actually quiet or batch a notification is a later slice — see docs/implementation-status.
 */

/** What the GET/PUT route exchanges: the settings, without the row's identity or timestamps. */
export interface NotificationPreferencesView {
  readonly inAppEnabled: boolean;
  readonly emailEnabled: boolean;
  readonly digestFrequency: 'off' | 'daily' | 'weekly';
  /** Wall-clock `HH:MM:SS` in {@link quietHoursTimezone}, or null for no quiet hours. */
  readonly quietHoursStart: string | null;
  readonly quietHoursEnd: string | null;
  readonly quietHoursTimezone: string | null;
}

/**
 * Every channel on, digest off, no quiet hours — the `standard` profile's defaults. Kept exported
 * (other tests import it); since 55-18 an unsaved account is reached by {@link defaultsFor} instead.
 */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferencesView = {
  inAppEnabled: true,
  emailEnabled: true,
  digestFrequency: 'off',
  quietHoursStart: null,
  quietHoursEnd: null,
  quietHoursTimezone: null,
};

/**
 * 55-18 (R18-d) — what a member with **no saved row** is reached by: the org's notification profile
 * (`org_settings.notification_profile`, absent = `calm`) with its quiet hours read in the org's
 * `default_timezone`. A saved row is never rewritten (no backfill): existing members keep what they
 * have. Honouring the digest / quiet hours at send time is the deferred NS-13 delivery slice, not here.
 */
export function defaultsFor(
  profile: NotificationProfile,
  orgTimezone: string | null,
): NotificationPreferencesView {
  if (profile === 'standard') return DEFAULT_NOTIFICATION_PREFERENCES;
  const defaults = notificationDefaultsFor(profile);
  return {
    inAppEnabled: true,
    emailEnabled: true,
    digestFrequency: defaults.digestFrequency,
    quietHoursStart: defaults.quietHoursStart,
    quietHoursEnd: defaults.quietHoursEnd,
    quietHoursTimezone: defaults.quietHoursStart === null ? null : (orgTimezone ?? 'UTC'),
  };
}

/** The org's notification profile, `calm` when unset or unreadable. */
export async function notificationProfileOf(
  runner: TenantQueryRunner,
  context: TenantContext,
  settings: Pick<OrgSettingsRepository, 'findByKey'>,
): Promise<NotificationProfile> {
  const row = await settings.findByKey(runner, context, 'notification_profile');
  const value = row?.settingValue;
  return isNotificationProfile(value) ? value : DEFAULT_NOTIFICATION_PROFILE;
}

function viewOf(row: NotificationPreferenceRow): NotificationPreferencesView {
  return {
    inAppEnabled: row.inAppEnabled,
    emailEnabled: row.emailEnabled,
    digestFrequency: row.digestFrequency,
    quietHoursStart: row.quietHoursStart,
    quietHoursEnd: row.quietHoursEnd,
    quietHoursTimezone: row.quietHoursTimezone,
  };
}

export class NotificationPreferencesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly preferences: NotificationPreferencesRepository = new NotificationPreferencesRepository(),
    private readonly settings: Pick<
      OrgSettingsRepository,
      'findByKey'
    > = new OrgSettingsRepository(),
  ) {}

  async getPreferences(
    context: TenantContext,
    principal: Principal,
  ): Promise<NotificationPreferencesView> {
    return this.database.read(context, async (runner) => {
      const row = await this.preferences.findForUser(runner, context, principal.userId);
      if (row) return viewOf(row);
      const profile = await notificationProfileOf(runner, context, this.settings);
      const zone = await this.settings.findByKey(runner, context, 'default_timezone');
      return defaultsFor(profile, zone?.settingValue ?? null);
    });
  }

  /**
   * Replace the caller's settings and return what is now stored. One transaction: the upsert
   * and the read that confirms it see the same row, so the response is the persisted state —
   * a `HH:MM` the caller sent comes back as the `HH:MM:SS` the column holds.
   */
  async updatePreferences(
    context: TenantContext,
    principal: Principal,
    input: NotificationPreferencesInput,
  ): Promise<NotificationPreferencesView> {
    return this.database.transaction(context, async (tx) => {
      await this.preferences.upsert(tx, context, principal.userId, input);
      const row = await this.preferences.findForUser(tx, context, principal.userId);
      return row ? viewOf(row) : DEFAULT_NOTIFICATION_PREFERENCES;
    });
  }
}
