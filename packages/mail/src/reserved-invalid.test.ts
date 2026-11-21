import { describe, expect, it } from 'vitest';
import { SmtpMailer, isReservedInvalidAddress } from './smtp-mailer.js';

/**
 * 60-04 (plan 60 v2): mail to the reserved `.invalid` top-level domain (RFC 6761 §6.4), where AI
 * employees' credential-less users live, is never submitted. The driver answers `none` without
 * opening a connection (port 9 on loopback: nothing listens, so a connection attempt would throw).
 */

describe('isReservedInvalidAddress', () => {
  it('matches .invalid in any case, with a trailing dot', () => {
    for (const address of [
      'ai-0190a000-0000-7000-8000-000000000001@ai-employee.invalid',
      'x@AI-EMPLOYEE.INVALID',
      'x@invalid',
      'x@a.invalid.',
    ]) {
      expect(isReservedInvalidAddress(address), address).toBe(true);
    }
  });

  it('leaves real and look-alike domains alone', () => {
    for (const address of [
      'x@example.com',
      'x@invalid.com',
      'x@notinvalid',
      'invalid',
      'x@b.test',
    ]) {
      expect(isReservedInvalidAddress(address), address).toBe(false);
    }
  });
});

describe('SmtpMailer and .invalid', () => {
  it('submits nothing and answers none', async () => {
    const mailer = new SmtpMailer({
      host: '127.0.0.1',
      port: 9,
      secure: false,
      fromAddress: 'no-reply@tmanage.example',
      fromName: 'TManage',
    });
    const receipt = await mailer.submit({
      to: 'ai-0190a000-0000-7000-8000-000000000001@ai-employee.invalid',
      subject: 'x',
      text: 'x',
    } as Parameters<SmtpMailer['submit']>[0]);
    expect(receipt).toEqual({ delivery: 'none', messageId: null });
    mailer.close();
  });
});
