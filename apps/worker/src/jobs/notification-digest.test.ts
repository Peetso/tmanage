import { describe, expect, it } from 'vitest';
import {
  digestWindowFor,
  sweepNotificationDigests,
  type DigestRecipient,
  type NotificationDigestStore,
} from './notification-digest.js';
import { DigestMailer, composeDigestEmail } from '../notifications/digest-mailer.js';
import { parseDigestJson } from '../common/database/notification-digest-store.js';
import { findMemberMatrixCell } from '../common/database/notification-matrix-store.js';
import { routeNotice } from '../consumers/collaboration-notices.js';
import type { PlannedNotice } from '../consumers/collaboration-notices.js';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';

const cairo: DigestRecipient = {
  organizationId: 'org-1',
  membershipId: 'm-1',
  userId: 'u-1',
  cadence: 'daily',
  sendHour: 8,
  dayOfWeek: 0,
  timezone: 'Africa/Cairo',
  businessBriefing: false,
};

/** A tx answering the one matrix query with a fixed row. */
function matrixTx(row: Record<string, unknown> | undefined): WorkerTransaction {
  return {
    query: () => Promise.resolve(row === undefined ? [] : [row]),
  } as unknown as WorkerTransaction;
}

describe('notification digest (53-15)', () => {
  it('is due only at the member send hour in their zone, weekly on their weekday', () => {
    // 06:00 UTC = 08:00 or 09:00 in Cairo depending on DST; pick a winter date (UTC+2).
    const winter = new Date('2026-01-15T06:10:00Z');
    expect(digestWindowFor(winter, cairo)?.key).toBe('digest:daily:2026-01-15');
    expect(digestWindowFor(new Date('2026-01-15T07:10:00Z'), cairo)).toBeNull();
    expect(digestWindowFor(winter, { ...cairo, cadence: 'immediate' })).toBeNull();
    // 2026-01-15 is a Thursday (4).
    expect(digestWindowFor(winter, { ...cairo, cadence: 'weekly', dayOfWeek: 4 })?.cadence).toBe(
      'weekly',
    );
    expect(digestWindowFor(winter, { ...cairo, cadence: 'weekly', dayOfWeek: 5 })).toBeNull();
  });

  it('sends one mail per claimed window and skips members with nothing claimed', async () => {
    const sent: string[] = [];
    const mailer = new DigestMailer(
      { send: (message) => (sent.push(message.subject), Promise.resolve('sent' as const)) },
      'https://app.example/',
    );
    const store: NotificationDigestStore = {
      listRecipients: () => Promise.resolve([cairo, { ...cairo, membershipId: 'm-2' }]),
      collectAndClaim: (recipient, _w, links) =>
        Promise.resolve(
          recipient.membershipId === 'm-2'
            ? null
            : {
                recipientEmail: 'a@example.com',
                recipientName: 'Amal',
                organizationName: 'Studio',
                cadence: 'daily',
                counts: { mention: 2, file: 1 },
                inboxLink: links('/s/inbox'),
                settingsLink: links('/s/inbox/notification-preferences'),
              },
        ),
    };
    const result = await sweepNotificationDigests(store, mailer, new Date('2026-01-15T06:00:00Z'));
    expect(result).toEqual({ recipients: 2, due: 2, sent: 1, failed: 0 });
    expect(sent).toEqual(['Your daily summary for Studio: 3 updates']);
  });

  it('writes counts and links only, in Arabic for an ar locale', () => {
    const mail = composeDigestEmail({
      recipientEmail: 'a@example.com',
      recipientName: 'أمل',
      organizationName: 'Studio',
      locale: 'ar-EG',
      cadence: 'weekly',
      counts: { client_request: 1 },
      inboxLink: 'https://app.example/s/inbox',
      settingsLink: 'https://app.example/s/x',
    });
    expect(mail.subject).toContain('الأسبوعي');
    expect(mail.text).toContain('طلبات العملاء والموافقات: 1');
  });

  it('reads stored cadence defensively, defaulting to daily at 08:00', () => {
    expect(parseDigestJson(null)).toEqual({
      cadence: 'daily',
      sendHour: 8,
      dayOfWeek: 0,
      businessBriefing: false,
    });
    expect(parseDigestJson('{"cadence":"weekly","sendHour":18,"dayOfWeek":6}')).toEqual({
      cadence: 'weekly',
      sendHour: 18,
      dayOfWeek: 6,
      businessBriefing: false,
    });
    // 62-A1c: the briefing switch is on only when stored as true.
    expect(parseDigestJson({ cadence: 'daily', businessBriefing: true }).businessBriefing).toBe(
      true,
    );
    expect(parseDigestJson({ cadence: 'daily', businessBriefing: 'yes' }).businessBriefing).toBe(
      false,
    );
  });
});

describe('matrix routing at delivery (53-15)', () => {
  const event = {
    id: 'e-1',
    organizationId: 'org-1',
    type: 'work_item.people_assigned.v1',
  } as ClaimedOutboxEvent;
  const notice = (over: Partial<PlannedNotice>): PlannedNotice => ({
    recipientUserId: 'u-1',
    optOutKind: null,
    membershipId: 'm-1',
    inApp: {
      type: 'work_item.people_assigned.v1',
      objectType: 'work_item',
      objectId: 'w',
      dedupeKey: 'k',
    },
    mailKind: 'people_assigned',
    mail: () => Promise.resolve(null),
    ...over,
  });

  it('honours the kind switch for a notice that never named a kind', async () => {
    const off = matrixTx({ kind_enabled: 0, matrix_json: null, profile: null, forced: null });
    expect(await routeNotice(off, event, notice({}))).toEqual({ inApp: false, email: false });
  });

  it('keeps the company-forced e-mail on and leaves client recipients unconditional', async () => {
    const forced = matrixTx({
      kind_enabled: 0,
      matrix_json: '{"work_item":{"email":false}}',
      profile: 'calm',
      forced: 'work_item',
    });
    expect(await routeNotice(forced, event, notice({}))).toEqual({ inApp: true, email: true });
    expect(await routeNotice(matrixTx(undefined), event, notice({ membershipId: null }))).toEqual({
      inApp: true,
      email: true,
    });
  });

  it('reads an informational kind as digest-not-email under the calm default', async () => {
    const cell = await findMemberMatrixCell(matrixTx(undefined), 'org-1', 'm-1', 'file');
    expect(cell).toEqual({ inApp: true, email: false, digest: true });
  });
});
