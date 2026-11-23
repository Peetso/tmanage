import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFieldCipher, loadFieldCipherKeyring } from '@tmanage/domain/field-cipher';
import { deriveTrialLinkKey, signTrialLink } from '@tmanage/mail';
import { ApiError } from '../../common/http/errors.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import type { PlatformAuditInput } from '../platform-admin/platform-admin.repository.js';
import {
  outreachAddressHash,
  parseCsv,
  planOutreachImport,
  readDecisionMakersCsv,
} from './outreach-import.js';
import { OutreachCampaignService, type OutreachStore } from './outreach-campaign.service.js';
import type {
  CampaignRecord,
  NewCampaign,
  RecipientInsert,
  TrialRecipient,
} from './outreach.repository.js';
import { TrialInvites } from './trial-invites.js';

/**
 * LANE-Q — the outreach import rules, the campaign's start/pause/stop, and the trial link's
 * pre-fill (valid, expired, used, tampered). The worker's sending rules are proved in
 * `apps/worker/src/outreach/campaign-sender.test.ts`.
 */

const HEADER =
  'company,country,segment,person_name,title,work_email,source_url,checked_at_utc,notes';
const row = (company: string, country: string, name: string, email: string, notes = '') =>
  `${company},${country},B - agency,${name},Founder,${email},https://x.example,2026-11-20T10:00Z,"${notes}"`;

const SENDERS = [
  { id: 'p-emma', address: 'emma@tmanageapp.com' },
  { id: 'p-daniel', address: 'daniel@tmanageapp.com' },
  { id: 'p-mariam', address: 'mariam@tmanageapp.com' },
];
const OPTIONS = {
  senders: SENDERS,
  postalAddressSet: true,
  knownHashes: new Set<string>(),
  knownCompanies: new Set<string>(),
};

describe('LANE-Q outreach import — who may be written to', () => {
  it('parses quoted fields with commas, quotes and line breaks', () => {
    expect(parseCsv('a,"b, ""c""\nd",e\r\nf,g,h\n')).toEqual([
      ['a', 'b, "c"\nd', 'e'],
      ['f', 'g', 'h'],
    ]);
  });

  it('excludes DE, DK and NO, unknown countries, flagged rows and bad rows', () => {
    const csv = [
      HEADER,
      row('Alpha', 'Germany', 'Anna Berg', 'anna@alpha.example'),
      row('Beta', 'Denmark', 'Bo Lund', 'bo@beta.example'),
      row('Gamma', 'Norway', 'Gro Dahl', 'gro@gamma.example'),
      row('Delta', 'Atlantis', 'Dee Sea', 'dee@delta.example'),
      row(
        'Ologie',
        'US',
        'Matthew Freedman',
        'mf@ologie.example',
        'mailto differs - confirm before sending',
      ),
      row('Eps', 'UK', '', 'x@eps.example'),
      row('Zeta', 'UK', 'Zed Zee', 'not-an-address'),
      row('Eta', 'Finland', 'Eeva Koski', 'eeva@eta.example'),
    ].join('\n');
    const plan = planOutreachImport(readDecisionMakersCsv(csv), OPTIONS);
    expect(plan.recipients.map((r) => r.company)).toEqual(['Eta']);
    expect(plan.excluded).toEqual({
      consent_country: 3,
      unknown_country: 1,
      flagged: 1,
      no_name: 1,
      bad_email: 1,
    });
  });

  it('keeps the first person per company and one row per address, here and before', () => {
    const csv = [
      HEADER,
      row('North Seventy Five', 'UAE', 'Lisa Welsh', 'lisa@n75.example'),
      row('North Seventy Five', 'UAE', 'Iman Issa', 'iman@n75.example'),
      row('Other', 'UK', 'Lisa Welsh', 'LISA@n75.example'),
      row('Known Co', 'UK', 'Kim Known', 'kim@known.example'),
      row('Seen', 'UK', 'Sam Seen', 'sam@seen.example'),
    ].join('\n');
    const plan = planOutreachImport(readDecisionMakersCsv(csv), {
      ...OPTIONS,
      knownCompanies: new Set(['known co']),
      knownHashes: new Set([outreachAddressHash('sam@seen.example')]),
    });
    expect(plan.recipients.map((r) => `${r.company}/${r.firstName}`)).toEqual([
      'North Seventy Five/Lisa',
    ]);
    expect(plan.excluded).toEqual({ second_at_company: 2, duplicate_address: 2 });
  });

  it('skips the US only while no postal address is set (CAN-SPAM)', () => {
    const csv = [HEADER, row('Usa Co', 'US', 'Una Smith', 'una@usa.example')].join('\n');
    expect(planOutreachImport(readDecisionMakersCsv(csv), OPTIONS).recipients).toHaveLength(1);
    const without = planOutreachImport(readDecisionMakersCsv(csv), {
      ...OPTIONS,
      postalAddressSet: false,
    });
    expect(without.excluded).toEqual({ us_without_postal_address: 1 });
  });

  it('writes English from the non-Arabic senders, spread evenly, in the country zone', () => {
    const csv = [
      HEADER,
      row('A1', 'UAE', 'Ali One', 'a1@a.example'),
      row('A2', 'Finland', 'Aino Two', 'a2@a.example'),
      row('A3', 'Canada', 'Abe Three', 'a3@a.example'),
    ].join('\n');
    const plan = planOutreachImport(readDecisionMakersCsv(csv), OPTIONS);
    expect(plan.recipients.map((r) => r.language)).toEqual(['en', 'en', 'en']);
    expect(plan.recipients.map((r) => r.senderPersonId)).toEqual(['p-emma', 'p-daniel', 'p-emma']);
    expect(plan.recipients.map((r) => r.timeZone)).toEqual([
      'Asia/Dubai',
      'Europe/Helsinki',
      'America/Toronto',
    ]);
  });

  it('refuses a file without the required columns', () => {
    expect(() => readDecisionMakersCsv('company,country\nA,UK')).toThrow(ApiError);
  });
});

