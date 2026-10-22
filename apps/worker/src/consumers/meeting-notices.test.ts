import { describe, expect, it } from 'vitest';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import { planMeetingChangedNotices, planMeetingInviteNotices } from './collaboration-notices.js';
import {
  CollaborationMailer,
  composeCollaborationEmail,
} from '../notifications/collaboration-mailer.js';

/**
 * BK5 — client people as meeting attendees and the "meeting changed" notice, over a fake
 * transaction that answers each statement by what it reads (the collaboration suite's pattern).
 */

const ORG = 'org-1';

function event(type: string, payload: Record<string, unknown>): ClaimedOutboxEvent {
  return {
    id: 'event-9',
    organizationId: ORG,
    type,
    schemaVersion: 1,
    aggregateType: 'meeting',
    aggregateId: 'mtg-1',
    payload,
    correlationId: null,
    occurredAt: new Date('2026-10-23T00:00:00.000Z'),
    attempts: 1,
  } as ClaimedOutboxEvent;
}

/** Members on the project: `lina`, `omar`, `maya`. Clients still permitted: `salma`. */
function fakeTx(): WorkerTransaction {
  return {
    async query(sql: string, params: readonly unknown[] = []): Promise<unknown> {
      if (sql.includes('FROM meetings')) {
        return [
          {
            title: 'Weekly client review',
            project_id: 'proj-1',
            starts_at: new Date('2026-10-29T10:00:00.000Z'),
            created_by_user_id: 'maya',
          },
        ];
      }
      if (sql.includes('FROM memberships m')) {
        const userId = String(params[2]);
        return ['lina', 'omar', 'maya'].includes(userId)
          ? [{ id: `m-${userId}`, role: 'member', has_org_wide_scope: 0, on_project: 1 }]
          : [];
      }
      if (sql.includes('FROM client_memberships cm')) {
        return [{ permitted: params[1] === 'salma' ? 1 : 0 }];
      }
      if (sql.includes('FROM organizations')) return [{ slug: 'northstar', name: 'Northstar' }];
      return [];
    },
  } as WorkerTransaction;
}

describe('planMeetingChangedNotices (BK5)', () => {
  it('tells the attendees at the time of the change — members and permitted clients — never the changer', async () => {
    const notices = await planMeetingChangedNotices(
      event('meeting.changed.v1', {
        meetingId: 'mtg-1',
        projectId: 'proj-1',
        changedByUserId: 'maya',
        changedFields: ['startsAt'],
        memberUserIds: ['maya', 'lina', 'gone'],
        clientAttendees: [
          { userId: 'salma', clientOrganizationId: 'co-1' },
          { userId: 'youssef', clientOrganizationId: 'co-2' },
        ],
      }),
      fakeTx(),
      null,
    );
    expect(notices.map((n) => n.recipientUserId)).toEqual(['lina', 'salma']);
    expect(notices[0]).toMatchObject({
      membershipId: 'm-lina',
      mailKind: 'meeting_changed',
      inApp: {
        type: 'meeting.changed.v1',
        objectId: 'mtg-1',
        dedupeKey: 'meeting.changed:event-9',
      },
    });
    expect(notices[1]?.membershipId).toBeNull();
  });
});

describe('planMeetingInviteNotices — client invitee (BK5)', () => {
  it('tells a client of the project with a portal link, and nobody whose access is gone', async () => {
    const mailer = new CollaborationMailer(null, 'https://app.test');
    const payload = {
      meetingId: 'mtg-1',
      projectId: 'proj-1',
      attendeeUserId: 'salma',
      invitedByUserId: 'maya',
      attendeeKind: 'client',
      clientOrganizationId: 'co-1',
    };
    const notices = await planMeetingInviteNotices(
      event('meeting.attendee_invited.v1', payload),
      fakeTx(),
      mailer,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.membershipId).toBeNull();
    const subject = await notices[0]?.mail();
    expect(subject?.link).toBe('https://app.test/northstar/portal/meetings/mtg-1');

    const refused = await planMeetingInviteNotices(
      event('meeting.attendee_invited.v1', { ...payload, attendeeUserId: 'youssef' }),
      fakeTx(),
      mailer,
    );
    expect(refused).toEqual([]);
  });
});

describe('meeting_changed email (BK5)', () => {
  const facts = {
    recipientEmail: 'salma@example.test',
    recipientName: 'Salma Riad',
    organizationName: 'Northstar',
    actorName: 'Maya Hassan',
    subjectTitle: 'Weekly client review',
    projectName: 'Atlas Relaunch',
    when: '2026-10-29 10:00 UTC',
    link: 'https://app.test/northstar/portal/meetings/mtg-1',
  };

  it('is written in English or Arabic by the recipient locale, with the new time and the link', () => {
    const english = composeCollaborationEmail('meeting_changed', { ...facts, locale: 'en' });
    expect(english.subject).toBe('Weekly client review has changed');
    expect(english.text).toContain('It is now on 2026-10-29 10:00 UTC.');
    expect(english.text).toContain(facts.link);

    const arabic = composeCollaborationEmail('meeting_changed', { ...facts, locale: 'ar-EG' });
    expect(arabic.subject).toContain('تغيّر موعد');
    expect(arabic.text).toContain('2026-10-29 10:00 UTC');
    expect(arabic.text).toContain(facts.link);
  });
});
