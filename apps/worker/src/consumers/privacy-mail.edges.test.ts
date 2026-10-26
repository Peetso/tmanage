import { describe, expect, it } from 'vitest';
import type { Mailer, MailMessage } from '@tmanage/mail';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import {
  findPrivacyMailRecipients,
  listActiveOwnerIds,
} from '../common/database/privacy-mail-store.js';
import type { OutboxEffect, OutboxEffects } from '../outbox/dispatcher.js';
import { PrivacyMailer } from '../notifications/privacy-mailer.js';
import { createPrivacyDeletionChangedMail, createPrivacyExportReadyMail } from './privacy-mail.js';

/**
 * Audit 2026-10-26 gap 4 (wave 14 / L4) — the edges of the data-rights emails the first suite
 * (`privacy-mail.test.ts`) does not reach: who is *not* written to, what refuses loudly, and the
 * shape of the reads under them. Fakes only: no server, no real address.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OWNER = '00000000-0000-4000-8000-0000000000c1';
const MEMBER = '00000000-0000-4000-8000-0000000000c3';
const GONE = '00000000-0000-4000-8000-0000000000c9';

const USERS: Record<string, { email: string; display_name: string; locale: string | null }> = {
  [OWNER]: { email: 'owner@example.test', display_name: 'Nadia Owner', locale: 'en' },
  [MEMBER]: { email: 'member@example.test', display_name: 'Omar Member', locale: null },
};

interface Recorded {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function fakeTx(opts: { organization?: boolean } = {}): {
  tx: WorkerTransaction;
  reads: Recorded[];
} {
  const reads: Recorded[] = [];
  const tx = {
    query: (sql: string, params: readonly unknown[] = []) => {
      reads.push({ sql, params });
      if (sql.includes('FROM organizations')) {
        return Promise.resolve(
          opts.organization === false ? [] : [{ name: 'Northstar Studio', slug: 'northstar' }],
        );
      }
      if (sql.includes("m.role = 'owner'")) return Promise.resolve([{ user_id: OWNER }]);
      if (sql.includes('FROM users')) {
        const ids = params.slice(0, -1) as string[];
        return Promise.resolve(
          ids.filter((id) => USERS[id] !== undefined).map((id) => ({ id, ...USERS[id] })),
        );
      }
      return Promise.reject(new Error(`unexpected statement: ${sql}`));
    },
  } as unknown as WorkerTransaction;
  return { tx, reads };
}

/** A transaction that must not be read at all. */
const untouchable = {
  query: () => Promise.reject(new Error('no read expected')),
} as unknown as WorkerTransaction;

function collector(): { effects: OutboxEffects; staged: OutboxEffect[]; run: () => Promise<void> } {
  const staged: OutboxEffect[] = [];
  return {
    effects: { afterCommit: (effect) => staged.push(effect) },
    staged,
    run: async () => {
      for (const effect of staged) await effect();
    },
  };
}

function transport(): { mailer: Mailer; sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  const mailer = {
    send: (message: MailMessage) => {
      sent.push(message);
      return Promise.resolve('sent' as const);
    },
  } as unknown as Mailer;
  return { mailer, sent };
}

