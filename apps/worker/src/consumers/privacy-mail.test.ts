import { describe, expect, it } from 'vitest';
import type { Mailer, MailMessage } from '@tmanage/mail';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { OutboxEffect, OutboxEffects } from '../outbox/dispatcher.js';
import { PrivacyMailer, composePrivacyEmail } from '../notifications/privacy-mailer.js';
import { createWorkerOutboxHandlers } from './registry.js';
import { createPrivacyDeletionChangedMail, createPrivacyExportReadyMail } from './privacy-mail.js';

/**
 * H3 — the data-rights emails over fakes: a transaction that answers the three reads, an effects
 * collector, and a transport that records what it was handed. No server, no real address.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OWNER_A = '00000000-0000-4000-8000-0000000000c1';
const OWNER_B = '00000000-0000-4000-8000-0000000000c2';
const MEMBER = '00000000-0000-4000-8000-0000000000c3';

const USERS: Record<string, { email: string; display_name: string; locale: string | null }> = {
  [OWNER_A]: { email: 'a@example.test', display_name: 'Nadia Owner', locale: 'en' },
  [OWNER_B]: { email: 'b@example.test', display_name: 'سارة', locale: 'ar' },
  [MEMBER]: { email: 'm@example.test', display_name: 'Omar Member', locale: null },
};

function fakeTx(owners: readonly string[] = [OWNER_A, OWNER_B]): WorkerTransaction {
  return {
    query: (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes('FROM organizations')) {
        return Promise.resolve([{ name: 'Northstar Studio', slug: 'northstar' }]);
      }
      if (sql.includes("m.role = 'owner'")) {
        return Promise.resolve(owners.map((user_id) => ({ user_id })));
      }
      if (sql.includes('FROM users')) {
        expect(params[params.length - 1]).toBe(ORG);
        const ids = params.slice(0, -1) as string[];
        return Promise.resolve(
          ids.filter((id) => USERS[id] !== undefined).map((id) => ({ id, ...USERS[id] })),
        );
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
  } as unknown as WorkerTransaction;
}

function collector(): { effects: OutboxEffects; run: () => Promise<void> } {
  const staged: OutboxEffect[] = [];
  return {
    effects: { afterCommit: (effect) => staged.push(effect) },
    run: async () => {
      for (const effect of staged) await effect();
    },
  };
}

function transport(fail = false): { mailer: Mailer; sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  const mailer = {
    send: (message: MailMessage) => {
      if (fail) return Promise.reject(new Error('smtp down'));
      sent.push(message);
      return Promise.resolve('sent' as const);
    },
  } as unknown as Mailer;
  return { mailer, sent };
}

function event(type: string, payload: Record<string, unknown>): ClaimedOutboxEvent {
  return {
    id: 'e1',
    organizationId: ORG,
    type,
    schemaVersion: 1,
    aggregateType: 'x',
    aggregateId: 'a',
    payload,
    correlationId: null,
    occurredAt: new Date(0),
    deliveryCount: 1,
  } as unknown as ClaimedOutboxEvent;
}

describe('Privacy emails — export ready', () => {
  it("tells the requester, linking a member's own export to My data", async () => {
    const { mailer, sent } = transport();
    const { effects, run } = collector();
    const handler = createPrivacyExportReadyMail(new PrivacyMailer(mailer, 'https://app.test/'));
    await handler(
      event('privacy_export.ready.v1', {
        exportId: 'x1',
        kind: 'member',
        requestedByUserId: MEMBER,
        subjectUserId: MEMBER,
      }),
      fakeTx(),
      effects,
    );
    await run();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('m@example.test');
    expect(sent[0]?.subject).toBe('Your TManage data export is ready');
    expect(sent[0]?.text).toContain('https://app.test/northstar/settings/my-data');
  });

  it('links a company export to the admin Privacy page', async () => {
    const { mailer, sent } = transport();
    const { effects, run } = collector();
    await createPrivacyExportReadyMail(new PrivacyMailer(mailer, 'https://app.test'))(
      event('privacy_export.ready.v1', {
        exportId: 'x1',
        kind: 'company',
        requestedByUserId: OWNER_A,
        subjectUserId: null,
      }),
      fakeTx(),
      effects,
    );
    await run();
    expect(sent[0]?.text).toContain('https://app.test/northstar/admin/privacy');
    expect(sent[0]?.text).toContain('the data of Northstar Studio');
  });
});

describe('Privacy emails — deletion changed', () => {
  it('tells every owner of a company deletion once, each in their own language', async () => {
    const { mailer, sent } = transport();
    const { effects, run } = collector();
    await createPrivacyDeletionChangedMail(new PrivacyMailer(mailer, 'https://app.test'))(
      event('privacy_deletion.changed.v1', {
        requestId: 'r1',
        kind: 'company',
        status: 'scheduled',
        actorUserId: OWNER_A,
        subjectUserId: null,
        scheduledFor: '2026-11-24T13:05:00.000Z',
      }),
      fakeTx(),
      effects,
    );
    await run();
    expect(sent.map((m) => m.to)).toEqual(['a@example.test', 'b@example.test']);
    expect(sent[0]?.subject).toBe('Northstar Studio will be deleted on 24 November 2026');
    expect(sent[1]?.subject).toContain('سيُحذف Northstar Studio');
    expect(sent[1]?.text.startsWith('‏')).toBe(true);
  });

  it('tells the person about their own account deletion, with no link once carried out', async () => {
    const { mailer, sent } = transport();
    const { effects, run } = collector();
    await createPrivacyDeletionChangedMail(new PrivacyMailer(mailer, 'https://app.test'))(
      event('privacy_deletion.changed.v1', {
        requestId: 'r2',
        kind: 'account',
        status: 'executed',
        actorUserId: MEMBER,
        subjectUserId: MEMBER,
        scheduledFor: '2026-11-24T13:05:00.000Z',
      }),
      fakeTx(),
      effects,
    );
    await run();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe('Your account in Northstar Studio was deleted');
    expect(sent[0]?.text).not.toContain('https://');
  });

  it('absorbs a failed send: the event is not rolled back', async () => {
    const { mailer } = transport(true);
    const { effects, run } = collector();
    await createPrivacyDeletionChangedMail(new PrivacyMailer(mailer, 'https://app.test'))(
      event('privacy_deletion.changed.v1', {
        requestId: 'r1',
        kind: 'company',
        status: 'cancelled',
        actorUserId: OWNER_A,
        subjectUserId: null,
        scheduledFor: '2026-11-24T13:05:00.000Z',
      }),
      fakeTx(),
      effects,
    );
    const quiet = console.error;
    console.error = () => undefined;
    try {
      await expect(run()).resolves.toBeUndefined();
    } finally {
      console.error = quiet;
    }
  });
});

describe('Privacy emails — copy and registration', () => {
  it('writes every kind in English and Arabic without developer text', () => {
    const kinds = [
      'export_ready',
      'deletion_scheduled',
      'deletion_cancelled',
      'deletion_executed',
    ] as const;
    for (const locale of ['en', 'ar']) {
      for (const kind of kinds) {
        const message = composePrivacyEmail(kind, {
          recipientEmail: 'x@example.test',
          recipientName: 'Nadia',
          locale,
          organizationName: 'Northstar Studio',
          scope: 'company',
          scheduledFor: new Date('2026-11-24T00:00:00.000Z'),
        });
        expect(message.subject.length).toBeGreaterThan(0);
        expect(message.text).not.toMatch(/undefined|null|\$\{|_v1|privacy_/u);
        if (locale === 'ar') expect(message.text).toMatch(/\p{Script=Arabic}/u);
      }
    }
  });

  it('registers both consumers only when a transport is wired', () => {
    const none = createWorkerOutboxHandlers({ privacyMailer: new PrivacyMailer(null, 'x') });
    expect(none['privacy_export.ready.v1']).toBeUndefined();
    const { mailer } = transport();
    const wired = createWorkerOutboxHandlers({ privacyMailer: new PrivacyMailer(mailer, 'x') });
    expect(wired['privacy_export.ready.v1']).toBeTypeOf('function');
    expect(wired['privacy_deletion.changed.v1']).toBeTypeOf('function');
  });
});