const KEYS = loadFieldCipherKeyring({
  FIELD_CIPHER_KEYS: `1:${randomBytes(32).toString('base64')}`,
});
const CIPHER = createFieldCipher(KEYS);
const ACTOR = {
  account: { userId: 'u-admin', email: 'admin@tmanageapp.com' },
} as PlatformAdminActor;
const CONTEXT = { correlationId: 'c-1', ip: null, userAgent: null } as never;

class FakeStore implements OutreachStore {
  campaignsList: CampaignRecord[] = [];
  inserted: RecipientInsert[] = [];
  audits: PlatformAuditInput[] = [];
  activeSenders = () => Promise.resolve(SENDERS);
  known = () => Promise.resolve({ hashes: new Set<string>(), companies: [] as string[], rows: [] });
  suppressed = () => Promise.resolve(new Set<string>());
  latestVersions = () => Promise.resolve([]);
  versionsSeeded: NewCampaign['versions'][] = [];
  insertCampaign = (c: NewCampaign, r: readonly RecipientInsert[], audit: PlatformAuditInput) => {
    this.campaignsList.unshift({
      id: c.id,
      name: c.name,
      status: 'paused',
      languages: c.languages,
      senderPool: c.senderPool,
      dailyCap: c.dailyCap,
      warmup: c.warmup,
      followupEnabled: c.followupEnabled,
      followupDays: c.followupDays,
      archivedAt: null,
      firstStartedAt: null,
      createdAt: c.at,
    });
    this.versionsSeeded.push(c.versions);
    this.inserted.push(...r);
    this.audits.push(audit);
    return Promise.resolve();
  };
  campaigns = () => Promise.resolve(this.campaignsList);
  campaign = (id: string) => Promise.resolve(this.campaignsList.find((c) => c.id === id) ?? null);
  counts = () => Promise.resolve(new Map());
  recipients = () => Promise.resolve([]);
  setStatus = (
    id: string,
    from: string,
    to: CampaignRecord['status'],
    at: Date,
    audit: PlatformAuditInput,
  ) => {
    const c = this.campaignsList.find((x) => x.id === id);
    if (c === undefined || c.status !== from) return Promise.resolve(false);
    Object.assign(c, {
      status: to,
      firstStartedAt: c.firstStartedAt ?? (to === 'running' ? at : null),
    });
    this.audits.push(audit);
    return Promise.resolve(true);
  };
  markBounced = () => Promise.resolve(true);
}

