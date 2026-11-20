import { describe, expect, it } from 'vitest';
import { deriveUnsubscribeKey, verifyUnsubscribeToken } from './list-unsubscribe.js';
import type { MailDelivery, Mailer, MailMessage } from './mailer.js';
import { NotificationMailTransport } from './notification-transport.js';
import { SenderResolvingMailer } from './sender-resolver.js';
import { TEMPLATE_KEYS } from './sender.js';
import { LINK_TOKENS, STILL_SENT_LINE, signOffText } from './sign-off.js';

/**
 * PERSONMAIL (ADR-0013) — fitness function: EVERY template key, every category (codes, security,
 * welcome, support, notices, agency to client, tips, internal), leaves with the RFC 8058 headers
 * and a footer holding "Notification settings" and "Unsubscribe". Mail a reader cannot switch off
 * says plainly that sign-in, security and account messages still come.
 */

const KEY = deriveUnsubscribeKey('suite-secret');
const URL_BASE = 'https://api.tmanageapp.com/v1/public/email/unsubscribe';

function chain() {
  const sent: MailMessage[] = [];
  const inner: Mailer = {
    send(message: MailMessage): Promise<MailDelivery> {
      sent.push(message);
      return Promise.resolve('sent');
    },
  };
  const resolver = new SenderResolvingMailer(inner, {
    identityAddress: 'noreply@tmanageapp.com',
    sendAs: false,
    addresses: {
      hello: 'hello@tmanageapp.com',
      support: 'support@tmanageapp.com',
      noreply: 'noreply@tmanageapp.com',
    },
    directory: {
      personFor: () =>
        Promise.resolve({
          name: 'Mariam',
          role: 'customer success',
          address: 'mariam@tmanageapp.com',
        }),
    },
    unsubscribe: { url: URL_BASE, key: KEY },
    log: () => undefined,
  });
  const notices = new NotificationMailTransport(resolver, { unsubscribeUrl: URL_BASE, key: KEY });
  return { resolver, notices, sent };
}

const message = (templateKey: string, language: 'en' | 'ar'): MailMessage => ({
  to: 'Reader@Example.com',
  subject: 'Subject',
  text: 'Body line.',
  html: '<html><body><p>Body line.</p></body></html>',
  templateKey,
  language,
  organizationId: 'org-1',
  personRef: { kind: 'assigned', userId: 'u-1', topic: 'onboarding' },
});

function unsubscribeUrl(sent: MailMessage): string {
  return /^<(.*)>$/u.exec(sent.headers?.['List-Unsubscribe'] ?? '')?.[1] ?? '';
}

describe('PERSONMAIL — every e-mail carries unsubscribe (headers + footer)', () => {
  it('walks every template key in both languages', async () => {
    expect(TEMPLATE_KEYS.length).toBeGreaterThan(30);
    for (const language of ['en', 'ar'] as const) {
      for (const templateKey of TEMPLATE_KEYS) {
        const { resolver, sent } = chain();
        await resolver.send(message(templateKey, language));
        const out = sent[0] as MailMessage;
        const where = `${templateKey}/${language}`;
        const url = unsubscribeUrl(out);
        expect(url, where).toMatch(
          /^https:\/\/api\.tmanageapp\.com\/v1\/public\/email\/unsubscribe\?t=/u,
        );
        // The existing token, unchanged in format, naming this recipient.
        expect(
          verifyUnsubscribeToken(KEY, new URL(url).searchParams.get('t')),
          where,
        ).not.toBeNull();
        expect(out.headers?.['List-Unsubscribe-Post'], where).toBe('List-Unsubscribe=One-Click');
        // Footer in text: both links, and the honest line (none of these is optional mail).
        expect(out.text, where).toContain(url);
        expect(out.text, where).toContain(`${URL_BASE}`);
        expect(out.text, where).toContain(language === 'ar' ? 'إلغاء الاشتراك' : 'Unsubscribe');
        expect(out.text, where).toContain(
          language === 'ar' ? 'إعدادات الإشعارات' : 'Notification settings',
        );
        expect(out.text, where).toContain(STILL_SENT_LINE[language]);
        // Footer in HTML: linked words, inside the body.
        expect(out.html, where).toContain(`href="${url.replaceAll('&', '&amp;')}"`);
        expect(out.html, where).toMatch(/<\/p>\n<\/body><\/html>$/u);
        expect(`${out.text}${out.html ?? ''}`, where).not.toContain('[[tm.link.');
      }
    }
  });

  it('optional mail keeps its own links line once, without the "still sent" line', async () => {
    const { notices, sent } = chain();
    await notices.send({
      ...message('collaboration_notice', 'en'),
      text: `Body.\n\n${signOffText('notice', 'en')}`,
    });
    const out = sent[0] as MailMessage;
    expect(out.text.split('Unsubscribe').length - 1).toBe(1);
    expect(out.text).not.toContain(STILL_SENT_LINE.en);
    expect(out.text).not.toContain(LINK_TOKENS.unsubscribe);
    expect(out.optional).toBe(true);
  });
});
