import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_BYTES,
  attachmentState,
  authResultOf,
  bodyOf,
  decideOutcome,
  decodeRfc2047,
  localPartFor,
  messageIdHash,
  parseRecipient,
} from './inbound-mail-rules.js';

/** R21-f — 54-12 / 54-12a pure rules. */
const D = 'tmanage.peetrix.com';
const pass = {
  sizeBytes: 1000,
  declaredType: 'application/pdf',
  head: null,
  authResult: 'pass' as const,
};

describe('inbound mail rules (R21-f)', () => {
  it('parses only requests+<slug>-<6> at the exact domain', () => {
    expect(localPartFor('Acme-Studio', 'ab12cd')).toBe('requests+acme-studio-ab12cd');
    expect(parseRecipient(`Acme <Requests+acme-ab12cd@TManage.Peetrix.com>`, D)).toBe(
      'requests+acme-ab12cd',
    );
    expect(parseRecipient(`requests+acme-ab12cd@evil.com`, D)).toBeNull();
    expect(parseRecipient(`requests@${D}`, D)).toBeNull();
    expect(parseRecipient(`requests+acme-ab12cd@x@${D}`, D)).toBeNull();
  });

  it('decodes an RFC 2047 Arabic subject (B and Q)', () => {
    const arabic = 'طلب تعديل';
    const b64 = Buffer.from(arabic, 'utf8').toString('base64');
    expect(decodeRfc2047(`=?UTF-8?B?${b64}?=`)).toBe(arabic);
    const q = [...Buffer.from(arabic, 'utf8')]
      .map((byte) => `=${byte.toString(16).toUpperCase().padStart(2, '0')}`)
      .join('');
    expect(decodeRfc2047(`Re: =?utf-8?Q?${q}?=`)).toBe(`Re: ${arabic}`);
  });

  it('reads DMARC from Authentication-Results; any fail wins', () => {
    expect(
      authResultOf({ 'Authentication-Results': 'mx; spf=pass; dmarc=pass header.from=a.com' }),
    ).toBe('pass');
    expect(authResultOf({ 'authentication-results': ['x; dmarc=pass', 'y; dmarc=fail'] })).toBe(
      'fail',
    );
    expect(authResultOf({})).toBe('unknown');
  });

  it('hashes the Message-ID, falling back to from+date+subject', () => {
    expect(messageIdHash('<A@b>', { from: 'x', date: null, subject: null })).toBe(
      messageIdHash('a@b', { from: 'y', date: 'd', subject: 's' }),
    );
    expect(messageIdHash(null, { from: 'x', date: 'd', subject: 's' })).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('applies the 54-12a attachment rule; never clean', () => {
    expect(attachmentState({ ...pass, name: 'brief.pdf', authResult: 'fail' })).toBe(
      'waiting_trust',
    );
    expect(attachmentState({ ...pass, name: 'big.pdf', sizeBytes: 12 * 1024 * 1024 })).toBe(
      'too_large',
    );
    expect(MAX_MESSAGE_BYTES).toBe(10 * 1024 * 1024);
    const zip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('word/vbaProject.bin'),
    ]);
    expect(attachmentState({ ...pass, name: 'report.docx', head: zip })).toBe('blocked_type');
    expect(attachmentState({ ...pass, name: 'x.exe' })).toBe('blocked_type');
    expect(attachmentState({ ...pass, name: 'logo.svg' })).toBe('blocked_type');
    expect(attachmentState({ ...pass, name: 'brief.pdf', head: Buffer.from('%PDF-1.7') })).toBe(
      'scanning',
    );
  });

  it('decides client_request only for a passing known client on a shared project', () => {
    const sender = { clientOrganizationId: 'c', userId: 'u' };
    const base = {
      authResult: 'pass' as const,
      senderClient: sender,
      defaultProjectId: 'p',
      projectShared: true,
    };
    expect(decideOutcome(base)).toEqual({ outcome: 'client_request' });
    expect(decideOutcome({ ...base, authResult: 'fail' })).toEqual({
      outcome: 'held',
      reason: 'dmarc_failed',
    });
    expect(decideOutcome({ ...base, senderClient: null })).toEqual({
      outcome: 'held',
      reason: 'unknown_sender',
    });
    expect(decideOutcome({ ...base, projectShared: false })).toEqual({
      outcome: 'held',
      reason: 'project_not_shared',
    });
  });

  it('reduces an HTML body to text with the script gone', () => {
    const body = bodyOf({
      html: '<p>Hi &amp; bye</p><script>alert(1)</script><img src="http://x/t.gif">',
      text: 'plain',
    });
    expect(body).toBe('Hi & bye');
  });
});
