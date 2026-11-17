import { describe, expect, it, vi } from 'vitest';
import type { Mailer, MailMessage } from '@tmanage/mail';
import { composeWelcomeEmail, WelcomeMailer } from './welcome-email.js';

/**
 * Wave 9 S6, audit run 1 F36a: an anonymous sign-up could put its own sentences into a genuine
 * TManage welcome mail to any address through the display name and workspace name. The mail now
 * quotes nothing the person typed.
 */

const NAME = 'Billing: your card was charged $499 evil.example/x call +1-555-0100';
const WORKSPACE = 'Refund at refund-portal.example';
const FRAGMENTS = ['Billing', '$499', 'evil.example', '555-0100', 'refund-portal'];

function allText(message: MailMessage): string {
  return [message.subject, message.text, message.html].join('\n');
}

describe('the welcome email quotes nothing the sign-up typed (F36a)', () => {
  it.each(['en', 'ar'])('%s: no part of the name or workspace reaches the mail', async (locale) => {
    const sent: MailMessage[] = [];
    const mailer = {
      send: vi.fn(async (message: MailMessage) => {
        sent.push(message);
        return 'sent' as const;
      }),
    } as unknown as Mailer;
    const welcome = new WelcomeMailer(mailer, 'https://app.example/');
    // The shape the sign-up service delivered before the fix, names included: they are ignored.
    const facts = {
      to: 'victim@example.test',
      organizationSlug: 'refund',
      locale,
      displayName: NAME,
      organizationName: WORKSPACE,
    };
    await expect(welcome.deliver(facts)).resolves.toBe('sent');
    expect(sent).toHaveLength(1);
    const text = allText(sent[0] as MailMessage);
    for (const fragment of FRAGMENTS) expect(text).not.toContain(fragment);
    expect(sent[0]?.to).toBe('victim@example.test');
    // Run 2 F36a leftover: the link is the neutral sign-in page, never the typed slug.
    expect(sent[0]?.text).toContain('https://app.example/sign-in');
    expect(text).not.toContain('app.example/refund');
  });

  it('still says welcome and links the workspace', () => {
    const message = composeWelcomeEmail({
      to: 'mona@example.com',
      link: 'https://app.example/nile',
    });
    expect(message.subject).toBe('Welcome to TManage');
    expect(message.text).toContain('Your workspace is ready');
    expect(message.html).toContain('https://app.example/nile');
    const arabic = composeWelcomeEmail({
      to: 'mona@example.com',
      link: 'https://app.example/nile',
      locale: 'ar',
    });
    expect(arabic.subject).toBe('‏أهلًا بك في TManage');
  });
});
