import { describe, expect, it } from 'vitest';
import { PersonMailboxUnavailableError, createIdentityMailers } from './identity-mailer.js';
import type { IdentityLogin } from './identity-mailer.js';
import { deriveUnsubscribeKey } from './list-unsubscribe.js';
import type { MailDelivery, Mailer, MailMessage } from './mailer.js';
import { decodeQueuedMessage, encodeQueuedMessage } from './queue-mailer.js';
import { MailCeilingReachedError } from './send-ceiling.js';
import { SenderResolvingMailer } from './sender-resolver.js';
import { TEMPLATE_KEYS } from './sender.js';
import type { SmtpMailerOptions } from './smtp-mailer.js';

/**
 * PERSONMAIL (correction 4, ADR-0013; owner decision 2026-11-20) — every mailbox signs in as ITS
 * OWN address with the one shared mailbox password (`SMTP_PASSWORD`); `SMTP_HELLO_PASS` /
 * `SMTP_SUPPORT_PASS` only override it. A tip leaves ONLY from the signing person's own mailbox
 * over SMTP (so every header survives); it is never sent from support@ in the person's name. Fake drivers record which login each send used; the SMTP wire
 * itself is proven in smtp-mailer.test.ts.
 */

const SHARED_SECRET = 'Shared-Mailbox-pa55!';
const SUPPORT_OVERRIDE = 'support-own-pa55';
const base: SmtpMailerOptions = {
  host: 'smtp.example',
  port: 465,
  secure: true,
  username: 'noreply@tmanageapp.com',
  password: SHARED_SECRET,
  fromAddress: 'noreply@tmanageapp.com',
  fromName: 'TManage',
};
const UNSUBSCRIBE = {
  url: 'https://api.tmanageapp.com/v1/public/email/unsubscribe',
  key: deriveUnsubscribeKey('suite-secret'),
};
const HELLO: IdentityLogin = { address: 'hello@tmanageapp.com' };
const SUPPORT: IdentityLogin = { address: 'support@tmanageapp.com' };

interface Sent {
  readonly login: string | undefined;
  readonly password: string | undefined;
  readonly message: MailMessage;
}

type Failure = Error & { code?: string; responseCode?: number };

function harness(
  options: {
    fail?: (login: string | undefined) => Failure | null;
    perDay?: number;
    password?: string | undefined;
    hello?: IdentityLogin;
    support?: IdentityLogin;
  } = {},
) {
  const sent: Sent[] = [];
  const lines: string[] = [];
  const built: string[] = [];
  const closed: string[] = [];
  const build = (smtp: SmtpMailerOptions): Mailer & { close: () => void } => {
    built.push(`${smtp.username ?? '-'}:${smtp.fromAddress}`);
    return {
      send(message: MailMessage): Promise<MailDelivery> {
        const failure = options.fail?.(smtp.username) ?? null;
        if (failure !== null) return Promise.reject(failure);
        sent.push({ login: smtp.username, password: smtp.password, message });
        return Promise.resolve('sent');
      },
      close: () => closed.push(smtp.username ?? '-'),
    };
  };
  const router = createIdentityMailers({
    base: { ...base, password: 'password' in options ? options.password : SHARED_SECRET },
    build,
    hello: options.hello ?? HELLO,
    support: options.support ?? SUPPORT,
    ceiling: { perHour: 100, perDay: options.perDay ?? 100, bulkShare: 0.8 },
    log: (line) => lines.push(line),
  });
  const resolver = new SenderResolvingMailer(router, {
    identityAddress: 'noreply@tmanageapp.com',
    sendAs: false,
    addresses: {
      hello: 'hello@tmanageapp.com',
      support: 'support@tmanageapp.com',
      noreply: 'noreply@tmanageapp.com',
    },
    directory: {
      personFor: (_org, ref) =>
        Promise.resolve(
          ref.kind === 'test'
            ? { name: 'Daniel', role: 'product specialist', address: 'daniel@tmanageapp.com' }
            : { name: 'Mariam', role: 'customer success', address: 'mariam@tmanageapp.com' },
        ),
    },
    unsubscribe: UNSUBSCRIBE,
    log: (line) => lines.push(line),
  });
  return { router, resolver, sent, lines, built, closed };
}

const tip: MailMessage = {
  to: 'owner@client.example',
  subject: 'Bring your team in',
  text: 'Hi.\n\n[[tm.sign.by]]\n[[tm.sign.note]]',
  templateKey: 'tip',
  organizationId: 'org-1',
  personRef: { kind: 'assigned', userId: 'u-1', topic: 'onboarding' },
  optional: true,
};
const plain: MailMessage = { to: 'a@client.example', subject: 's', text: 't' };

