import { describe, expect, it } from 'vitest';
import type { MailDelivery, Mailer, MailMessage } from './mailer.js';
import { decodeQueuedMessage, encodeQueuedMessage } from './queue-mailer.js';
import {
  SENDER_CATEGORIES,
  categoryForTemplate,
  cleanDisplayPart,
  validateSenderAddress,
  validateSenderName,
} from './sender.js';
import { SIGNATURE_TOKENS, SenderResolvingMailer } from './sender-resolver.js';
import type { MailPerson, SenderDirectory, SenderResolverOptions } from './sender-resolver.js';

const ADDRESSES = {
  hello: 'hello@tmanageapp.com',
  support: 'support@tmanageapp.com',
  noreply: 'noreply@tmanageapp.com',
};
const MARIAM: MailPerson = {
  name: 'Mariam',
  role: 'customer success',
  address: 'mariam@tmanageapp.com',
};

class Capture implements Mailer {
  readonly sent: MailMessage[] = [];
  send(message: MailMessage): Promise<MailDelivery> {
    this.sent.push(message);
    return Promise.resolve('sent');
  }
  get last(): MailMessage {
    const message = this.sent.at(-1);
    if (message === undefined) throw new Error('nothing sent');
    return message;
  }
}

function directoryOf(person: MailPerson | null, calls: { count: number } = { count: 0 }) {
  const directory: SenderDirectory = {
    personFor: () => {
      calls.count += 1;
      return Promise.resolve(person);
    },
  };
  return directory;
}

function resolver(options: Partial<SenderResolverOptions> = {}) {
  const capture = new Capture();
  const mailer = new SenderResolvingMailer(capture, {
    identityAddress: 'noreply@tmanageapp.com',
    sendAs: true,
    addresses: ADDRESSES,
    directory: directoryOf(MARIAM),
    log: () => undefined,
    ...options,
  });
  return { capture, mailer };
}

const TIP = { personRef: { kind: 'assigned', userId: 'user-1', topic: 'features' } } as const;
const base = { to: 'owner@client.example', subject: 's', text: 't', organizationId: 'org-1' };

describe('EMAILBUILD — sender categories', () => {
  const KEYS = [
    'sign_in_code',
    'magic_link',
    'password_reset',
    'mfa_code',
    'mfa_changed',
    'new_device',
    'email_change',
    'password_changed',
    'credential_change',
    'erasure_confirmation',
    'privacy_notice',
    'sign_in_policy_changed',
    'portal_sign_in',
    'portal_sign_in_cancelled',
    'public_link_code',
    'challenge_code',
    'esign_code',
    'collaboration_notice',
    'digest',
    'nudge',
    'while_you_were_away',
    'welcome',
    'support_reply',
    'security_report_ack',
    'platform_owner_notice',
    'usage_threshold',
    'storage_root',
    'tip',
    'invitation',
    'client_request',
    'client_invoice',
    'esign_request',
    'external_approval',
    'inbound_ask_resend',
    'ops_alert',
    'security_alert_digest',
    'monthly_gtm_report',
  ];

  it('only `tip` reaches a person; unknown or absent keys are security', () => {
    for (const key of KEYS) {
      expect(categoryForTemplate(key) === 'person', key).toBe(key === 'tip');
    }
    for (const key of [undefined, null, '', 'TIP', 'tip ', '__proto__', 'made_up']) {
      expect(categoryForTemplate(key)).toBe('security');
    }
    expect(categoryForTemplate('welcome')).toBe('welcome');
    expect(categoryForTemplate('digest')).toBe('notice');
    expect(categoryForTemplate('storage_root')).toBe('support');
  });

  it('client mail never yields a TManage person, whatever the key', () => {
    for (const key of KEYS) {
      expect(categoryForTemplate(key, 'client')).not.toBe('person');
      expect(['workspace', 'security']).toContain(categoryForTemplate(key, 'client'));
    }
    for (const key of ['invitation', 'client_request', 'esign_request', 'portal_anything']) {
      expect(['workspace', 'security']).toContain(categoryForTemplate(key));
    }
  });

  it('rejects line breaks, controls, quotes and brackets in names and addresses', () => {
    for (const name of [
      'A\r\nBcc: x',
      'A"B',
      'A<B>',
      'A,B',
      'A;B',
      'A:B',
      'A\\B',
      ' A',
      '',
      'x'.repeat(81),
      'A\u202eB',
    ]) {
      expect(validateSenderName(name), name).toBe(false);
    }
    expect(validateSenderName('مريم')).toBe(true);
    for (const address of [
      'a@tmanageapp.com\r\n',
      'A@tmanageapp.com',
      'a b@tmanageapp.com',
      '"a"@tmanageapp.com',
      'a@x',
      `${'a'.repeat(190)}@tmanageapp.com`,
    ]) {
      expect(validateSenderAddress(address), address).toBe(false);
    }
    expect(validateSenderAddress('mariam@tmanageapp.com', 'tmanageapp.com')).toBe(true);
    expect(validateSenderAddress('mariam@evil.example', 'tmanageapp.com')).toBe(false);
    expect(cleanDisplayPart('Atlas "Studio" <x>\r\nBcc:')).toBe('Atlas Studio x Bcc');
  });
});

