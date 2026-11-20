import { describe, expect, it } from 'vitest';
import {
  deriveUnsubscribeKey,
  emailAddressHash,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from './list-unsubscribe.js';
import type { Mailer, MailMessage } from './mailer.js';
import { NotificationMailTransport } from './notification-transport.js';
import { MailCeilingReachedError, SendCeilingMailer } from './send-ceiling.js';

const key = deriveUnsubscribeKey('a-session-secret-of-enough-length-000');
const message: MailMessage = { to: 'Ana@Example.com', subject: 's', text: 't' };

function recorder(): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return { sent, send: (m) => (sent.push(m), Promise.resolve('sent')) };
}

describe('51-11 deliverability', () => {
  it('a token verifies to the address hash and a tampered one does not', () => {
    const token = signUnsubscribeToken(key, ' ana@example.com ');
    expect(verifyUnsubscribeToken(key, token)).toBe(emailAddressHash('ANA@example.com'));
    expect(verifyUnsubscribeToken(key, `${token.slice(0, -2)}xx`)).toBeNull();
    expect(
      verifyUnsubscribeToken(deriveUnsubscribeKey('other-secret-000000000000'), token),
    ).toBeNull();
  });

  it('stamps one-click headers, and a suppressed recipient is never submitted', async () => {
    const inner = recorder();
    const suppressed = new Set<string>();
    const transport = new NotificationMailTransport(inner, {
      unsubscribeUrl: 'https://t.example/v1/public/email/unsubscribe',
      key,
      suppressions: { isSuppressed: (hash) => Promise.resolve(suppressed.has(hash)) },
    });
    await transport.send(message);
    expect(inner.sent[0]?.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(inner.sent[0]?.headers?.['List-Unsubscribe']).not.toContain('example.com?');
    suppressed.add(emailAddressHash(message.to));
    expect(await transport.send(message)).toBe('none');
    expect(inner.sent).toHaveLength(1);
  });

  it('the ceiling keeps headroom for transactional mail over bulk', async () => {
    const capped = new SendCeilingMailer(recorder(), { perHour: 10, perDay: 100, bulkShare: 0.5 });
    const bulk = { ...message, optional: true };
    for (let i = 0; i < 5; i += 1) await capped.send(bulk);
    await expect(capped.send(bulk)).rejects.toBeInstanceOf(MailCeilingReachedError);
    for (let i = 0; i < 5; i += 1) await capped.send(message);
    await expect(capped.send(message)).rejects.toBeInstanceOf(MailCeilingReachedError);
  });
});
