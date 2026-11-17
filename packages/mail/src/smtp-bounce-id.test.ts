import { describe, expect, it, vi } from 'vitest';

const sendMail = vi.fn((options: { messageId?: string }) =>
  Promise.resolve({ messageId: options.messageId ?? '<random@host>', rejected: [] }),
);
vi.mock('nodemailer', () => ({ createTransport: () => ({ sendMail }) }));

const { SmtpMailer } = await import('./smtp-mailer.js');
const { deriveBounceKey, readBounceMessageId } = await import('./bounce-id.js');
const { emailAddressHash } = await import('./list-unsubscribe.js');

const KEY = deriveBounceKey('s'.repeat(48));
const ORG = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
const mailer = new SmtpMailer({
  host: 'smtp.test',
  port: 587,
  secure: false,
  fromAddress: 'noreply@tm.io',
  fromName: 'TManage',
  bounceKey: KEY,
});

describe('56-26 SmtpMailer Message-ID', () => {
  it('signs company mail for its company and recipient; leaves platform mail unsigned', async () => {
    const receipt = await mailer.submit({
      to: 'ann@client.example',
      subject: 's',
      text: 't',
      organizationId: ORG,
    });
    expect(readBounceMessageId(KEY, receipt.messageId as string)).toMatchObject({
      organizationId: ORG,
      addressHash: emailAddressHash('ann@client.example'),
    });
    expect(receipt.messageId).toMatch(/@tm\.io>$/u);
    await mailer.submit({ to: 'ann@client.example', subject: 's', text: 't' });
    expect(sendMail.mock.calls[1]?.[0]).not.toHaveProperty('messageId');
  });
});