describe('PERSONMAIL — one shared mailbox password, every mailbox signs in as itself', () => {
  it('a person mail signs in as the person own address with SMTP_PASSWORD, From that address', async () => {
    const h = harness();
    await h.resolver.send(tip);
    const last = h.sent.at(-1);
    expect(last?.login).toBe('mariam@tmanageapp.com');
    expect(last?.password).toBe(SHARED_SECRET);
    expect(last?.message.from).toEqual({
      name: 'Mariam from TManage',
      address: 'mariam@tmanageapp.com',
    });
    expect(last?.message.replyTo).toBe('mariam@tmanageapp.com');
    expect(last?.message.headers?.['List-Unsubscribe']).toMatch(/^<https:\/\/api\./u);
    expect(last?.message.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(last?.message.headers?.['Auto-Submitted']).toBe('auto-generated');
    expect(h.built).toContain('mariam@tmanageapp.com:mariam@tmanageapp.com');
  });

  it('a missing *_PASS uses SMTP_PASSWORD with that mailbox own username, not noreply', async () => {
    const h = harness();
    await h.router.send({ ...plain, identity: 'hello' });
    await h.router.send({ ...plain, identity: 'support' });
    expect(h.sent.map((s) => [s.login, s.password])).toEqual([
      ['hello@tmanageapp.com', SHARED_SECRET],
      ['support@tmanageapp.com', SHARED_SECRET],
    ]);
    expect(h.lines.some((line) => line.includes('no login for'))).toBe(false);
  });

  it('SMTP_SUPPORT_PASS (and SMTP_SUPPORT_USER) still override the shared login', async () => {
    const h = harness({
      support: {
        address: 'support@tmanageapp.com',
        username: 'help-desk@tmanageapp.com',
        password: SUPPORT_OVERRIDE,
      },
    });
    await h.router.send({ ...plain, identity: 'support' });
    expect(h.sent.at(-1)).toMatchObject({
      login: 'help-desk@tmanageapp.com',
      password: SUPPORT_OVERRIDE,
    });
  });

  it('a refused person login is never sent from support: it throws for the queue, one WARN', async () => {
    const refused: Failure = Object.assign(new Error('Invalid login'), {
      code: 'EAUTH',
      responseCode: 535,
    });
    const h = harness({
      fail: (login) => (login === 'mariam@tmanageapp.com' ? refused : null),
    });
    await expect(h.resolver.send(tip)).rejects.toBe(refused);
    await expect(h.resolver.send(tip)).rejects.toBe(refused);
    expect(h.sent).toHaveLength(0);
    // The transport is rebuilt for the next try; the WARN is said once per address.
    expect(h.closed).toContain('mariam@tmanageapp.com');
    expect(h.built.filter((b) => b.startsWith('mariam@'))).toHaveLength(2);
    expect(h.lines.filter((line) => line.includes('refused its login'))).toHaveLength(1);
  });

  it('a temporary error or a full ceiling throws for the queue to retry; nothing leaves elsewhere', async () => {
    const down: Failure = Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' });
    const h = harness({ fail: (login) => (login === 'mariam@tmanageapp.com' ? down : null) });
    await expect(h.resolver.send(tip)).rejects.toBe(down);
    expect(h.sent).toHaveLength(0);
    const full = harness({ perDay: 2 });
    // Optional mail may use 80 % of 2 = 1 per day from one mailbox.
    await full.resolver.send(tip);
    await expect(full.resolver.send(tip)).rejects.toBeInstanceOf(MailCeilingReachedError);
    expect(full.sent.map((s) => s.login)).toEqual(['mariam@tmanageapp.com']);
    // Another person's mailbox keeps its own count.
    await full.resolver.send({ ...tip, personRef: { kind: 'test', personId: 'p-2' } });
    expect(full.sent.at(-1)?.login).toBe('daniel@tmanageapp.com');
  });

  it('without a shared password a person mail fails; it is never sent in the person name', async () => {
    const h = harness({
      password: undefined,
      support: { address: 'support@tmanageapp.com', password: SUPPORT_OVERRIDE },
    });
    await expect(h.resolver.send(tip)).rejects.toBeInstanceOf(PersonMailboxUnavailableError);
    expect(h.sent).toHaveLength(0);
    expect(h.lines.filter((line) => line.includes('no shared mailbox password'))).toHaveLength(1);
  });

  it('never logs the password, on any path', async () => {
    const refused: Failure = Object.assign(new Error('Invalid login'), { code: 'EAUTH' });
    const ok = harness();
    await ok.resolver.send(tip);
    const bad = harness({ fail: (login) => (login?.startsWith('mariam') ? refused : null) });
    await bad.resolver.send(tip).catch(() => undefined);
    const none = harness({ password: undefined, hello: {}, support: {} });
    await none.resolver.send(tip).catch(() => undefined);
    const all = [...ok.lines, ...bad.lines, ...none.lines].join('\n');
    for (const secret of [SHARED_SECRET, SUPPORT_OVERRIDE]) expect(all).not.toContain(secret);
  });

  it('no other template ever signs in as a person mailbox', async () => {
    const h = harness();
    // LANE-Q: `campaign_intro` is the other person template (a teammate's own outreach mail);
    // OUTREACH MANAGER: its one follow-up, `campaign_followup`, leaves from the same mailbox.
    const personal = new Set(['tip', 'campaign_intro', 'campaign_followup']);
    for (const templateKey of TEMPLATE_KEYS.filter((key) => !personal.has(key))) {
      const { optional: _optional, ...required } = tip;
      await h.resolver.send({ ...required, templateKey });
    }
    expect(h.sent.every((s) => !/^(mariam|daniel)@/u.test(s.login ?? ''))).toBe(true);
  });

  it('a queued person row keeps its key, its own address and its optional flag', () => {
    const json = encodeQueuedMessage({
      ...tip,
      identity: 'person',
      from: { name: 'Mariam from TManage', address: 'mariam@tmanageapp.com' },
    });
    const decoded = decodeQueuedMessage(json, 'tip');
    expect(decoded?.identity).toBe('person');
    expect(decoded?.optional).toBe(true);
    expect(decoded?.from?.address).toBe('mariam@tmanageapp.com');
  });
});
