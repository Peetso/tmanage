import { describe, expect, it } from 'vitest';
import { createIdentityMailers } from './identity-mailer.js';
import type { MailDelivery, Mailer, MailMessage } from './mailer.js';
import { decodeQueuedMessage } from './queue-mailer.js';
import { MailCeilingReachedError } from './send-ceiling.js';
import { SenderResolvingMailer } from './sender-resolver.js';
import type { SmtpMailerOptions } from './smtp-mailer.js';

const SECRET = 'pa55-never-logged';
const base: SmtpMailerOptions = {
  host: 'smtp.example',
  port: 587,
  secure: false,
  username: 'noreply@tmanageapp.com',
  password: SECRET,
  fromAddress: 'noreply@tmanageapp.com',
  fromName: 'TManage',
};
const message: MailMessage = { to: 'a@client.example', subject: 's', text: 't' };

/** Fake drivers: each records which mailbox login it was built for and what it sent. */
function harness(logins: { hello?: boolean; support?: boolean } = { hello: true, support: true }) {
  const sent: { via: string; message: MailMessage }[] = [];
  const lines: string[] = [];
  const build = (options: SmtpMailerOptions): Mailer => ({
    send(m: MailMessage): Promise<MailDelivery> {
      sent.push({ via: options.fromAddress, message: m });
      return Promise.resolve('sent');
    },
  });
  const router = createIdentityMailers({
    base,
    build,
    hello: logins.hello ? { username: 'hello@tmanageapp.com', password: SECRET } : undefined,
    support: logins.support ? { username: 'support@tmanageapp.com', password: SECRET } : undefined,
    ceiling: { perHour: 10, perDay: 100, bulkShare: 0.8 },
    log: (line) => lines.push(line),
  });
  return { router, sent, lines };
}

const resolverOver = (inner: Mailer) =>
  new SenderResolvingMailer(inner, {
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
          name: 'Layla',
          role: 'product specialist',
          address: 'layla@tmanageapp.com',
        }),
    },
    log: () => undefined,
  });

describe('EMAILBUILD amendment 3 — one real mailbox per kind of mail', () => {
  it('maps each category to its mailbox; a tip leaves from the person own mailbox, Reply-To the person', async () => {
    const { router, sent } = harness();
    const mailer = resolverOver(router);
    const cases: [string, string][] = [
      ['password_reset', 'noreply@tmanageapp.com'],
      ['digest', 'noreply@tmanageapp.com'],
      ['invitation', 'noreply@tmanageapp.com'],
      ['ops_alert', 'noreply@tmanageapp.com'],
      ['welcome', 'hello@tmanageapp.com'],
      ['support_reply', 'support@tmanageapp.com'],
      ['tip', 'layla@tmanageapp.com'],
    ];
    for (const [templateKey, via] of cases) {
      await mailer.send({
        ...message,
        templateKey,
        organizationId: 'org-1',
        personRef: { kind: 'assigned', userId: 'u-1', topic: 'features' },
      });
      expect(sent.at(-1)?.via, templateKey).toBe(via);
    }
    expect(sent.at(-1)?.message.replyTo).toBe('layla@tmanageapp.com');
    expect(sent.at(-1)?.message.from?.name).toBe('Layla from TManage');
  });

  it('falls back to noreply for a mailbox without a login, says so once, never the password', async () => {
    const { router, sent, lines } = harness({ hello: false, support: false });
    await router.send({ ...message, identity: 'hello' });
    await router.send({ ...message, identity: 'support' });
    expect(sent.map((s) => s.via)).toEqual(['noreply@tmanageapp.com', 'noreply@tmanageapp.com']);
    expect(lines.filter((line) => line.includes('no login for'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(harness().lines.join('\n')).not.toContain(SECRET);
  });

  it('refuses an identity key off the closed list when a queued row is read', () => {
    const forged = JSON.stringify({ ...message, identity: 'ceo' });
    expect(decodeQueuedMessage(forged, 'tip')?.identity).toBeUndefined();
    const good = JSON.stringify({ ...message, identity: 'support' });
    expect(decodeQueuedMessage(good, 'support_reply')?.identity).toBe('support');
  });

  it('counts the ceiling per mailbox, and notices never starve codes', async () => {
    const { router } = harness();
    const notice = { ...message, optional: true };
    for (let i = 0; i < 8; i += 1) await router.send(notice);
    await expect(router.send(notice)).rejects.toBeInstanceOf(MailCeilingReachedError);
    // The same mailbox still sends a code (bulk may use only 80 %).
    await expect(router.send({ ...message, templateKey: 'password_reset' })).resolves.toBe('sent');
    // Another mailbox has its own count.
    for (let i = 0; i < 8; i += 1) await router.send({ ...notice, identity: 'support' });
  });
});
