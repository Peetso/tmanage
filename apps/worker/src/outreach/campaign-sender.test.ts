import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFieldCipher, loadFieldCipherKeyring } from '@tmanage/domain/field-cipher';
import { deriveTrialLinkKey, verifyTrialLink } from '@tmanage/mail';
import type { MailDelivery, MailMessage, Mailer } from '@tmanage/mail';
import { runCampaignPass } from './campaign-sender.js';
import type {
  CampaignRecord,
  CampaignSender,
  CampaignSenderStore,
  MailboxStats,
  QueuedRecipient,
} from './campaign-sender.js';

/**
 * LANE-Q — one pass of the outreach sender against a fake store: who is written to, from which
 * mailbox, and when nobody is.
 */

const CIPHER = createFieldCipher(
  loadFieldCipherKeyring({ FIELD_CIPHER_KEYS: `1:${randomBytes(32).toString('base64')}` }),
);
const KEY = deriveTrialLinkKey('suite-secret');
// Monday 2026-11-23 10:30 UTC: 12:30 Helsinki, 14:30 Dubai, 05:30 Toronto.
const NOW = new Date('2026-11-23T10:30:00Z');
const DAY = 86_400_000;

let seq = 0;
function recipient(over: Partial<QueuedRecipient> = {}): QueuedRecipient {
  seq += 1;
  const id = `0199aa00-0000-7000-8000-${String(seq).padStart(12, '0')}`;
  const email = over.emailHash ?? `lead${String(seq)}@x.example`;
  return {
    id,
    campaignId: 'c-1',
    company: `Co ${String(seq)}`,
    firstName: 'Lee',
    emailEnc: CIPHER.encrypt(email, { purpose: 'outreach_email', ownerId: id }),
    emailHash: email,
    country: 'FI',
    timeZone: 'Europe/Helsinki',
    language: 'en',
    senderPersonId: 'p-emma',
    ...over,
  };
}

class FakeStore implements CampaignSenderStore {
  campaigns: CampaignRecord[] = [{ id: 'c-1', firstStartedAt: new Date(NOW.getTime() - DAY) }];
  rows: QueuedRecipient[] = [];
  people = new Map<string, CampaignSender>([
    ['p-emma', { nameEn: 'Emma', nameAr: 'إيما', active: true }],
    ['p-daniel', { nameEn: 'Daniel', nameAr: 'دانيال', active: true }],
  ]);
  stats = new Map<string, MailboxStats>();
  suppressedHashes = new Set<string>();
  status = new Map<string, string>();
  errors = new Map<string, string>();
  runningCampaigns = () => Promise.resolve(this.campaigns);
  mailboxStats = () => Promise.resolve(this.stats);
  queued = (ids: readonly string[]) =>
    Promise.resolve(
      this.rows.filter(
        (r) => ids.includes(r.campaignId) && (this.status.get(r.id) ?? 'queued') === 'queued',
      ),
    );
  senders = () => Promise.resolve(this.people);
  isSuppressed = (hash: string) => Promise.resolve(this.suppressedHashes.has(hash));
  claim = (id: string) => {
    if ((this.status.get(id) ?? 'queued') !== 'queued') return Promise.resolve(false);
    this.status.set(id, 'sending');
    return Promise.resolve(true);
  };
  settle = (id: string, _from: string, to: string, _at: Date, error?: string) => {
    this.status.set(id, to);
    if (error !== undefined) this.errors.set(id, error);
    return Promise.resolve();
  };
}

class FakeMailer implements Mailer {
  sent: MailMessage[] = [];
  fail = false;
  send(message: MailMessage): Promise<MailDelivery> {
    if (this.fail)
      return Promise.reject(Object.assign(new Error('refused'), { responseCode: 550 }));
    this.sent.push(message);
    return Promise.resolve({} as MailDelivery);
  }
}

function pass(store: FakeStore, mailer: FakeMailer, postal = '', now = NOW) {
  return runCampaignPass({
    store,
    cipher: CIPHER,
    trialKey: KEY,
    mailer,
    webPublicUrl: 'https://tmanageapp.com',
    postalAddress: () => postal,
    now: () => now,
  });
}

