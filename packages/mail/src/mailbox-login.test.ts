import { describe, expect, it } from 'vitest';
import { MailLoginCheck, resolveMailboxLogin } from './mailbox-login.js';
import type { CheckedMailbox } from './mailbox-login.js';
import type { SmtpMailerOptions } from './smtp-mailer.js';

/**
 * PERSONMAIL / MAILSTATUS (ADR-0013) — one shared mailbox password (`SMTP_PASSWORD`), each role
 * mailbox signs in as its own username; a refused login is reported by state, never by value.
 */

const SHARED = 'Shared-Mailbox-pa55!';
const OWN = 'security-own-pa55';

describe('PERSONMAIL — the one login rule (hello, support, security)', () => {
  it('a missing *_PASS uses SMTP_PASSWORD with the mailbox own username, not noreply', () => {
    expect(resolveMailboxLogin({ address: 'hello@tmanageapp.com' }, SHARED)).toEqual({
      username: 'hello@tmanageapp.com',
      password: SHARED,
    });
    expect(
      resolveMailboxLogin({ username: 'security@tmanageapp.com', password: undefined }, SHARED),
    ).toEqual({ username: 'security@tmanageapp.com', password: SHARED });
  });

  it('its own user and password override the shared ones', () => {
    expect(
      resolveMailboxLogin(
        { username: 'sec@tmanageapp.com', password: OWN, address: 'security@tmanageapp.com' },
        SHARED,
      ),
    ).toEqual({ username: 'sec@tmanageapp.com', password: OWN });
  });

  it('no username, a non-address username, or no password at all = no login', () => {
    expect(resolveMailboxLogin({}, SHARED)).toBeNull();
    expect(resolveMailboxLogin({ username: 'security' }, SHARED)).toBeNull();
    expect(resolveMailboxLogin({ address: 'hello@tmanageapp.com' }, undefined)).toBeNull();
  });
});

const target = (username: string, password: string | undefined): SmtpMailerOptions => ({
  host: 'smtp.example',
  port: 465,
  secure: true,
  username,
  password,
  fromAddress: username,
  fromName: 'TManage',
});

describe('MAILSTATUS — the mailbox login check', () => {
  function check(fail: Partial<Record<string, Error & { responseCode?: number }>>) {
    const calls: string[] = [];
    const lines: string[] = [];
    let clock = 0;
    const targets: Record<CheckedMailbox, SmtpMailerOptions | null> = {
      noreply: target('noreply@tmanageapp.com', SHARED),
      hello: target('hello@tmanageapp.com', SHARED),
      support: target('support@tmanageapp.com', SHARED),
      security: null,
    };
    const probe = new MailLoginCheck({
      targets,
      verify: (smtp) => {
        calls.push(smtp.username ?? '-');
        const failure = fail[smtp.username ?? ''];
        return failure === undefined ? Promise.resolve() : Promise.reject(failure);
      },
      now: () => clock,
      log: (line) => lines.push(line),
    });
    return { probe, calls, lines, tick: (ms: number) => (clock += ms) };
  }

  it('reports a refused login (535) by mailbox and state, never the password or server text', async () => {
    const refused = Object.assign(new Error(`535 Authentication failed for ${SHARED}`), {
      code: 'EAUTH',
      responseCode: 535,
    });
    const timeout = Object.assign(new Error('Greeting never received'), { code: 'ETIMEDOUT' });
    const c = check({ 'noreply@tmanageapp.com': refused, 'hello@tmanageapp.com': timeout });
    const status = await c.probe.status();
    expect(status.state).toBe('login_refused');
    expect(status.mailboxes).toEqual([
      { mailbox: 'noreply', address: 'noreply@tmanageapp.com', state: 'login_refused' },
      { mailbox: 'hello', address: 'hello@tmanageapp.com', state: 'unreachable' },
      { mailbox: 'support', address: 'support@tmanageapp.com', state: 'ok' },
      { mailbox: 'security', address: null, state: 'not_configured' },
    ]);
    const out = `${JSON.stringify(status)}\n${c.lines.join('\n')}`;
    expect(out).not.toContain(SHARED);
    expect(out).not.toContain('Authentication failed');
    expect(c.lines).toEqual([
      '[mailer] mailbox login check: noreply login_refused, hello unreachable',
    ]);
  });

  it('is cached and shared by concurrent reads, so a poller cannot repeat the logins', async () => {
    const c = check({});
    await Promise.all([c.probe.status(), c.probe.status(), c.probe.status()]);
    expect(c.calls).toHaveLength(3);
    c.tick(60_000);
    await c.probe.status();
    expect(c.calls).toHaveLength(3);
    c.tick(15 * 60_000);
    expect((await c.probe.status()).state).toBe('ok');
    expect(c.calls).toHaveLength(6);
  });
});
