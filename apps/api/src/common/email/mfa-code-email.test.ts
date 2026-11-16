import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Mailer, MailMessage } from '@tmanage/mail';
import { MfaCodeMailer, composeMfaCodeEmail } from './mfa-code-email.js';

/**
 * MFAOPTIONS. The code e-mail says what the code is for, carries no link that could sign anyone
 * in, exists in every catalog language, and its code never reaches a log line.
 */

const CATALOG_DIR = fileURLToPath(new URL('../i18n/email/', import.meta.url));
const LOCALES = readdirSync(CATALOG_DIR)
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.replace(/\.json$/u, ''));
const KEYS = [
  'mfaCode.subject',
  'mfaCode.eyebrow',
  'mfaCode.heading',
  'mfaCode.introSignIn',
  'mfaCode.introEnrol',
  'mfaCode.note',
  'mfaCode.footer',
];

const FACTS = {
  to: 'peter@example.test',
  displayName: 'Peter',
  code: '042137',
  purpose: 'sign_in' as const,
  ttlMinutes: 10,
};

describe('composeMfaCodeEmail', () => {
  it('carries the code and no link of any kind', () => {
    for (const purpose of ['sign_in', 'enrol'] as const) {
      const message = composeMfaCodeEmail({ ...FACTS, purpose });
      expect(message.text).toContain('042137');
      expect(message.html).toContain('042137');
      expect(message.html).not.toMatch(/<a\b|href=/iu);
      expect(`${message.text}\n${message.html}`).not.toMatch(/https?:\/\//iu);
    }
  });

  it('says what the code is for, and for how long it works', () => {
    const signIn = composeMfaCodeEmail(FACTS);
    const enrol = composeMfaCodeEmail({ ...FACTS, purpose: 'enrol' });
    expect(signIn.text).toContain('finish signing in');
    expect(enrol.text).toContain('turn on e-mail codes');
    expect(signIn.text).toContain('10 minutes');
  });

  it('is written in every catalog language, Arabic right-to-left', () => {
    expect(LOCALES.length).toBeGreaterThanOrEqual(7);
    for (const locale of LOCALES) {
      const catalog = JSON.parse(readFileSync(`${CATALOG_DIR}${locale}.json`, 'utf8')) as Record<
        string,
        string
      >;
      for (const key of KEYS) expect(catalog[key], `${locale} ${key}`).toBeTruthy();
    }
    expect(composeMfaCodeEmail({ ...FACTS, locale: 'ar' }).html).toContain('dir="rtl"');
  });

  it('flattens a display name, so a newline cannot reach a header-like line', () => {
    const message = composeMfaCodeEmail({ ...FACTS, displayName: 'Peter\nBcc: x@y.test' });
    expect(message.text.split('\n')[0]).toContain('Peter Bcc: x@y.test');
  });
});

describe('MfaCodeMailer', () => {
  it('is disabled with no transport, and sends nothing', async () => {
    const mailer = new MfaCodeMailer(null);
    expect(mailer.enabled).toBe(false);
    expect(await mailer.deliver(FACTS)).toBe('none');
  });

  it('logs a failed send without the code or the message', async () => {
    const sent: MailMessage[] = [];
    const transport: Mailer = {
      send: (message) => {
        sent.push(message);
        return Promise.reject(new Error('relay refused'));
      },
    } as Mailer;
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await new MfaCodeMailer(transport).deliver(FACTS)).toBe('failed');
      expect(sent).toHaveLength(1);
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).not.toContain('042137');
      expect(logged).not.toContain('peter@example.test');
    } finally {
      log.mockRestore();
    }
  });
});
