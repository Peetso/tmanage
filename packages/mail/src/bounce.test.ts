import { describe, expect, it, vi } from 'vitest';
import { BounceGuardMailer, MailRecipientSuppressedError } from './bounce-guard.js';
import { bounceMessageId, deriveBounceKey, readBounceMessageId } from './bounce-id.js';
import { parseDeliveryReport } from './bounce-report.js';
import { emailAddressHash } from './list-unsubscribe.js';
import type { MailMessage } from './mailer.js';

const KEY = deriveBounceKey('s'.repeat(48));
const ORG = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';

/** An RFC 3464 report quoting `messageId`, with one recipient's Action and Status. */
function dsn(messageId: string, action: string, status: string, finalRecipient = 'x@y.z') {
  return Buffer.from(
    [
      'From: MAILER-DAEMON@mx.example',
      'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain',
      '',
      'Delivery failed. <b>html is never rendered</b>',
      '--b1',
      'Content-Type: message/delivery-status',
      '',
      'Reporting-MTA: dns; mx.example',
      '',
      `Final-Recipient: rfc822; ${finalRecipient}`,
      `Action: ${action}`,
      `Status: ${status}`,
      '',
      '--b1',
      'Content-Type: text/rfc822-headers',
      '',
      `Message-ID: ${messageId}`,
      'Subject: You are invited',
      '--b1--',
      '',
    ].join('\r\n'),
  );
}

describe('56-26 signed bounce Message-ID', () => {
  const id = bounceMessageId(KEY, {
    organizationId: ORG,
    to: ' Ann@Example.com ',
    domain: 'tm.io',
  });

  it('round-trips the company, the address hash and a per-message reference', () => {
    expect(id).toMatch(/^<tmb1\..+@tm\.io>$/u);
    const read = readBounceMessageId(KEY, id as string);
    expect(read).toEqual({
      organizationId: ORG,
      addressHash: emailAddressHash('ann@example.com'),
      reference: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/u) as string,
    });
  });

  it('refuses a changed company, a changed address hash, another key and junk', () => {
    const other = '0192f3a4-5b6c-7d8e-9f01-23456789abce';
    expect(readBounceMessageId(KEY, (id as string).replace(ORG, other))).toBeNull();
    const parts = (id as string).split('.');
    parts[2] = emailAddressHash('victim@example.com');
    expect(readBounceMessageId(KEY, parts.join('.'))).toBeNull();
    expect(readBounceMessageId(deriveBounceKey('t'.repeat(48)), id as string)).toBeNull();
    expect(readBounceMessageId(KEY, `<${'a.'.repeat(5000)}@x>`)).toBeNull();
  });
});

describe('56-26 RFC 3464 report reader', () => {
  it('reads a 5.1.1 failure as hard and a delay or a full mailbox as soft', () => {
    expect(parseDeliveryReport(dsn('<m1@x>', 'failed', '5.1.1'))).toEqual({
      kind: 'hard',
      status: '5.1.1',
      messageIds: ['<m1@x>'],
    });
    expect(parseDeliveryReport(dsn('<m1@x>', 'delayed', '4.4.7'))?.kind).toBe('soft');
    expect(parseDeliveryReport(dsn('<m1@x>', 'failed', '5.2.2'))?.kind).toBe('soft');
  });

  it('is not a bounce: delivered, a plain message, an oversized body, nesting past the bound', () => {
    expect(parseDeliveryReport(dsn('<m1@x>', 'delivered', '2.0.0'))).toBeNull();
    expect(parseDeliveryReport(Buffer.from('Subject: hi\r\n\r\nStatus: 5.1.1'))).toBeNull();
    expect(parseDeliveryReport(Buffer.alloc(1024 * 1024 + 1, 0x41))).toBeNull();
    let nested = dsn('<m1@x>', 'failed', '5.1.1').toString('latin1');
    for (let i = 0; i < 5; i += 1) {
      nested = `Content-Type: multipart/mixed; boundary="n${String(i)}"\r\n\r\n--n${String(i)}\r\n${nested}\r\n--n${String(i)}--\r\n`;
    }
    expect(parseDeliveryReport(Buffer.from(nested, 'latin1'))).toBeNull();
  });
});

describe('56-26 BounceGuardMailer', () => {
  const message: MailMessage = {
    to: 'ann@example.com',
    subject: 's',
    text: 't',
    templateKey: 'invitation',
    organizationId: ORG,
  };

  it('refuses a suppressed recipient, asking with the message company only', async () => {
    const inner = { send: vi.fn(() => Promise.resolve('sent' as const)) };
    const isBounceSuppressed = vi.fn(() => Promise.resolve(true));
    const guard = new BounceGuardMailer(inner, { isBounceSuppressed });
    await expect(guard.send(message)).rejects.toBeInstanceOf(MailRecipientSuppressedError);
    expect(isBounceSuppressed).toHaveBeenCalledWith(ORG, emailAddressHash('ann@example.com'));
    expect(inner.send).not.toHaveBeenCalled();
  });

  it('never holds auth mail or mail that names no company', async () => {
    const inner = { send: vi.fn(() => Promise.resolve('sent' as const)) };
    const isBounceSuppressed = vi.fn(() => Promise.resolve(true));
    const guard = new BounceGuardMailer(inner, { isBounceSuppressed });
    await guard.send({ ...message, templateKey: 'password_reset' });
    const { organizationId: _drop, ...platform } = message;
    await guard.send(platform);
    expect(inner.send).toHaveBeenCalledTimes(2);
    expect(isBounceSuppressed).not.toHaveBeenCalled();
  });
});