describe('LANE-Q campaign sender — one mail per mailbox per pass, inside every limit', () => {
  it('sends one per mailbox, from that mailbox, with a trial link bound to the row', async () => {
    const store = new FakeStore();
    const a = recipient();
    store.rows = [a, recipient(), recipient({ senderPersonId: 'p-daniel' })];
    const mailer = new FakeMailer();
    expect(await pass(store, mailer)).toEqual({ sent: 2, failed: 0, suppressed: 0 });
    expect(mailer.sent.map((m) => m.personRef)).toEqual([
      { kind: 'campaign', personId: 'p-emma' },
      { kind: 'campaign', personId: 'p-daniel' },
    ]);
    const first = mailer.sent[0] as MailMessage;
    expect(first.to).toBe(a.emailHash);
    expect(first.text).toContain('Emma\nTManage · tmanageapp.com');
    const token = new URL(/https:\/\/\S+sign-up\S+/u.exec(first.text)?.[0] ?? '').searchParams.get(
      'trial',
    );
    expect(
      verifyTrialLink(
        KEY,
        token ?? '',
        { recipientId: a.id, email: a.emailHash, company: a.company },
        NOW,
      ),
    ).toBe('valid');
    expect(store.status.get(a.id)).toBe('sent');
  });

  it('sends nothing while no campaign runs', async () => {
    const store = new FakeStore();
    store.campaigns = [];
    store.rows = [recipient()];
    const mailer = new FakeMailer();
    expect(await pass(store, mailer)).toEqual({ sent: 0, failed: 0, suppressed: 0 });
    expect(mailer.sent).toHaveLength(0);
  });

  it('holds a mailbox at its cap and inside its spacing', async () => {
    const store = new FakeStore();
    store.rows = [recipient()];
    const mailer = new FakeMailer();
    store.stats.set('p-emma', {
      attempts24h: 5,
      lastAttemptAt: new Date(NOW.getTime() - 5 * 3_600_000),
    });
    expect((await pass(store, mailer)).sent).toBe(0);
    store.stats.set('p-emma', {
      attempts24h: 1,
      lastAttemptAt: new Date(NOW.getTime() - 30 * 60_000),
    });
    expect((await pass(store, mailer)).sent).toBe(0);
    // Week 3: the cap is 20 and the spacing 24 min.
    store.campaigns = [{ id: 'c-1', firstStartedAt: new Date(NOW.getTime() - 15 * DAY) }];
    expect((await pass(store, mailer)).sent).toBe(1);
  });

  it('skips recipients outside 09:00-17:00 local, and a switched-off sender', async () => {
    const store = new FakeStore();
    const toronto = recipient({ country: 'CA', timeZone: 'America/Toronto' });
    const off = recipient({ senderPersonId: 'p-daniel' });
    store.rows = [toronto, off];
    store.people.set('p-daniel', { nameEn: 'Daniel', nameAr: 'دانيال', active: false });
    const mailer = new FakeMailer();
    expect((await pass(store, mailer)).sent).toBe(0);
    expect(store.status.get(toronto.id)).toBeUndefined();
    expect(store.status.get(off.id)).toBeUndefined();
  });

  it('marks an unsubscribed or bounced address suppressed and writes to the next one', async () => {
    const store = new FakeStore();
    const gone = recipient();
    const next = recipient();
    store.rows = [gone, next];
    store.suppressedHashes.add(gone.emailHash);
    const mailer = new FakeMailer();
    expect(await pass(store, mailer)).toEqual({ sent: 1, failed: 0, suppressed: 1 });
    expect(store.status.get(gone.id)).toBe('suppressed');
    expect(mailer.sent[0]?.to).toBe(next.emailHash);
  });

  it('waits on a US recipient until the postal address is set, then includes it', async () => {
    const store = new FakeStore();
    const us = recipient({ country: 'US', timeZone: 'America/Chicago' });
    store.rows = [us];
    const mailer = new FakeMailer();
    // 16:30 UTC = 10:30 Chicago.
    const at = new Date('2026-11-23T16:30:00Z');
    expect((await pass(store, mailer, '', at)).sent).toBe(0);
    expect((await pass(store, mailer, '1 Al Horeya St. - Cairo - Egypt', at)).sent).toBe(1);
    expect(mailer.sent[0]?.text).toContain('1 Al Horeya St. - Cairo - Egypt');
  });

  it('records a refused send as failed, with a code and no address, and never resends it', async () => {
    const store = new FakeStore();
    const a = recipient();
    store.rows = [a];
    const mailer = new FakeMailer();
    mailer.fail = true;
    expect((await pass(store, mailer)).failed).toBe(1);
    expect(store.status.get(a.id)).toBe('failed');
    expect(store.errors.get(a.id)).toBe('smtp_550');
    mailer.fail = false;
    expect((await pass(store, mailer)).sent).toBe(0);
  });
});
