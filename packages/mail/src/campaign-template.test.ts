import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_LANGUAGES,
  CAMPAIGN_UNSUBSCRIBE_LINES,
  DEFAULT_CAMPAIGN_EMAILS,
  campaignLinks,
  campaignTextProblems,
  renderCampaignEmail,
} from './campaign-template.js';
import { LINK_TOKENS } from './sign-off.js';

/**
 * OUTREACH MANAGER — the editable outreach e-mail. What an editor cannot change: the unsubscribe
 * line (with the one-click token the sender resolver fills) is always the last line, a US person
 * always gets the postal address, a substituted value cannot inject a token or a header line, and
 * a text with HTML, an unknown placeholder or a reserved token is refused before it is saved.
 */

const VALUES = {
  firstName: 'Lena',
  company: 'Atlas Studio',
  senderName: 'Emma',
  trialUrl: 'https://tmanageapp.com/sign-up?trial=t',
  bookingUrl: 'https://tmanageapp.com/walkthrough?invite=t',
};

describe('OUTREACH MANAGER — the campaign template', () => {
  it('has an unsubscribe line with the link token in every language', () => {
    for (const language of CAMPAIGN_LANGUAGES) {
      expect(CAMPAIGN_UNSUBSCRIBE_LINES[language]).toContain(LINK_TOKENS.unsubscribe);
    }
  });

  it('always ends with the unsubscribe line, and adds the postal address for a US person only', () => {
    const text = { subject: 'Hi {first name}', body: 'Hello {first name} at {company}.' };
    const us = renderCampaignEmail({
      text,
      language: 'en',
      values: VALUES,
      country: 'US',
      postalAddress: '1 Main St, Austin, TX 78701',
    });
    expect(us.subject).toBe('Hi Lena');
    expect(us.text.split('\n')).toEqual([
      'Hello Lena at Atlas Studio.',
      '1 Main St, Austin, TX 78701',
      '',
      CAMPAIGN_UNSUBSCRIBE_LINES.en,
    ]);
    const gb = renderCampaignEmail({
      text,
      language: 'en',
      values: VALUES,
      country: 'GB',
      postalAddress: '1 Main St, Austin, TX 78701',
    });
    expect(gb.text).not.toContain('Austin');
    expect(gb.text.endsWith(CAMPAIGN_UNSUBSCRIBE_LINES.en)).toBe(true);
  });

  it('substitutes once: a value cannot add a token, a placeholder or a line break', () => {
    const out = renderCampaignEmail({
      text: { subject: '{company}', body: '{company}' },
      language: 'en',
      values: { ...VALUES, company: 'Evil [[tm.link.unsubscribe]]\nBcc: x {first name}' },
      country: 'GB',
      postalAddress: '',
    });
    expect(out.subject).not.toContain('\n');
    expect(out.subject).not.toContain('[[tm.');
    expect(out.subject).toContain('{first name}');
    expect(out.text.split(LINK_TOKENS.unsubscribe)).toHaveLength(2);
  });

  it('refuses HTML, unknown placeholders, a link in the subject and reserved tokens', () => {
    expect(campaignTextProblems({ subject: 'S', body: '<p>Hi</p>' })).toContain('html_not_allowed');
    expect(campaignTextProblems({ subject: 'S', body: 'Hi {last name}' })).toContain(
      'unknown_placeholder',
    );
    expect(campaignTextProblems({ subject: 'Try {trial link}', body: 'B' })).toContain(
      'subject_placeholder',
    );
    expect(campaignTextProblems({ subject: 'S', body: LINK_TOKENS.unsubscribe })).toContain(
      'reserved_token',
    );
    expect(campaignTextProblems({ subject: '', body: '' })).toEqual(
      expect.arrayContaining(['subject_empty', 'body_empty']),
    );
  });

  it('accepts the default texts as they are', () => {
    for (const kind of ['intro', 'followup'] as const) {
      for (const language of ['en', 'ar'] as const) {
        const text = DEFAULT_CAMPAIGN_EMAILS[kind][language];
        expect(text, `${kind} ${language}`).toBeDefined();
        expect(campaignTextProblems(text ?? { subject: '', body: '' })).toEqual([]);
      }
    }
  });

  it('builds the links on the site in the person’s language, with the invite on the booking', () => {
    const ar = campaignLinks('https://tmanageapp.com/', 'ar', 'tok');
    expect(ar.trialUrl).toBe(
      'https://tmanageapp.com/ar/sign-up?trial=tok&utm_source=campaign&utm_medium=email&utm_campaign=outreach-v1',
    );
    expect(ar.bookingUrl).toBe(
      'https://tmanageapp.com/ar/walkthrough?utm_source=campaign&invite=tok',
    );
    const fr = campaignLinks('https://tmanageapp.com', 'fr', 'tok');
    expect(fr.bookingUrl).toBe(
      'https://tmanageapp.com/walkthrough?utm_source=campaign&invite=tok&lang=fr',
    );
  });
});
