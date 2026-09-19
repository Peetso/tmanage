import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { NotificationPreferenceRow } from '../../common/database/schema.js';
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
 * returns {@link DEFAULT_NOTIFICATION_PREFERENCES} for that case — every channel on, the
 * digest off, no quiet hours — so "never saved" and "saved the defaults" answer identically.
 * The same defaults are the column defaults in `0022_notification_preferences.sql`.
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

/** Every channel on, digest off, no quiet hours — what an unsaved account is reached by. */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferencesView = {
  inAppEnabled: true,
  emailEnabled: true,
  digestFrequency: 'off',
  quietHoursStart: null,
  quietHoursEnd: null,
  quietHoursTimezone: null,
};

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
  ) {}

  async getPreferences(
    context: TenantContext,
    principal: Principal,
  ): Promise<NotificationPreferencesView> {
    const row = await this.database.read(context, (runner) =>
      this.preferences.findForUser(runner, context, principal.userId),
    );
    return row ? viewOf(row) : DEFAULT_NOTIFICATION_PREFERENCES;
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
