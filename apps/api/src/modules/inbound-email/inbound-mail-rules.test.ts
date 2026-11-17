import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_BYTES,
  attachmentObjectKey,
  parseWebhookBody,
  verifyWebhookSignature,
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
const D = 'tmanageapp.com';
const pass = {
  sizeBytes: 1000,
  declaredType: 'application/pdf',
  head: null,
  authResult: 'pass' as const,
};

describe('inbound mail rules (R21-f)', () => {
  it('parses only requests+<slug>-<6> at the exact domain', () => {
    expect(localPartFor('Acme-Studio', 'ab12cd')).toBe('requests+acme-studio-ab12cd');
    expect(parseRecipient(`Acme <Requests+acme-ab12cd@TManageApp.com>`, D)).toBe(
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

describe('inbound webhook rules (R22-c)', () => {
  const secret = 's'.repeat(40);
  const now = new Date('2026-11-02T12:00:00.000Z');
  const ts = String(Math.floor(now.getTime() / 1000));
  const sign = (body: string, at = ts) =>
    `v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`;
  const check = (body: string, signature: string, timestamp = ts) =>
    verifyWebhookSignature({ rawBody: Buffer.from(body), signature, timestamp, secret, now });

  it('accepts a correct signature within 300 s and refuses stale or foreign ones', () => {
    expect(check('{"a":1}', sign('{"a":1}'))).toBe('valid');
    const stale = String(Number(ts) - 301);
    expect(check('{"a":1}', sign('{"a":1}', stale), stale)).toBe('invalid');
    expect(check('{"a":2}', sign('{"a":1}'))).toBe('invalid');
    expect(check('{"a":1}', 'v1=zz')).toBe('invalid');
  });

  it('parses a bounded body and decodes the kept attachments', () => {
    const parsed = parseWebhookBody(
      {
        to: 'requests+a-ab12cd@x.com',
        from: 'b@c.com',
        subject: 'Hi',
        headers: JSON.parse(
          '{"__proto__":["p"],"Authentication-Results":["dmarc=pass"]}',
        ) as unknown,
        attachments: [
          { name: 'a.pdf', contentType: 'application/pdf', size: 99, contentBase64: 'JVBERg==' },
        ],
      },
      'corr',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.message.attachments[0]).toMatchObject({ name: 'a.pdf', sizeBytes: 4 });
    expect(Object.getPrototypeOf(parsed.message.headers)).toBeNull();
    expect(parsed.message.attachments[0]?.bytes?.toString()).toBe('%PDF');
    const bad = parseWebhookBody({ to: '', from: 'b@c.com', subject: 'x'.repeat(501) }, 'c');
    expect(bad.ok ? [] : bad.details.map((d) => d.field)).toEqual(['to', 'subject']);
  });

  it('derives the quarantine key under the tenant prefix', () => {
    const id = (n: string) => `0192f000-0000-7000-8000-0000000000${n}`;
    expect(attachmentObjectKey(id('01'), id('02'), id('03'))).toBe(
      `tenant/${id('01')}/project/${id('02')}/upload/${id('03')}/object`,
    );
  });

  it('member branch: work item with a default project; the client branch wins when both', () => {
    const base = {
      authResult: 'pass' as const,
      senderClient: null,
      senderMember: { userId: 'u', membershipId: 'm' },
      defaultProjectId: 'p',
      projectShared: false,
    };
    expect(decideOutcome(base)).toEqual({ outcome: 'work_item' });
    expect(decideOutcome({ ...base, memberOutcome: 'hold' })).toMatchObject({ outcome: 'held' });
    expect(decideOutcome({ ...base, defaultProjectId: null })).toMatchObject({
      reason: 'no_default_project',
    });
    expect(
      decideOutcome({
        ...base,
        senderClient: { clientOrganizationId: 'co', userId: 'cu' },
        projectShared: true,
      }),
    ).toEqual({ outcome: 'client_request' });
  });
});
