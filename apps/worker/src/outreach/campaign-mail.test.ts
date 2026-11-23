import { describe, expect, it } from 'vitest';
import { LINK_TOKENS } from '@tmanage/mail';
import { campaignLinks, composeCampaignIntro } from './campaign-mail.js';
import type { CampaignMailInput } from './campaign-mail.js';
import {
  MAX_PER_MAILBOX_PER_DAY,
  dailyCap,
  inSendWindow,
  mailboxMaySend,
  spacingMs,
} from './campaign-pace.js';

/** LANE-Q — the campaign's pace rules and the introduction's exact shape. */

const DAY = 86_400_000;
const START = new Date('2026-11-23T08:00:00Z');

describe('LANE-Q campaign pace — 5, then 10, then 20 a day, never more', () => {
  it('ramps by campaign week and never passes 20', () => {
    expect(dailyCap(START, new Date(START.getTime() + 0))).toBe(5);
    expect(dailyCap(START, new Date(START.getTime() + 6 * DAY))).toBe(5);
    expect(dailyCap(START, new Date(START.getTime() + 7 * DAY))).toBe(10);
    expect(dailyCap(START, new Date(START.getTime() + 13 * DAY))).toBe(10);
    expect(dailyCap(START, new Date(START.getTime() + 14 * DAY))).toBe(20);
    expect(dailyCap(START, new Date(START.getTime() + 400 * DAY))).toBe(MAX_PER_MAILBOX_PER_DAY);
  });

  it('spaces sends 8 h / cap apart and stops at the cap', () => {
    const now = new Date('2026-11-23T12:00:00Z');
    expect(spacingMs(5)).toBe(96 * 60_000);
    expect(spacingMs(20)).toBe(24 * 60_000);
    const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
    expect(mailboxMaySend({ attempts24h: 0, lastAttemptAt: null }, 5, now)).toBe(true);
    expect(mailboxMaySend({ attempts24h: 1, lastAttemptAt: ago(95) }, 5, now)).toBe(false);
    expect(mailboxMaySend({ attempts24h: 1, lastAttemptAt: ago(96) }, 5, now)).toBe(true);
    expect(mailboxMaySend({ attempts24h: 5, lastAttemptAt: ago(600) }, 5, now)).toBe(false);
    expect(mailboxMaySend({ attempts24h: 20, lastAttemptAt: ago(600) }, 99, now)).toBe(false);
  });

  it('sends only 09:00-17:00 in the recipient zone, never in an unknown zone', () => {
    // 07:30 UTC = 09:30 Helsinki (EET), 11:30 Dubai, 02:30 Toronto (EST).
    const at = new Date('2026-11-23T07:30:00Z');
    expect(inSendWindow(at, 'Europe/Helsinki')).toBe(true);
    expect(inSendWindow(at, 'Asia/Dubai')).toBe(true);
    expect(inSendWindow(at, 'America/Toronto')).toBe(false);
    // 15:00 UTC = 17:00 Helsinki: the window is closed at 17:00.
    expect(inSendWindow(new Date('2026-11-23T15:00:00Z'), 'Europe/Helsinki')).toBe(false);
    expect(inSendWindow(at, 'Not/AZone')).toBe(false);
  });
});

const INPUT: CampaignMailInput = {
  to: 'eeva@eta.example',
  language: 'en',
  firstName: 'Eeva',
  company: 'Eta Studio',
  senderName: 'Emma',
  senderPersonId: 'p-emma',
  country: 'FI',
  postalAddress: '1 Al Horeya St. - Cairo - Egypt',
  trialUrl: 'https://tmanageapp.com/sign-up?trial=t',
  bookingUrl: 'https://tmanageapp.com/walkthrough?utm_source=campaign',
};

describe('LANE-Q campaign mail — one teammate, plain text, personal unsubscribe last', () => {
  it('greets by first name, signs as the person, ends with the unsubscribe line', () => {
    const mail = composeCampaignIntro(INPUT);
    const lines = mail.text.split('\n');
    expect(lines[0]).toBe('Hi Eeva,');
    expect(mail.text).not.toMatch(/Hi there/u);
    expect(mail.text).toContain('like Eta Studio.');
    // Owner 2026-11-23: no city line, the eight languages, what comes next, 3 free months after.
    expect(mail.text).toContain('Best,\nEmma\nTManage · tmanageapp.com\n\n');
    expect(mail.text).not.toContain('Cairo');
    expect(mail.text).toContain('Fully localized: English, Arabic, French');
    expect(mail.text).toContain('Coming in the next 1-2 months:');
    expect(mail.text).toContain('3 more months after the beta ends');
    expect(lines.at(-1)).toBe(
      `If this isn't relevant, just say so, or use this link and I won't write again: ${LINK_TOKENS.unsubscribe}`,
    );
    expect(mail.text).not.toContain('Al Horeya');
    expect(mail).toMatchObject({
      to: 'eeva@eta.example',
      subject: 'Client approvals without the email chase',
      templateKey: 'campaign_intro',
      personRef: { kind: 'campaign', personId: 'p-emma' },
    });
    expect(mail.html).toBeUndefined();
  });

  it('gives a US recipient the postal address (CAN-SPAM), and only them', () => {
    const mail = composeCampaignIntro({ ...INPUT, country: 'US' });
    expect(mail.text).toContain('TManage · tmanageapp.com\n1 Al Horeya St. - Cairo - Egypt\n');
  });

  it('writes the Arabic text with no city line and the unsubscribe line', () => {
    const mail = composeCampaignIntro({ ...INPUT, language: 'ar', senderName: 'مريم' });
    expect(mail.subject).toBe('موافقات العملاء دون ملاحقة عبر البريد');
    expect(mail.text.split('\n')[0]).toBe('مرحباً Eeva،');
    expect(mail.text).toContain('مريم\nTManage · tmanageapp.com\n\n');
    expect(mail.text).not.toContain('القاهرة، مصر');
    expect(mail.text.split('\n').at(-1)).toBe(
      `إن لم يكن هذا مناسباً لكم، يكفي الرد بذلك، أو من هذا الرابط ولن أراسلكم مجدداً: ${LINK_TOKENS.unsubscribe}`,
    );
  });

  it('puts the trial token and attribution in the URL, on the language site', () => {
    const en = campaignLinks('https://tmanageapp.com/', 'en', 'v1.abc');
    expect(en.trialUrl).toBe(
      'https://tmanageapp.com/sign-up?trial=v1.abc&utm_source=campaign&utm_medium=email&utm_campaign=outreach-v1',
    );
    expect(en.bookingUrl).toBe('https://tmanageapp.com/walkthrough?utm_source=campaign');
    expect(campaignLinks('https://tmanageapp.com', 'ar', 'x').trialUrl).toMatch(
      /^https:\/\/tmanageapp\.com\/ar\/sign-up\?trial=x&/u,
    );
  });
});
