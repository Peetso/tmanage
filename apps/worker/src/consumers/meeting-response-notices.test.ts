import { describe, expect, it } from 'vitest';
import { routeFor } from '@tmanage/domain';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import { COLLABORATION_PLANNERS, planMeetingResponseNotices } from './collaboration-notices.js';

/**
 * Fix 2026-11-09 — `meeting.attendee_responded.v1`: an answer given in Google Calendar / Outlook
 * tells the meeting's organizer (read from the meeting row), in the inbox only, after re-checking
 * that the organizer still reaches the project.
 */

const ORG = 'org-1';

function event(payload: Record<string, unknown>): ClaimedOutboxEvent {
  return {
    id: 'event-7',
    organizationId: ORG,
    type: 'meeting.attendee_responded.v1',
    schemaVersion: 1,
    aggregateType: 'meeting',
    aggregateId: 'mtg-1',
    payload,
    correlationId: null,
    occurredAt: new Date('2026-11-09T00:00:00.000Z'),
    attempts: 1,
  } as ClaimedOutboxEvent;
}

/** The meeting is organized by `maya`; `onProject` says who still reaches the project. */
function fakeTx(onProject: readonly string[] = ['maya', 'lina']): WorkerTransaction {
  return {
    async query(sql: string, params: readonly unknown[] = []): Promise<unknown> {
      if (sql.includes('FROM meetings')) {
        return [
          {
            title: 'Weekly client review',
            project_id: 'proj-1',
            starts_at: new Date('2026-11-12T10:00:00.000Z'),
            created_by_user_id: 'maya',
          },
        ];
      }
      if (sql.includes('FROM memberships m')) {
        const userId = String(params[2]);
        return onProject.includes(userId)
          ? [{ id: `m-${userId}`, role: 'member', has_org_wide_scope: 0, on_project: 1 }]
          : [];
      }
      return [];
    },
  } as WorkerTransaction;
}

const guestYes = {
  meetingId: 'mtg-1',
  projectId: 'proj-1',
  attendeeKind: 'guest',
  attendeeId: 'g-1',
  attendeeUserId: null,
  response: 'accepted',
  provider: 'google',
};

describe('planMeetingResponseNotices (fix 2026-11-09)', () => {
  it('tells the organizer in the inbox when a guest answers from their calendar', async () => {
    const notices = await planMeetingResponseNotices(event(guestYes), fakeTx(), null);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      recipientUserId: 'maya',
      membershipId: 'm-maya',
      optOutKind: null,
      mailKind: null,
      inApp: {
        type: 'meeting.attendee_responded.v1',
        objectType: 'meeting',
        objectId: 'mtg-1',
        dedupeKey: 'meeting.responded:g-1:event-7',
      },
    });
  });

  it('never tells the organizer about their own answer', async () => {
    const notices = await planMeetingResponseNotices(
      event({ ...guestYes, attendeeKind: 'member', attendeeUserId: 'maya' }),
      fakeTx(),
      null,
    );
    expect(notices).toEqual([]);
  });

  it('tells nobody once the organizer no longer reaches the project', async () => {
    expect(await planMeetingResponseNotices(event(guestYes), fakeTx(['lina']), null)).toEqual([]);
  });

  it('is registered, routed as an in-app Work notice the per-kind switch controls', () => {
    expect(COLLABORATION_PLANNERS['meeting.attendee_responded.v1']).toBe(
      planMeetingResponseNotices,
    );
    expect(routeFor('meeting.attendee_responded.v1')).toMatchObject({
      group: 'work_item',
      inApp: true,
      email: false,
    });
  });
});
