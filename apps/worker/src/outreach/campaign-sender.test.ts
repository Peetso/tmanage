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
  CampaignVersion,
  FollowupCandidate,
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

function campaign(over: Partial<CampaignRecord> = {}): CampaignRecord {
  return {
    id: 'c-1',
    firstStartedAt: new Date(NOW.getTime() - DAY),
    dailyCap: 20,
    warmup: true,
    followupEnabled: false,
    followupDays: 4,
    senderPool: 'auto',
    ...over,
  };
}

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
  campaigns: CampaignRecord[] = [campaign()];
  rows: QueuedRecipient[] = [];
  sentRows: FollowupCandidate[] = [];
  savedVersions: CampaignVersion[] = [];
  chosen = new Map<string, Set<string>>();
  introVersion = new Map<string, number | null>();
  followup = new Map<string, string>();
  followupVersion = new Map<string, number | null>();
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
  versions = () => Promise.resolve(this.savedVersions);
  chosenSenders = () => Promise.resolve(this.chosen);
  followupCandidates = (ids: readonly string[]) =>
    Promise.resolve(
      this.sentRows.filter((r) => ids.includes(r.campaignId) && !this.followup.has(r.id)),
    );
  claim = (id: string, _at: Date, version: number | null) => {
    if ((this.status.get(id) ?? 'queued') !== 'queued') return Promise.resolve(false);
    this.status.set(id, 'sending');
    this.introVersion.set(id, version);
    return Promise.resolve(true);
  };
  claimFollowup = (id: string, _at: Date, version: number | null) => {
    if (this.followup.has(id)) return Promise.resolve(false);
    this.followup.set(id, 'sending');
    this.followupVersion.set(id, version);
    return Promise.resolve(true);
  };
  settleFollowup = (id: string, _from: string | null, to: string) => {
    this.followup.set(id, to);
    return Promise.resolve();
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
    expect(await pass(store, mailer)).toEqual({
      sent: 2,
      failed: 0,
      suppressed: 0,
      followupsSent: 0,
    });
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
    expect(await pass(store, mailer)).toEqual({
      sent: 0,
      failed: 0,
      suppressed: 0,
      followupsSent: 0,
    });
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
    store.campaigns = [campaign({ firstStartedAt: new Date(NOW.getTime() - 15 * DAY) })];
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
    expect(await pass(store, mailer)).toEqual({
      sent: 1,
      failed: 0,
      suppressed: 1,
      followupsSent: 0,
    });
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

  it('sends the newest saved version in the recipient language and stamps its number', async () => {
    const store = new FakeStore();
    const a = recipient({ language: 'fr' });
    store.rows = [a];
    store.savedVersions = [
      {
        campaignId: 'c-1',
        kind: 'intro',
        language: 'fr',
        version: 3,
        text: { subject: 'Bonjour {first name}', body: 'Bonjour {first name},\n{trial link}' },
      },
    ];
    const mailer = new FakeMailer();
    expect((await pass(store, mailer)).sent).toBe(1);
    const mail = mailer.sent[0] as MailMessage;
    expect(mail.subject).toBe('Bonjour Lee');
    expect(mail.text).toMatch(
      /^Bonjour Lee,\nhttps:\/\/tmanageapp\.com\/sign-up\?trial=\S+&lang=fr$/mu,
    );
    expect(mail.text.split('\n').at(-1)).toContain('je ne vous écrirai plus');
    expect(mail.language).toBe('en');
    expect(store.introVersion.get(a.id)).toBe(3);
  });

  it('falls back to the default text (no version stamped) when nothing was saved', async () => {
    const store = new FakeStore();
    const a = recipient();
    store.rows = [a];
    const mailer = new FakeMailer();
    expect((await pass(store, mailer)).sent).toBe(1);
    expect(mailer.sent[0]?.subject).toBe('Client approvals without the email chase');
    expect(store.introVersion.get(a.id)).toBeNull();
  });

  it("holds a mailbox at the campaign's own cap, with or without warm-up", async () => {
    const store = new FakeStore();
    store.rows = [recipient()];
    const mailer = new FakeMailer();
    const long = new Date(NOW.getTime() - 10 * 3_600_000);
    store.stats.set('p-emma', { attempts24h: 3, lastAttemptAt: long });
    store.campaigns = [
      campaign({ firstStartedAt: new Date(NOW.getTime() - 30 * DAY), dailyCap: 3 }),
    ];
    expect((await pass(store, mailer)).sent).toBe(0);
    // Warm-up off, cap 8, first week: the warm-up ramp (5) no longer applies.
    store.stats.set('p-emma', { attempts24h: 6, lastAttemptAt: long });
    store.campaigns = [campaign({ warmup: false, dailyCap: 8 })];
    expect((await pass(store, mailer)).sent).toBe(1);
  });

  it('sends only from a chosen sender when the campaign has chosen senders', async () => {
    const store = new FakeStore();
    store.rows = [recipient(), recipient({ senderPersonId: 'p-daniel' })];
    store.campaigns = [campaign({ senderPool: 'chosen' })];
    store.chosen.set('c-1', new Set(['p-daniel']));
    const mailer = new FakeMailer();
    expect((await pass(store, mailer)).sent).toBe(1);
    expect(mailer.sent[0]?.personRef).toEqual({ kind: 'campaign', personId: 'p-daniel' });
  });

  it('sends one follow-up after N working days, introductions first, never twice', async () => {
    const store = new FakeStore();
    // Sent Tuesday 2026-11-17: by Monday 2026-11-23 that is 4 working days.
    const old = { ...recipient(), sentAt: new Date('2026-11-17T10:00:00Z') };
    const fresh = { ...recipient(), sentAt: new Date('2026-11-20T10:00:00Z') };
    store.sentRows = [old, fresh];
    store.campaigns = [campaign({ followupEnabled: true, followupDays: 4 })];
    store.savedVersions = [
      {
        campaignId: 'c-1',
        kind: 'followup',
        language: 'en',
        version: 2,
        text: { subject: 'Following up, {first name}', body: 'Hi {first name}, any thoughts?' },
      },
    ];
    const mailer = new FakeMailer();
    expect(await pass(store, mailer)).toEqual({
      sent: 0,
      failed: 0,
      suppressed: 0,
      followupsSent: 1,
    });
    expect(mailer.sent[0]).toMatchObject({
      to: old.emailHash,
      subject: 'Following up, Lee',
      templateKey: 'campaign_followup',
    });
    expect(store.followup.get(old.id)).toBe('sent');
    expect(store.followupVersion.get(old.id)).toBe(2);
    expect(store.followup.has(fresh.id)).toBe(false);
    expect((await pass(store, new FakeMailer(), '', new Date(NOW.getTime() + DAY))).sent).toBe(0);
    expect(store.followup.get(old.id)).toBe('sent');
    // The intro queue goes first: a queued intro from the same mailbox takes the pass.
    store.rows = [recipient()];
    store.sentRows = [{ ...recipient(), sentAt: new Date('2026-11-10T10:00:00Z') }];
    const next = new FakeMailer();
    expect((await pass(store, next)).sent).toBe(1);
    expect(next.sent.map((m) => m.templateKey)).toEqual(['campaign_intro']);
  });

  it('sends no follow-up while it is off, and skips a suppressed address', async () => {
    const store = new FakeStore();
    const gone = { ...recipient(), sentAt: new Date('2026-11-02T10:00:00Z') };
    store.sentRows = [gone];
    const mailer = new FakeMailer();
    expect((await pass(store, mailer)).followupsSent).toBe(0);
    expect(store.followup.has(gone.id)).toBe(false);
    store.campaigns = [campaign({ followupEnabled: true })];
    store.suppressedHashes.add(gone.emailHash);
    expect((await pass(store, mailer)).followupsSent).toBe(0);
    expect(store.followup.get(gone.id)).toBe('skipped');
    expect(mailer.sent).toHaveLength(0);
  });
});
