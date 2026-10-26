import type { TenantContext } from '../../common/database/tenant-context.js';
import type { StoredAttendeeRsvp } from './meeting-attendees.repository.js';
import type { CalendarSyncPort } from './calendar-sync.port.js';

/**
 * 0237 (slice B). Which provider calendar a meeting goes to when its organizer has connected both
 * Google and Microsoft — decided by one pure rule both provider services apply, so exactly one of
 * them pushes and nobody gets two invitations:
 *
 * 1. A provider that already holds a live (not deleted) event for the meeting keeps it.
 * 2. Otherwise the video choice decides: Teams -> Microsoft, Google Meet -> Google (when connected).
 * 3. Otherwise Google when connected, then Microsoft.
 */

export type PushProvider = 'google' | 'microsoft';

export interface PushRouteInput {
  readonly conference: string;
  readonly googleConnected: boolean;
  readonly microsoftConnected: boolean;
  /** Whether a live (not deleted) link exists for that provider. */
  readonly googleLinked: boolean;
  readonly microsoftLinked: boolean;
}

export function pushProviderFor(input: PushRouteInput): PushProvider | null {
  if (input.googleLinked && input.googleConnected) return 'google';
  if (input.microsoftLinked && input.microsoftConnected) return 'microsoft';
  if (input.conference === 'teams' && input.microsoftConnected) return 'microsoft';
  if (input.conference === 'google_meet' && input.googleConnected) return 'google';
  if (input.googleConnected) return 'google';
  if (input.microsoftConnected) return 'microsoft';
  return null;
}

/**
 * One {@link CalendarSyncPort} over several providers: every call goes to each of them in turn.
 * Each provider acts only on its own link (and, for a push, only when {@link pushProviderFor}
 * names it), and none of them throws, so the fan-out is safe.
 */
export function combineCalendarSync(
  ports: readonly (CalendarSyncPort | null | undefined)[],
): CalendarSyncPort {
  const live = ports.filter((p): p is CalendarSyncPort => p !== null && p !== undefined);
  return {
    async pushMeeting(context: TenantContext, meetingId: string) {
      for (const port of live) await port.pushMeeting(context, meetingId);
    },
    async forwardRsvp(
      context: TenantContext,
      meetingId: string,
      userId: string,
      rsvp: StoredAttendeeRsvp,
    ) {
      for (const port of live) await port.forwardRsvp(context, meetingId, userId, rsvp);
    },
    async pullMeeting(context: TenantContext, meetingId: string, maxAgeMs: number) {
      for (const port of live) await port.pullMeeting(context, meetingId, maxAgeMs);
    },
  };
}
