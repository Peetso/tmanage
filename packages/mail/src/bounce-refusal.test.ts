import { describe, expect, it } from 'vitest';
import {
  SmtpRefusalMailer,
  nextRefusalState,
  refusalReference,
  smtpRecipientRefusal,
} from './bounce-refusal.js';
import type { RefusalInput } from './bounce-refusal.js';
import { emailAddressHash } from './list-unsubscribe.js';
import type { Mailer, MailMessage } from './mailer.js';

const ORG = '0b3f2a6e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const AT = new Date('2026-11-18T10:00:00.000Z');

/** The shape nodemailer rejects with when the only recipient is refused. */
const rcpt = (responseCode: number, response: string) =>
  Object.assign(new Error("Can't send mail - all recipients were rejected"), {
    code: 'EENVELOPE',
    command: 'RCPT TO',
    responseCode,
    response,
  });

const message = (to = 'sara@example.test'): MailMessage => ({
  to,
  subject: 'Not tried yet: invoices',
  text: 'Hi Sara',
  templateKey: 'tip',
  organizationId: ORG,
});

describe('MAILREST — SMTP-time recipient refusals', () => {
  it('reads a 5xx RCPT refusal as hard (5.1.x, 5.2.1) or soft, and nothing else', () => {
    expect(smtpRecipientRefusal(rcpt(550, '550 5.1.1 <x@y>: Recipient address rejected'))).toEqual({
      kind: 'hard',
      status: '5.1.1',
    });
    expect(smtpRecipientRefusal(rcpt(550, '550-5.2.1 mailbox disabled'))).toEqual({
      kind: 'hard',
      status: '5.2.1',
    });
    expect(smtpRecipientRefusal(rcpt(552, '552 5.2.2 mailbox full'))).toEqual({
      kind: 'soft',
      status: '5.2.2',
    });
    expect(smtpRecipientRefusal(rcpt(550, '550 no such user'))).toEqual({
      kind: 'soft',
      status: '5.0.0',
    });
    // Not about the recipient: try later, our own sender, our login, the content.
    expect(smtpRecipientRefusal(rcpt(450, '450 4.2.0 greylisted'))).toBeNull();
    expect(
      smtpRecipientRefusal(
        Object.assign(new Error('x'), { command: 'MAIL FROM', responseCode: 553 }),
      ),
    ).toBeNull();
    expect(
      smtpRecipientRefusal(Object.assign(new Error('x'), { code: 'EAUTH', responseCode: 535 })),
    ).toBeNull();
    expect(
      smtpRecipientRefusal(Object.assign(new Error('x'), { command: 'DATA', responseCode: 554 })),
    ).toBeNull();
    expect(smtpRecipientRefusal(new Error('socket closed'))).toBeNull();
  });

  it('suppresses on the first hard refusal and on the third soft one; one message counts once', () => {
    const hard = nextRefusalState(null, { kind: 'hard', status: '5.1.1' }, 's.a', AT);
    expect(hard?.suppressedAt).toEqual(AT);
    let soft = nextRefusalState(null, { kind: 'soft', status: '5.0.0' }, 's.1', AT);
    expect(soft?.suppressedAt).toBeNull();
    // The same message again (a drainer or person-mail retry) is not counted.
    expect(nextRefusalState(soft, { kind: 'soft', status: '5.0.0' }, 's.1', AT)).toBeNull();
    soft = nextRefusalState(soft, { kind: 'soft', status: '5.0.0' }, 's.2', AT);
    soft = nextRefusalState(soft, { kind: 'soft', status: '5.0.0' }, 's.3', AT);
    expect(soft).toMatchObject({ softCount: 3, suppressedAt: AT });
  });

  it('records the refusal for the company and rethrows the original error', async () => {
    const recorded: RefusalInput[] = [];
    const refused = rcpt(550, '550 5.1.1 unknown user');
    const inner: Mailer = { send: () => Promise.reject(refused) };
    const mailer = new SmtpRefusalMailer(
      inner,
      { recordRefusal: (input) => (recorded.push(input), Promise.resolve()) },
      () => undefined,
      () => AT,
    );
    await expect(mailer.send(message())).rejects.toBe(refused);
    await expect(mailer.send(message())).rejects.toBe(refused);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toEqual({
      organizationId: ORG,
      addressHash: emailAddressHash('sara@example.test'),
      refusal: { kind: 'hard', status: '5.1.1' },
      reference: refusalReference(message()),
      at: AT,
    });
    // Both sends are one message: the store counts the second as a duplicate.
    expect(recorded[1]?.reference).toBe(recorded[0]?.reference);
    expect(refusalReference(message('other@example.test'))).not.toBe(recorded[0]?.reference);
  });

  it('keeps the send outcome when the recorder fails, and ignores mail with no company', async () => {
    const refused = rcpt(550, '550 5.1.1 unknown user');
    const lines: string[] = [];
    let calls = 0;
    const mailer = new SmtpRefusalMailer(
      { send: () => Promise.reject(refused) },
      { recordRefusal: () => ((calls += 1), Promise.reject(new Error('no grant'))) },
      (line) => lines.push(line),
    );
    await expect(mailer.send(message())).rejects.toBe(refused);
    expect(lines).toEqual(['[mailer] could not record an SMTP recipient refusal']);
    const noCompany: MailMessage = { to: 'sara@example.test', subject: 's', text: 't' };
    await expect(mailer.send(noCompany)).rejects.toBe(refused);
    expect(calls).toBe(1);
    const ok = new SmtpRefusalMailer(
      { send: () => Promise.resolve('sent' as const) },
      { recordRefusal: () => Promise.reject(new Error('never')) },
    );
    await expect(ok.submit(message())).resolves.toEqual({ delivery: 'sent', messageId: null });
  });
});