describe('LANE-Q outreach campaign — created paused, then start, pause, stop', () => {
  const csv = [HEADER, row('Eta', 'Finland', 'Eeva Koski', 'eeva@eta.example')].join('\n');

  it('imports paused, stores the address sealed, audits counts only', async () => {
    const store = new FakeStore();
    const service = new OutreachCampaignService(
      store,
      CIPHER,
      () => '1 Al Horeya St. - Cairo - Egypt',
    );
    const view = await service.importCsv(ACTOR, { csv }, CONTEXT);
    expect(view.imported).toBe(1);
    expect(view.campaigns[0]?.status).toBe('paused');
    const stored = store.inserted[0] as RecipientInsert;
    expect(stored.emailEnc).not.toContain('eeva@eta.example');
    expect(CIPHER.decrypt(stored.emailEnc, { purpose: 'outreach_email', ownerId: stored.id })).toBe(
      'eeva@eta.example',
    );
    expect(store.audits[0]?.afterJson).not.toContain('eeva');
  });

  it('start sets the pace anchor; a stopped campaign never starts again', async () => {
    const store = new FakeStore();
    const service = new OutreachCampaignService(store, CIPHER, () => 'x');
    await service.importCsv(ACTOR, { csv }, CONTEXT);
    const id = (store.campaignsList[0] as CampaignRecord).id;
    expect((await service.move(ACTOR, id, 'start', CONTEXT)).campaigns[0]?.status).toBe('running');
    expect(store.campaignsList[0]?.firstStartedAt).not.toBeNull();
    await service.move(ACTOR, id, 'pause', CONTEXT);
    await service.move(ACTOR, id, 'stop', CONTEXT);
    await expect(service.move(ACTOR, id, 'start', CONTEXT)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses to import addresses on a keyless host', async () => {
    const service = new OutreachCampaignService(
      new FakeStore(),
      createFieldCipher(loadFieldCipherKeyring({})),
      () => 'x',
    );
    await expect(service.importCsv(ACTOR, { csv }, CONTEXT)).rejects.toMatchObject({ status: 409 });
  });
});

describe('LANE-Q trial link — the pre-fill works once, for 30 days', () => {
  const key = deriveTrialLinkKey('suite-secret');
  const id = '0199aa00-0000-7000-8000-0000000000aa';
  const now = new Date('2026-11-20T10:00:00Z');
  const recipient = (redeemed = false, company = 'Atlas Studio'): TrialRecipient => ({
    id,
    company,
    emailEnc: CIPHER.encrypt('lead@atlas.example', { purpose: 'outreach_email', ownerId: id }),
    language: 'en',
    redeemed,
  });
  const stamped: string[] = [];
  const invites = (row: TrialRecipient | null, at = now) =>
    new TrialInvites(
      {
        trialRecipient: () => Promise.resolve(row),
        stampWalkthrough: (recipientId: string) => {
          stamped.push(recipientId);
          return Promise.resolve(true);
        },
      },
      CIPHER,
      key,
      () => at,
    );
  const token = signTrialLink(
    key,
    { recipientId: id, email: 'lead@atlas.example', company: 'Atlas Studio' },
    now,
  );

  it('answers the company and address for a valid, unused link', async () => {
    expect(await invites(recipient()).lookup(token, 'c')).toEqual({
      kind: 'valid',
      recipientId: id,
      company: 'Atlas Studio',
      email: 'lead@atlas.example',
      language: 'en',
    });
    expect(await invites(recipient()).validRecipient(token, 'c')).toBe(id);
  });

  it('says used, expired or invalid otherwise', async () => {
    expect((await invites(recipient(true)).lookup(token, 'c')).kind).toBe('used');
    const late = new Date(now.getTime() + 31 * 86_400_000);
    expect((await invites(recipient(), late).lookup(token, 'c')).kind).toBe('expired');
    expect((await invites(recipient(false, 'Other Co')).lookup(token, 'c')).kind).toBe('invalid');
    expect((await invites(null).lookup(token, 'c')).kind).toBe('invalid');
    expect((await invites(recipient()).lookup('v1.x', 'c')).kind).toBe('invalid');
    expect(await invites(recipient(true)).validRecipient(token, 'c')).toBeNull();
  });

  it('credits a walkthrough booking only for a token that verifies (used or not)', async () => {
    stamped.length = 0;
    expect(await invites(recipient(true)).stampBooking(token, now, 'c')).toBe(true);
    const late = new Date(now.getTime() + 31 * 86_400_000);
    expect(await invites(recipient(), late).stampBooking(token, late, 'c')).toBe(false);
    expect(await invites(recipient(false, 'Other Co')).stampBooking(token, now, 'c')).toBe(false);
    expect(await invites(recipient()).stampBooking('v1.x', now, 'c')).toBe(false);
    expect(stamped).toEqual([id]);
  });
});
