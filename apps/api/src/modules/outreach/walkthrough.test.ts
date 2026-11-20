import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createFieldCipher, loadFieldCipherKeyring } from '@tmanage/domain/field-cipher';
import type { MailMessage } from '@tmanage/mail';
import { ApiError } from '../../common/http/errors.js';
import type { PublicWriteVerdict } from '../public-abuse/public-abuse.guard.js';
import {
  composeSalesNotification,
  parseWalkthroughRequest,
  wallClockToInstant,
} from './walkthrough-content.js';
import type { WalkthroughRecord, WalkthroughStore } from './walkthrough.repository.js';
import { WalkthroughService } from './walkthrough.service.js';

/**
 * LANE-Q — "Book a walkthrough": the parser, the honeypot and abuse paths, what is stored (never
 * the plain address) and the mail to sales@ (from sales@, Reply-To the visitor).
 */

const NOW = new Date('2026-11-20T10:00:00Z');
const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Sam Rivera',
  email: 'Sam@Agency.example',
  company: 'Atlas Studio',
  teamSize: '11-50',
  timeZone: 'Africa/Cairo',
  slots: ['2026-11-25T10:00', '2026-11-26T14:30', '2026-11-27T11:00'],
  topics: ['tour', 'switch'],
  consent: true,
  language: 'en',
  source: 'campaign',
  ...over,
});

function problems(raw: Record<string, unknown>): string[] {
  try {
    parseWalkthroughRequest(raw, NOW);
    return [];
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return (error.details ?? []).map((d) => d.field);
  }
}

describe('LANE-Q walkthrough — the parser', () => {
  it('accepts a full request and normalises the address', () => {
    const input = parseWalkthroughRequest(body(), NOW);
    expect(input.email).toBe('sam@agency.example');
    expect(input.slots).toEqual(['2026-11-25T10:00', '2026-11-26T14:30', '2026-11-27T11:00']);
    expect(input.topics).toEqual(['tour', 'switch']);
    expect(input.source).toBe('campaign');
  });

  it('refuses without consent, a topic, a known time zone or three future, distinct times', () => {
    expect(problems(body({ consent: false }))).toContain('consent');
    expect(problems(body({ topics: [] }))).toContain('topics');
    expect(problems(body({ topics: ['tour', 'pricing'] }))).toContain('topics');
    expect(problems(body({ timeZone: 'Mars/Olympus' }))).toContain('timeZone');
    expect(
      problems(body({ slots: ['2026-11-25T10:00', '2026-11-25T10:00', '2026-11-27T11:00'] })),
    ).toContain('slots.1');
    expect(
      problems(body({ slots: ['2026-11-19T10:00', '2026-11-26T14:30', '2026-11-27T11:00'] })),
    ).toContain('slots.0');
    expect(
      problems(body({ slots: ['2026-02-30T10:00', '2026-11-26T14:30', '2026-11-27T11:00'] })),
    ).toContain('slots.0');
    expect(
      problems(body({ slots: ['2027-06-01T10:00', '2026-11-26T14:30', '2026-11-27T11:00'] })),
    ).toContain('slots.0');
    expect(problems(body({ company: 'Atlas\r\nBcc: x@y' }))).toContain('company');
  });

  it('reads a wall-clock time in the visitor zone, DST included', () => {
    expect(wallClockToInstant('2026-11-25T10:00', 'Africa/Cairo')?.toISOString()).toBe(
      '2026-11-25T08:00:00.000Z',
    );
    expect(wallClockToInstant('2026-07-01T09:00', 'America/New_York')?.toISOString()).toBe(
      '2026-07-01T13:00:00.000Z',
    );
  });

  it('writes the sales mail with the times in both the visitor zone and UTC', () => {
    const mail = composeSalesNotification(parseWalkthroughRequest(body(), NOW), 'WT-ABCDEFGH');
    expect(mail.to).toBe('sales@tmanageapp.com');
    expect(mail.templateKey).toBe('walkthrough_request');
    expect(mail.replyTo).toBe('sam@agency.example');
    expect(mail.text).toContain('Africa/Cairo) = 08:00 UTC');
    expect(mail.text).toContain('- Why switch from their current tool');
  });
});

class FakeStore implements WalkthroughStore {
  readonly rows: WalkthroughRecord[] = [];
  readonly notified: string[] = [];
  insert(record: WalkthroughRecord): Promise<void> {
    this.rows.push(record);
    return Promise.resolve();
  }
  markNotified(id: string): Promise<void> {
    this.notified.push(id);
    return Promise.resolve();
  }
}

const KEYRING = createFieldCipher(
  loadFieldCipherKeyring({ FIELD_CIPHER_KEYS: `1:${randomBytes(32).toString('base64')}` }),
);

function service(options: { verdict?: PublicWriteVerdict; failMail?: boolean } = {}) {
  const store = new FakeStore();
  const mails: MailMessage[] = [];
  const svc = new WalkthroughService(
    store,
    KEYRING,
    {
      send: (message) => {
        if (options.failMail === true) return Promise.reject(new Error('smtp down'));
        mails.push(message);
        return Promise.resolve('sent');
      },
    },
    options.verdict === undefined
      ? null
      : () => Promise.resolve(options.verdict as PublicWriteVerdict),
    () => NOW,
    () => undefined,
  );
  const submit = (raw: Record<string, unknown>) =>
    svc.submit({ body: raw, ip: '198.51.100.7', acceptLanguage: 'en', correlationId: 'c-1' });
  return { store, mails, submit };
}

describe('LANE-Q walkthrough — the door', () => {
  it('stores the request with the address sealed and mails sales@', async () => {
    const h = service();
    const result = await h.submit(body());
    expect(result.kind).toBe('accepted');
    expect(h.store.rows).toHaveLength(1);
    const row = h.store.rows[0] as WalkthroughRecord;
    expect(row.emailEnc).not.toBeNull();
    expect(row.emailEnc).not.toContain('sam@agency.example');
    expect(row.topics).toBe('tour,switch');
    expect(h.mails.map((m) => m.to)).toEqual(['sales@tmanageapp.com']);
    expect(h.store.notified).toEqual([row.id]);
  });

  it('a filled honeypot answers like a success and stores and mails nothing', async () => {
    const h = service();
    const result = await h.submit(body({ website: 'http://spam.example' }));
    expect(result.kind).toBe('accepted');
    expect(h.store.rows).toHaveLength(0);
    expect(h.mails).toHaveLength(0);
  });

  it('spam stores nothing; a challenge is held (stored, not mailed); a window is a 429', async () => {
    const spam = service({ verdict: { decision: 'spam', score: 80, reasons: [] } });
    await spam.submit(body());
    expect(spam.store.rows).toHaveLength(0);
    const held = service({ verdict: { decision: 'challenge', score: 50, reasons: [] } });
    await held.submit(body());
    expect(held.store.rows[0]?.riskDecision).toBe('hold');
    expect(held.mails).toHaveLength(0);
    const limited = service({
      verdict: { decision: 'blocked', score: 100, reasons: [], retryAfterSeconds: 60 },
    });
    expect(await limited.submit(body())).toEqual({ kind: 'rate_limited', retryAfterSeconds: 60 });
  });

  it('a mail failure keeps the request and leaves it unnotified', async () => {
    const h = service({ failMail: true });
    expect((await h.submit(body())).kind).toBe('accepted');
    expect(h.store.rows).toHaveLength(1);
    expect(h.store.notified).toHaveLength(0);
  });
});
