import { Body, Controller, Get, HttpCode, Inject, Put } from '@nestjs/common';
import { isValidTimeZone } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { NOTIFICATION_PREFERENCES_SERVICE } from '../../common/http/tokens.js';
import { DIGEST_FREQUENCIES } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { NotificationPreferencesInput } from './notification-preferences.repository.js';
import type {
  NotificationPreferencesService,
  NotificationPreferencesView,
} from './notification-preferences.service.js';

/**
 * NOTIF-001 preferences — the caller's own settings, read and replaced.
 *
 * ## Own settings only, and the capability decided rather than invented
 *
 * There is no user in the path: the recipient is the authenticated `principal`, so no caller
 * can read or write another person's settings — the request has no way to name one. The
 * capability is **`work.read`**, the same choice and for the same reason INBOX-001 recorded:
 * `12-PERMISSION-MATRIX` names no notification capability, `work.read` is the one every
 * internal role holds and no client role does (TM-27's audience), and adding a
 * `notification.write` would put a word in the ceiling table the matrix does not have. A
 * client's own preferences are a portal concern of their own, the way the client inbox is
 * INBOX-001's second half; they are not this route. The control that matters is here, not in
 * the coarse guard: a person reads and writes their own row and nothing else.
 *
 * ## PUT is a full replacement
 *
 * The body carries every setting, and the upsert stores exactly it — a partial PUT would make
 * "unset" and "set to the default" indistinguishable, and the settings screen sends the whole
 * form. Validation is here rather than in the service because a malformed body is the
 * client's error to be told about (400), not a state the store should ever hold.
 */

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

@Controller('v1/organizations/:orgSlug/notification-preferences')
export class NotificationPreferencesController {
  constructor(
    @Inject(NOTIFICATION_PREFERENCES_SERVICE)
    private readonly preferences: NotificationPreferencesService,
  ) {}

  @Get()
  @RequireCapability('work.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<NotificationPreferencesView> {
    return this.preferences.getPreferences(context, principal);
  }

  @Put()
  @RequireCapability('work.read')
  @HttpCode(200)
  async put(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<NotificationPreferencesView> {
    const input = parseInput(body);
    return this.preferences.updatePreferences(context, principal, input);
  }
}

function parseInput(body: unknown): NotificationPreferencesInput {
  const details: { field: string; message: string }[] = [];
  const value = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  const bool = (field: string): boolean => {
    const raw = value[field];
    if (typeof raw !== 'boolean') {
      details.push({ field, message: 'must be a boolean' });
      return false;
    }
    return raw;
  };

  const inAppEnabled = bool('inAppEnabled');
  const emailEnabled = bool('emailEnabled');

  const digest = value['digestFrequency'];
  if (!(DIGEST_FREQUENCIES as readonly unknown[]).includes(digest)) {
    details.push({
      field: 'digestFrequency',
      message: `must be one of ${DIGEST_FREQUENCIES.join(', ')}`,
    });
  }

  const timeField = (field: string): string | null => {
    const raw = value[field];
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string' || !TIME_OF_DAY.test(raw)) {
      details.push({ field, message: 'must be a HH:MM or HH:MM:SS time, or null' });
      return null;
    }
    return raw;
  };

  const quietHoursStart = timeField('quietHoursStart');
  const quietHoursEnd = timeField('quietHoursEnd');

  const zoneRaw = value['quietHoursTimezone'];
  let quietHoursTimezone: string | null = null;
  if (zoneRaw !== null && zoneRaw !== undefined) {
    // INBOX-001 closes the x54 Minor: a stored zone the delivery seam feeds to `Intl` must be a
    // real IANA name, or `isInQuietHours` silently reads no window and the person is never quiet.
    if (
      typeof zoneRaw !== 'string' ||
      zoneRaw.length === 0 ||
      zoneRaw.length > 64 ||
      !isValidTimeZone(zoneRaw)
    ) {
      details.push({
        field: 'quietHoursTimezone',
        message: 'must be a valid IANA timezone, or null',
      });
    } else {
      quietHoursTimezone = zoneRaw;
    }
  }

  // A window needs both ends: a start without an end (or the reverse) describes nothing the
  // seam can honour, so it is the client's error rather than a half-window stored as if valid.
  if ((quietHoursStart === null) !== (quietHoursEnd === null)) {
    const missing = quietHoursStart === null ? 'quietHoursStart' : 'quietHoursEnd';
    details.push({
      field: missing,
      message: 'quiet hours need both a start and an end, or neither',
    });
  }

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The preferences are invalid', details);
  }

  return {
    inAppEnabled,
    emailEnabled,
    digestFrequency: digest as 'off' | 'daily' | 'weekly',
    quietHoursStart,
    quietHoursEnd,
    quietHoursTimezone,
  };
}
