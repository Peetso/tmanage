import type { TenantContext } from '../../common/database/tenant-context.js';
import type { StoredAttendeeRsvp } from './meeting-attendees.repository.js';

/**
 * 0237. What the meetings services see of the calendar providers: four calls, nothing about
 * Google or Microsoft. The provider modules (`google-calendar`, later `microsoft-calendar`) provide
 * it under {@link CALENDAR_SYNC}; without them (a suite, a deployment without Google) the port is
 * absent and meetings stay TManage-only.
 *
 * Every call runs AFTER the meeting transaction committed and never throws: a provider failure is
 * recorded on the meeting's link (`sync_status = 'error'`) and shown on the meeting page with Retry.
 */
export const CALENDAR_SYNC = Symbol.for('tmanage.CalendarSync');

export interface CalendarSyncPort {
  /** Create or update the organizer's provider event (or delete it when the meeting is cancelled). */
  pushMeeting(context: TenantContext, meetingId: string): Promise<void>;
  /** A TManage answer goes to the provider (the person's own copy, or the organizer's event). */
  forwardRsvp(
    context: TenantContext,
    meetingId: string,
    userId: string,
    rsvp: StoredAttendeeRsvp,
  ): Promise<void>;
  /** Re-read the provider event when the last pull is older than `maxAgeMs` ("pull on open"). */
  pullMeeting(context: TenantContext, meetingId: string, maxAgeMs: number): Promise<void>;
}