describe('EMAILBUILD — SenderResolvingMailer', () => {
  it('gives each category its sender and reply route (send-as on)', async () => {
    const { capture, mailer } = resolver();
    const cases: [string, string, string | undefined][] = [
      ['password_reset', '"TManage Security" noreply@tmanageapp.com', undefined],
      ['digest', '"TManage" noreply@tmanageapp.com', undefined],
      ['welcome', '"TManage" hello@tmanageapp.com', 'hello@tmanageapp.com'],
      ['support_reply', '"TManage Support" support@tmanageapp.com', 'support@tmanageapp.com'],
      ['tip', '"Mariam from TManage" mariam@tmanageapp.com', 'mariam@tmanageapp.com'],
      ['client_request', '"TManage" noreply@tmanageapp.com', undefined],
      ['ops_alert', '"TManage" noreply@tmanageapp.com', undefined],
      // LANE-Q: no sales@ configured here, so the walkthrough notice leaves as noreply, named.
      ['walkthrough_request', '"TManage Sales" noreply@tmanageapp.com', undefined],
    ];
    expect(cases).toHaveLength(SENDER_CATEGORIES.length);
    for (const [templateKey, from, replyTo] of cases) {
      await mailer.send({ ...base, ...TIP, templateKey, replyTo: 'producer@x.example' });
      const sent = capture.last;
      expect(`"${sent.from?.name ?? ''}" ${sent.from?.address ?? ''}`, templateKey).toBe(from);
      expect(sent.replyTo, templateKey).toBe(
        templateKey === 'client_request' || templateKey === 'walkthrough_request'
          ? 'producer@x.example'
          : replyTo,
      );
    }
  });

  it('send-as off keeps the SMTP identity address and shows the name only', async () => {
    const { capture, mailer } = resolver({ sendAs: false });
    await mailer.send({ ...base, templateKey: 'welcome' });
    expect(capture.last.from).toEqual({ name: 'TManage' });
    expect(capture.last.replyTo).toBe('hello@tmanageapp.com');
  });

  it('PERSONMAIL: a tip always names the person own mailbox, whatever send-as says', async () => {
    const { capture, mailer } = resolver({ sendAs: false });
    await mailer.send({ ...base, templateKey: 'tip', ...TIP });
    expect(capture.last.from).toEqual({
      name: 'Mariam from TManage',
      address: 'mariam@tmanageapp.com',
    });
    expect(capture.last.identity).toBe('person');
    expect(capture.last.replyTo).toBe('mariam@tmanageapp.com');
  });

  it('overwrites a sender the message arrived with', async () => {
    const { capture, mailer } = resolver();
    await mailer.send({
      ...base,
      templateKey: 'password_reset',
      from: { name: 'Bank', address: 'ceo@bank.example' },
    });
    expect(capture.last.from).toEqual({
      name: 'TManage Security',
      address: 'noreply@tmanageapp.com',
    });
  });

  it('falls back to "TManage" hello@ for an empty registry or an unusable person', async () => {
    for (const person of [
      null,
      { ...MARIAM, address: 'mariam@evil.example' },
      { ...MARIAM, name: 'M\r\nBcc: x' },
    ]) {
      const { capture, mailer } = resolver({ directory: directoryOf(person) });
      await mailer.send({
        ...base,
        templateKey: 'tip',
        ...TIP,
        text: `${SIGNATURE_TOKENS.by}\n${SIGNATURE_TOKENS.note}`,
      });
      expect(capture.last.from).toEqual({ name: 'TManage', address: 'hello@tmanageapp.com' });
      expect(capture.last.text).toBe('The TManage team\nReply to this e-mail and we will read it.');
    }
  });

  it('signs a tip with the person and the honesty line, HTML-escaped, in Arabic too', async () => {
    const { capture, mailer } = resolver({ directory: directoryOf({ ...MARIAM, role: 'R&D' }) });
    await mailer.send({
      ...base,
      templateKey: 'tip',
      ...TIP,
      text: SIGNATURE_TOKENS.note,
      html: `<p>${SIGNATURE_TOKENS.by}</p>`,
    });
    expect(capture.last.text).toContain("Sent automatically in Mariam's name.");
    expect(capture.last.html).toBe('<p>Mariam, R&amp;D at TManage</p>');
    await mailer.send({
      ...base,
      templateKey: 'tip',
      ...TIP,
      language: 'ar',
      text: SIGNATURE_TOKENS.by,
    });
    expect(capture.last.from?.name).toBe('Mariam من TManage');
  });

  it('caches the person for 60 s per user, topic and language', async () => {
    const calls = { count: 0 };
    let clock = 0;
    const { mailer } = resolver({ directory: directoryOf(MARIAM, calls), now: () => clock });
    await mailer.send({ ...base, templateKey: 'tip', ...TIP });
    await mailer.send({ ...base, templateKey: 'tip', ...TIP });
    await mailer.send({ ...base, templateKey: 'tip', ...TIP, language: 'ar' });
    expect(calls.count).toBe(2);
    clock = 61_000;
    await mailer.send({ ...base, templateKey: 'tip', ...TIP });
    expect(calls.count).toBe(3);
    await mailer.send({
      ...base,
      templateKey: 'tip',
      personRef: { kind: 'assigned', userId: 'user-1', topic: 'security' },
    });
    expect(calls.count).toBe(4);
  });

  it('names the agency for client mail, cleaned, and never a person', async () => {
    const { capture, mailer } = resolver();
    await mailer.send({
      ...base,
      templateKey: 'collaboration_notice',
      audience: 'client',
      actingFor: { workspaceName: 'Atlas "Studio"\r\n', actorName: 'Omar <o>', replyRoute: 'none' },
      replyTo: 'omar@atlas.example',
    });
    expect(capture.last.from?.name).toBe('Omar o at Atlas Studio via TManage');
    expect(capture.last.replyTo).toBeUndefined();
  });

  it('signs no person without a person reference, and none on non-tip mail', async () => {
    const { capture, mailer } = resolver();
    await mailer.send({ ...base, templateKey: 'tip' });
    expect(capture.last.from?.address).toBe('hello@tmanageapp.com');
    await mailer.send({ ...base, ...TIP, templateKey: 'collaboration_notice' });
    expect(capture.last.from?.address).toBe('noreply@tmanageapp.com');
    await mailer.send({ ...base, ...TIP, templateKey: 'tip', audience: 'client' });
    expect(capture.last.from?.address).toBe('noreply@tmanageapp.com');
  });

  it('stamps Auto-Submitted on automated mail, not on a staff notice', async () => {
    const { capture, mailer } = resolver();
    await mailer.send({ ...base, templateKey: 'digest' });
    expect(capture.last.headers?.['Auto-Submitted']).toBe('auto-generated');
    await mailer.send({ ...base, templateKey: 'platform_owner_notice' });
    expect(capture.last.headers?.['Auto-Submitted']).toBeUndefined();
  });
});

describe('EMAILBUILD — queue round trip', () => {
  it('keeps a valid sender and drops a forged one', () => {
    const good = decodeQueuedMessage(
      encodeQueuedMessage({
        ...base,
        from: { name: 'TManage Support', address: 'support@tmanageapp.com' },
      }),
      'support_reply',
    );
    expect(good?.from).toEqual({ name: 'TManage Support', address: 'support@tmanageapp.com' });
    const forged = JSON.stringify({
      ...base,
      from: { name: 'X\r\nBcc: y', address: 'a@b.example' },
    });
    expect(decodeQueuedMessage(forged, 'tip')?.from).toBeUndefined();
    const badAddress = JSON.stringify({
      ...base,
      from: { name: 'X', address: 'a@b.example>\r\n' },
    });
    expect(decodeQueuedMessage(badAddress, 'tip')?.from).toBeUndefined();
  });
});