function event(type: string, payload: unknown): ClaimedOutboxEvent {
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

const deletion = (payload: Record<string, unknown>) =>
  event('privacy_deletion.changed.v1', {
    requestId: 'r1',
    kind: 'account',
    status: 'scheduled',
    actorUserId: MEMBER,
    subjectUserId: MEMBER,
    scheduledFor: '2026-11-24T13:05:00.000Z',
    ...payload,
  });

describe('Privacy emails — export ready, edges', () => {
  it("links an owner's export about a member to the admin page, and writes to the owner", async () => {
    const { mailer, sent } = transport();
    const { effects, run } = collector();
    const { tx } = fakeTx();
    await createPrivacyExportReadyMail(new PrivacyMailer(mailer, 'https://app.test'))(
      event('privacy_export.ready.v1', {
        exportId: 'x1',
        kind: 'member',
        requestedByUserId: OWNER,
        subjectUserId: MEMBER,
      }),
      tx,
      effects,
    );
    await run();
    expect(sent.map((m) => m.to)).toEqual(['owner@example.test']);
    expect(sent[0]?.text).toContain('https://app.test/northstar/admin/privacy');
  });

  it('refuses an event that names no requester, staging nothing', async () => {
    const { mailer } = transport();
    const { effects, staged } = collector();
    const handler = createPrivacyExportReadyMail(new PrivacyMailer(mailer, 'https://app.test'));
    await expect(
      handler(event('privacy_export.ready.v1', { kind: 'company' }), fakeTx().tx, effects),
    ).rejects.toThrow(/names no requester/u);
    await expect(
      handler(event('privacy_export.ready.v1', null), fakeTx().tx, effects),
    ).rejects.toThrow(/no readable payload/u);
    expect(staged).toHaveLength(0);
  });

  it('says nothing to a person who is gone, or for an organization that is gone', async () => {
    const { mailer, sent } = transport();
    const handler = createPrivacyExportReadyMail(new PrivacyMailer(mailer, 'https://app.test'));
    const gonePerson = collector();
    await handler(
      event('privacy_export.ready.v1', { kind: 'member', requestedByUserId: GONE }),
      fakeTx().tx,
      gonePerson.effects,
    );
    const goneOrg = collector();
    await handler(
      event('privacy_export.ready.v1', { kind: 'company', requestedByUserId: OWNER }),
      fakeTx({ organization: false }).tx,
      goneOrg.effects,
    );
    await gonePerson.run();
    await goneOrg.run();
    expect(gonePerson.staged).toHaveLength(0);
    expect(goneOrg.staged).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('reads nothing and sends nothing when no transport is wired', async () => {
    const { effects, staged } = collector();
    await createPrivacyExportReadyMail(new PrivacyMailer(null, 'https://app.test'))(
      event('privacy_export.ready.v1', { kind: 'company', requestedByUserId: OWNER }),
      untouchable,
      effects,
    );
    await createPrivacyDeletionChangedMail(new PrivacyMailer(null, 'https://app.test'))(
      deletion({}),
      untouchable,
      effects,
    );
    expect(staged).toHaveLength(0);
  });
});

describe('Privacy emails — deletion changed, edges', () => {
  it("tells both the member and the owner who scheduled the member's account deletion", async () => {
    const { mailer, sent } = transport();
    const { effects, run } = collector();
    await createPrivacyDeletionChangedMail(new PrivacyMailer(mailer, 'https://app.test'))(
      deletion({ actorUserId: OWNER, subjectUserId: MEMBER }),
      fakeTx().tx,
      effects,
    );
    await run();
    expect(sent.map((m) => m.to).sort()).toEqual(['member@example.test', 'owner@example.test']);
    for (const message of sent) {
      expect(message.text).toContain('https://app.test/northstar/settings/my-data');
    }
  });

  it('tells an owner who cancels a company deletion once, with the admin link', async () => {
    const { mailer, sent } = transport();
    const { effects, run } = collector();
    await createPrivacyDeletionChangedMail(new PrivacyMailer(mailer, 'https://app.test'))(
      deletion({ kind: 'company', status: 'cancelled', actorUserId: OWNER, subjectUserId: null }),
      fakeTx().tx,
      effects,
    );
    await run();
    expect(sent.map((m) => m.to)).toEqual(['owner@example.test']);
    expect(sent[0]?.text).toContain('https://app.test/northstar/admin/privacy');
  });

  it('stays silent on a status it does not announce, without reading anything', async () => {
    const { mailer, sent } = transport();
    const { effects, staged } = collector();
    await createPrivacyDeletionChangedMail(new PrivacyMailer(mailer, 'https://app.test'))(
      deletion({ status: 'erased' }),
      untouchable,
      effects,
    );
    expect(staged).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('refuses an unreadable scheduled date rather than mailing a wrong one', async () => {
    const { mailer } = transport();
    const { effects, staged } = collector();
    await expect(
      createPrivacyDeletionChangedMail(new PrivacyMailer(mailer, 'https://app.test'))(
        deletion({ scheduledFor: 'next tuesday' }),
        fakeTx().tx,
        effects,
      ),
    ).rejects.toThrow(/no readable scheduledFor/u);
    expect(staged).toHaveLength(0);
  });
});

describe('Privacy emails — the reads under them', () => {
  it('asks for each person once, scoped to the organization, and not at all for nobody', async () => {
    const { tx, reads } = fakeTx();
    expect(await findPrivacyMailRecipients(tx, ORG, [])).toEqual([]);
    expect(reads).toHaveLength(0);

    const found = await findPrivacyMailRecipients(tx, ORG, [MEMBER, OWNER, MEMBER, GONE]);
    expect(found.map((person) => person.userId).sort()).toEqual([MEMBER, OWNER].sort());
    expect(found.find((person) => person.userId === MEMBER)?.locale).toBe('en');
    expect(reads).toHaveLength(1);
    expect(reads[0]?.params).toEqual([MEMBER, OWNER, GONE, ORG]);
    expect(reads[0]?.sql).toContain('m.organization_id = ?');
  });

  it("lists the organization's active owners only", async () => {
    const { tx, reads } = fakeTx();
    expect(await listActiveOwnerIds(tx, ORG)).toEqual([OWNER]);
    expect(reads[0]?.params).toEqual([ORG]);
    expect(reads[0]?.sql).toContain("m.status = 'active'");
  });
});
