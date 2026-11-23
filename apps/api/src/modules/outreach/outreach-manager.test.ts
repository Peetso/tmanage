import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createFieldCipher, loadFieldCipherKeyring } from '@tmanage/domain/field-cipher';
import { CAMPAIGN_UNSUBSCRIBE_LINES, DEFAULT_CAMPAIGN_EMAILS } from '@tmanage/mail';
import type { CampaignEmailKind, CampaignLanguage, MailMessage } from '@tmanage/mail';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import type { PlatformAuditInput } from '../platform-admin/platform-admin.repository.js';
import { outreachAddressHash } from './outreach-import.js';
import {
  OutreachManagerService,
  csvCell,
  maskAddress,
  type OutreachManagerStore,
} from './outreach-manager.service.js';
import type {
  CampaignRecord,
  EmailVersionRow,
  NewCampaign,
  RecipientChange,
  RecipientInsert,
  RecipientRecord,
  SettingsChange,
} from './outreach.repository.js';

/**
 * OUTREACH MANAGER — the rules the editor cannot break: a started campaign's e-mail changes only
 * when confirmed, every save is a new version, the preview is the mail as sent (unsubscribe line,
 * US postal address), the test goes to the signed-in admin only, people added by hand meet the
 * import's consent rules, a person is removed only while queued, the export neutralises formula
 * cells, and migration 0409 seeds exactly the package's default text.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(HERE, '../../../migrations/0409_outreach_manager.sql');

const CIPHER = createFieldCipher(
  loadFieldCipherKeyring({ FIELD_CIPHER_KEYS: `1:${randomBytes(32).toString('base64')}` }),
);
const ACTOR = {
  account: { userId: 'u-admin', email: 'owner@tmanageapp.com' },
} as PlatformAdminActor;
const CONTEXT = { correlationId: 'c-1', ip: null, userAgent: null } as never;
const NOW = new Date('2026-11-23T10:00:00Z');
const CAMPAIGN = '0199aa00-0000-7000-8000-00000000c001';
const R1 = '0199aa00-0000-7000-8000-00000000a001';
const R2 = '0199aa00-0000-7000-8000-00000000a002';
const SENDERS = [
  {
    id: '0199aa00-0000-7000-8000-00000000e001',
    address: 'emma@tmanageapp.com',
    nameEn: 'Emma',
    nameAr: 'إيما',
  },
  {
    id: '0199aa00-0000-7000-8000-00000000e002',
    address: 'mariam@tmanageapp.com',
    nameEn: 'Mariam',
    nameAr: 'مريم',
  },
];

function campaign(overrides: Partial<CampaignRecord> = {}): CampaignRecord {
  return {
    id: CAMPAIGN,
    name: 'Decision-makers intro 2026-11',
    status: 'paused',
    languages: ['en', 'ar'],
    senderPool: 'auto',
    dailyCap: 20,
    warmup: true,
    followupEnabled: false,
    followupDays: 4,
    archivedAt: null,
    firstStartedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function recipient(id: string, overrides: Partial<RecipientRecord> = {}): RecipientRecord {
  return {
    id,
    campaignId: CAMPAIGN,
    company: 'Atlas Studio',
    personName: 'Lena Hart',
    firstName: 'Lena',
    country: 'GB',
    language: 'en',
    senderPersonId: SENDERS[0]?.id ?? '',
    senderAddress: 'emma@tmanageapp.com',
    status: 'queued',
    sentAt: null,
    lastError: null,
    trialRedeemedAt: null,
    walkthroughAt: null,
    repliedAt: null,
    followupStatus: null,
    followupSentAt: null,
    optedOut: false,
    createdAt: NOW,
    emailEnc: CIPHER.encrypt('lena@atlas.example', { purpose: 'outreach_email', ownerId: id }),
    emailHash: outreachAddressHash('lena@atlas.example'),
    timeZone: 'Europe/London',
    ...overrides,
  };
}

class FakeStore implements OutreachManagerStore {
  campaigns: CampaignRecord[] = [campaign()];
  people: RecipientRecord[] = [recipient(R1)];
  versions: (EmailVersionRow & { campaignId: string })[] = [];
  chosen: string[] = [];
  suppressedSet = new Set<string>();
  audits: PlatformAuditInput[] = [];
  created: NewCampaign[] = [];
  activeSenders = () => Promise.resolve(SENDERS);
  known = () =>
    Promise.resolve({
      hashes: new Set(this.people.map((p) => p.emailHash)),
      companies: this.people.map((p) => p.company),
      rows: this.people.map((p) => ({ id: p.id, hash: p.emailHash, company: p.company })),
    });
  suppressed = (hashes: readonly string[]) =>
    Promise.resolve(new Set(hashes.filter((h) => this.suppressedSet.has(h))));
  insertCampaign = (c: NewCampaign, _r: readonly RecipientInsert[], audit: PlatformAuditInput) => {
    this.created.push(c);
    this.campaigns.push(campaign({ id: c.id, name: c.name, languages: c.languages }));
    for (const [kind, texts] of Object.entries(c.versions)) {
      for (const [language, text] of Object.entries(texts ?? {})) {
        this.versions.push({
          campaignId: c.id,
          kind: kind as CampaignEmailKind,
          version: 1,
          language: language as CampaignLanguage,
          subject: text.subject,
          body: text.body,
          createdBy: c.createdBy,
          createdAt: c.at,
        });
      }
    }
    this.audits.push(audit);
    return Promise.resolve();
  };
  campaign = (id: string) => Promise.resolve(this.campaigns.find((c) => c.id === id) ?? null);
  chosenSenders = () => Promise.resolve(this.chosen);
  counts = () => Promise.resolve(new Map());
  recipients = (id: string) => Promise.resolve(this.people.filter((p) => p.campaignId === id));
  recipient = (id: string) => Promise.resolve(this.people.find((p) => p.id === id) ?? null);
  exportRows = (id: string, audit: PlatformAuditInput) => {
    this.audits.push(audit);
    return Promise.resolve(this.people.filter((p) => p.campaignId === id));
  };
  updateSettings = (_id: string, _change: SettingsChange, _at: Date, audit: PlatformAuditInput) => {
    this.audits.push(audit);
    return Promise.resolve(true);
  };
  setArchived = () => Promise.resolve(true);
  latestVersions = (id: string) => {
    const mine = this.versions.filter((v) => v.campaignId === id);
    return Promise.resolve(
      mine.filter(
        (v) =>
          v.version ===
          Math.max(
            ...mine
              .filter((w) => w.kind === v.kind && w.language === v.language)
              .map((w) => w.version),
          ),
      ),
    );
  };
  versionList = () => Promise.resolve([]);
  version = () => Promise.resolve([]);
  saveVersion = (
    id: string,
    kind: CampaignEmailKind,
    texts: Readonly<Partial<Record<CampaignLanguage, { subject: string; body: string }>>>,
    createdBy: string,
    at: Date,
    audit: (version: number) => PlatformAuditInput,
  ) => {
    const version =
      Math.max(
        0,
        ...this.versions
          .filter((v) => v.campaignId === id && v.kind === kind)
          .map((v) => v.version),
      ) + 1;
    for (const [language, text] of Object.entries(texts)) {
      this.versions.push({
        campaignId: id,
        kind,
        version,
        language: language as CampaignLanguage,
        subject: text.subject,
        body: text.body,
        createdBy,
        createdAt: at,
      });
    }
    this.audits.push(audit(version));
    return Promise.resolve(version);
  };
  insertRecipients = (rows: readonly RecipientInsert[], _at: Date, audit: PlatformAuditInput) => {
    for (const r of rows) this.people.push(recipient(r.id, { ...r, emailHash: r.emailHash }));
    this.audits.push(audit);
    return Promise.resolve();
  };
  updateRecipient = (change: RecipientChange, _at: Date, audit: PlatformAuditInput) => {
    const p = this.people.find((x) => x.id === change.id && x.status === 'queued');
    if (p === undefined) return Promise.resolve(false);
    Object.assign(p, change);
    this.audits.push(audit);
    return Promise.resolve(true);
  };
  deleteRecipient = (id: string, audit: PlatformAuditInput) => {
    const before = this.people.length;
    this.people = this.people.filter((p) => !(p.id === id && p.status === 'queued'));
    this.audits.push(audit);
    return Promise.resolve(this.people.length < before);
  };
  markReplied = () => Promise.resolve(true);
  audit = (audit: PlatformAuditInput) => {
    this.audits.push(audit);
    return Promise.resolve();
  };
}

function service(store: FakeStore, postal = '') {
  const mails: MailMessage[] = [];
  const svc = new OutreachManagerService(store, CIPHER, {
    mailer: {
      send: (message) => {
        mails.push(message);
        return Promise.resolve('sent');
      },
    },
    webPublicUrl: 'https://tmanageapp.com',
    postalAddress: () => postal,
    now: () => NOW,
  });
  return { svc, mails };
}

describe('OUTREACH MANAGER — migration 0409 seeds the package default as version 1', () => {
  it('keeps the SQL text equal to DEFAULT_CAMPAIGN_EMAILS (English and Arabic, both e-mails)', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const seeds = [
      ...sql.matchAll(
        /SELECT UUID\(\), c\.id, '(intro|followup)', 1, '(en|ar)',\n {2}'((?:[^']|'')*)',\n {2}'((?:[^']|'')*)',/gu,
      ),
    ];
    expect(seeds).toHaveLength(4);
    for (const [, kind, language, subject, body] of seeds) {
      const expected =
        DEFAULT_CAMPAIGN_EMAILS[kind as CampaignEmailKind][language as CampaignLanguage];
      expect(subject?.replace(/''/gu, "'")).toBe(expected?.subject);
      expect(body?.replace(/''/gu, "'")).toBe(expected?.body);
    }
  });
});

describe('OUTREACH MANAGER — campaigns and their e-mail', () => {
  it('creates a paused campaign with the default text as version 1 in English and Arabic', async () => {
    const store = new FakeStore();
    const view = await service(store).svc.create(
      ACTOR,
      { name: 'Gulf agencies', languages: ['en', 'ar', 'fr'] },
      CONTEXT,
    );
    expect(view.campaign.status).toBe('paused');
    expect(store.created[0]?.versions.intro?.en).toEqual(DEFAULT_CAMPAIGN_EMAILS.intro.en);
    expect(store.created[0]?.versions.intro?.ar).toEqual(DEFAULT_CAMPAIGN_EMAILS.intro.ar);
    expect(store.created[0]?.versions.intro?.fr).toBeUndefined();
    expect(view.emails.intro.en?.version).toBe(1);
  });

  it('refuses chosen senders without a sender, and an unknown language', async () => {
    const { svc } = service(new FakeStore());
    await expect(
      svc.create(ACTOR, { name: 'X', senderPool: 'chosen', senderIds: [] }, CONTEXT),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      svc.create(ACTOR, { name: 'X', languages: ['xx'] }, CONTEXT),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('asks to confirm before changing a started campaign, then saves the next version', async () => {
    const store = new FakeStore();
    store.campaigns = [campaign({ firstStartedAt: NOW, status: 'running' })];
    const { svc } = service(store);
    const texts = {
      en: { subject: 'Approvals at {company}', body: 'Hi {first name},\n\nShort note.' },
      ar: { subject: 'الموافقات في {company}', body: 'مرحبًا {first name}،\n\nرسالة قصيرة.' },
    };
    await expect(svc.saveEmail(ACTOR, CAMPAIGN, 'intro', { texts }, CONTEXT)).rejects.toMatchObject(
      {
        status: 409,
        details: [{ field: 'confirmStarted' }],
      },
    );
    const view = await svc.saveEmail(
      ACTOR,
      CAMPAIGN,
      'intro',
      { texts, confirmStarted: true },
      CONTEXT,
    );
    expect(view.emails.intro.en).toMatchObject({ subject: 'Approvals at {company}', version: 1 });
    await svc.saveEmail(ACTOR, CAMPAIGN, 'intro', { texts, confirmStarted: true }, CONTEXT);
    expect(store.versions.filter((v) => v.language === 'en').map((v) => v.version)).toEqual([1, 2]);
    expect(store.audits.at(-1)?.action).toBe('platform.outreach_email_saved');
  });

  it('refuses HTML, an unknown placeholder and a reserved token in the text', async () => {
    const { svc } = service(new FakeStore());
    for (const body of ['<b>Hi</b>', 'Hi {last name}', 'Stop: [[tm.link.unsubscribe]]']) {
      await expect(
        svc.saveEmail(
          ACTOR,
          CAMPAIGN,
          'intro',
          { texts: { en: { subject: 'S', body }, ar: { subject: 'S', body: 'نص' } } },
          CONTEXT,
        ),
      ).rejects.toMatchObject({ status: 400 });
    }
  });

  it('refuses removing a language that queued people use', async () => {
    const store = new FakeStore();
    store.people = [recipient(R1, { language: 'ar' })];
    await expect(
      service(store).svc.update(ACTOR, CAMPAIGN, { languages: ['en'] }, CONTEXT),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('OUTREACH MANAGER — the preview is the mail; the test goes to me only', () => {
  it('previews with the unsubscribe line, and the US postal address for a US person', async () => {
    const store = new FakeStore();
    store.people = [recipient(R1, { country: 'US' })];
    const { svc } = service(store, '1 Main St, Austin, TX 78701');
    const view = await svc.preview(CAMPAIGN, { language: 'en', recipientId: R1 }, CONTEXT);
    expect(view.text.endsWith(CAMPAIGN_UNSUBSCRIBE_LINES.en)).toBe(true);
    expect(view.text).toContain('1 Main St, Austin, TX 78701');
    expect(view.text).toContain('Hi Lena,');
    expect(view.to).toBe('l•••@atlas.example');
    expect(view.from).toBe('Emma from TManage <emma@tmanageapp.com>');
  });

  it('sends the test to the signed-in admin only, marked [Test]', async () => {
    const store = new FakeStore();
    const { svc, mails } = service(store);
    const view = await svc.testSend(ACTOR, CAMPAIGN, { kind: 'intro', language: 'en' }, CONTEXT);
    expect(view).toEqual({ sent: true, to: 'owner@tmanageapp.com' });
    expect(mails).toHaveLength(1);
    expect(mails[0]?.to).toBe('owner@tmanageapp.com');
    expect(mails[0]?.subject.startsWith('[Test] ')).toBe(true);
    expect(mails[0]?.personRef).toEqual({ kind: 'test', personId: SENDERS[0]?.id });
    expect(store.audits.at(-1)?.action).toBe('platform.outreach_test_sent');
  });
});

describe('OUTREACH MANAGER — recipients', () => {
  it('adds one person under the import rules', async () => {
    const store = new FakeStore();
    const { svc } = service(store);
    const base = { company: 'Blue Peak', firstName: 'Dan', email: 'dan@bluepeak.example' };
    await expect(
      svc.addRecipient(ACTOR, CAMPAIGN, { ...base, country: 'Germany' }, CONTEXT),
    ).rejects.toMatchObject({ details: [{ message: 'consent_country' }] });
    store.suppressedSet.add(outreachAddressHash('dan@bluepeak.example'));
    await expect(
      svc.addRecipient(ACTOR, CAMPAIGN, { ...base, country: 'Ireland' }, CONTEXT),
    ).rejects.toMatchObject({ details: [{ message: 'suppressed' }] });
    await expect(
      svc.addRecipient(
        ACTOR,
        CAMPAIGN,
        { ...base, company: 'Atlas Studio', email: 'x@atlas2.example', country: 'IE' },
        CONTEXT,
      ),
    ).rejects.toMatchObject({ details: [{ message: 'second_at_company' }] });
    const view = await svc.addRecipient(
      ACTOR,
      CAMPAIGN,
      { ...base, email: 'dan2@bluepeak.example', country: 'IE' },
      CONTEXT,
    );
    expect(view.recipients.map((r) => r.company)).toEqual(['Atlas Studio', 'Blue Peak']);
  });

  it('removes a person only while queued', async () => {
    const store = new FakeStore();
    store.people = [recipient(R1), recipient(R2, { status: 'sent', company: 'Other' })];
    const { svc } = service(store);
    await expect(svc.removeRecipient(ACTOR, R2, CONTEXT)).rejects.toMatchObject({ status: 409 });
    const view = await svc.removeRecipient(ACTOR, R1, CONTEXT);
    expect(view.recipients.map((r) => r.id)).toEqual([R2]);
  });

  it('exports with the address and formula cells neutralised; the export is audited', async () => {
    const store = new FakeStore();
    store.people = [recipient(R1, { company: '=HYPERLINK("x")' })];
    const view = await service(store).svc.exportCsv(ACTOR, CAMPAIGN, CONTEXT);
    expect(view.csv).toContain('"lena@atlas.example"');
    expect(view.csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(store.audits.at(-1)?.action).toBe('platform.outreach_recipients_exported');
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(maskAddress('sam@example.com')).toBe('s•••@example.com');
  });
});
