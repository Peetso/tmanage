import { describe, expect, it } from 'vitest';
import {
  MAIL_LAYOUT_MARK,
  designedMail,
  designedPlainMail,
  mailEyebrow,
  renderMailLayout,
  renderTextReport,
} from './layout.js';
import type { MailMessage } from './mailer.js';
import { SenderResolvingMailer } from './sender-resolver.js';
import { LINK_TOKENS, plainMailText, signOff } from './sign-off.js';

/** MAILDESIGN — the one designed layout and the two parts a mail gets from it. */

const RLM = String.fromCodePoint(0x20_0f);

describe('renderMailLayout', () => {
  it('draws the wordmark, the card and every block, escaping what callers pass', () => {
    const html = renderMailLayout({
      arabic: false,
      subject: 'Subject <x>',
      preheader: 'Preview',
      eyebrow: 'Security',
      heading: 'Hi Sara,',
      blocks: [
        { kind: 'text', text: 'Line with <b>tags</b> & "quotes"' },
        { kind: 'rows', rows: [{ label: 'Role', value: 'Admin' }] },
        { kind: 'code', code: '042137' },
        { kind: 'button', label: 'Open', link: 'https://app.test/a?b=1&c=2', fallback: 'Copy:' },
      ],
      note: 'Works for 10 minutes.',
      signature: ['TManage Security', 'Automatic message.'],
      footer: 'You get this because you asked.',
    });
    expect(html).toContain(MAIL_LAYOUT_MARK);
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toContain('<title>Subject &lt;x&gt;</title>');
    expect(html).toContain('Line with &lt;b&gt;tags&lt;/b&gt; &amp; &quot;quotes&quot;');
    expect(html).not.toContain('<b>tags</b>');
    expect(html).toContain('>Security</p>');
    expect(html).toContain('>Admin</span>');
    expect(html).toContain('>042137</p>');
    // The button's href is exactly the URL printed under it.
    const href = 'https://app.test/a?b=1&amp;c=2';
    expect(html.split(`href="${href}"`)).toHaveLength(3);
    expect(html).toContain(`>${href}</a>`);
    expect(html).toContain('Works for 10 minutes.');
    expect(html).toContain('>TManage Security</p>');
    expect(html).toContain('You get this because you asked.');
  });

  it('is right to left in Arabic, with the Arabic family and no RLM marks in the HTML', () => {
    const html = renderMailLayout({
      arabic: true,
      subject: `${RLM}رمزك`,
      preheader: `${RLM}رمزك`,
      heading: `${RLM}مرحبًا سارة،`,
      blocks: [{ kind: 'text', text: `${RLM}سطر` }],
      signature: ['أمان TManage'],
    });
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('<body dir="rtl"');
    expect(html).toContain('Alexandria');
    expect(html).toContain('text-align:right');
    expect(html).toContain('<td dir="rtl"');
    expect(html).not.toContain(RLM);
    // The wordmark stays left to right inside the Arabic card.
    expect(html).toContain(MAIL_LAYOUT_MARK);
  });

  it('leaves out the optional parts it was not given', () => {
    const html = renderMailLayout({
      arabic: false,
      subject: 's',
      preheader: 'p',
      heading: 'h',
      blocks: [],
    });
    expect(html).not.toContain('text-transform:uppercase');
    expect(html).not.toContain('border:1px dashed');
    expect(html).not.toContain('<a ');
  });
});

describe('designedPlainMail', () => {
  it("keeps the text part byte for byte as plainMailText's, and draws the same lines in HTML", () => {
    for (const language of ['en', 'ar'] as const) {
      const signature = signOff('security', language);
      const parts = designedPlainMail(language, {
        subject: 'Subject',
        eyebrow: mailEyebrow('security', language),
        name: 'Sara Ali',
        lines: [
          { code: '123456', text: 'Your code is 123456.' },
          '',
          { label: 'Sign in', link: 'https://app.test/s' },
          'Last line.',
        ],
        signature,
      });
      expect(parts.text).toBe(
        plainMailText(language, {
          name: 'Sara Ali',
          lines: ['Your code is 123456.', '', 'Sign in: https://app.test/s', 'Last line.'],
          signature,
        }),
      );
      expect(parts.html).toContain(MAIL_LAYOUT_MARK);
      expect(parts.html).toContain(`dir="${language === 'ar' ? 'rtl' : 'ltr'}"`);
      expect(parts.html).toContain('>123456</p>');
      expect(parts.html).toContain('href="https://app.test/s"');
      expect(parts.html).toContain(language === 'ar' ? 'مرحبًا Sara،' : 'Hi Sara,');
    }
  });
});

describe('designedMail', () => {
  it('writes the text paragraphs in order: greeting, lines, sign-off, after', () => {
    const parts = designedMail({
      language: 'en',
      subject: 'S',
      greeting: 'Hello,',
      lines: ['One.', { rows: [{ label: 'Kind', value: 'x' }] }],
      signature: ['TManage', 'Automatic.'],
      after: ['Why you got it.'],
    });
    expect(parts.text).toBe('Hello,\n\nOne.\n\nKind: x\n\nTManage\nAutomatic.\n\nWhy you got it.');
    expect(parts.html).toContain('>Why you got it.</td>');
    expect(parts.html).toContain('>x</span>');
  });

  it('uses the subject as the heading when there is no greeting', () => {
    const parts = designedMail({
      language: 'en',
      subject: 'Request accepted',
      lines: ['x'],
      signature: [],
    });
    expect(parts.html).toContain('>Request accepted</h1>');
    expect(parts.text).toBe('x');
  });

  it("passes the sign-off's link tokens through for the sender resolver to fill in both parts", async () => {
    const parts = designedMail({
      language: 'en',
      subject: 'S',
      lines: ['x'],
      signature: signOff('notice', 'en'),
    });
    expect(parts.html).toContain(LINK_TOKENS.unsubscribe);
    const sent: MailMessage[] = [];
    const resolver = new SenderResolvingMailer(
      { send: (message) => (sent.push(message), Promise.resolve('sent' as const)) },
      {
        identityAddress: 'noreply@tmanageapp.com',
        addresses: {
          hello: 'hello@tmanageapp.com',
          support: 'support@tmanageapp.com',
          noreply: 'noreply@tmanageapp.com',
        },
        sendAs: false,
        unsubscribe: { url: 'https://api.test/v1/unsubscribe', key: Buffer.alloc(32, 1) },
      },
    );
    await resolver.send({ to: 'a@b.test', subject: 'S', ...parts, templateKey: 'digest' });
    const html = sent[0]?.html ?? '';
    expect(html).not.toContain('[[tm.link.');
    expect(html).toContain('>Unsubscribe</a>');
    expect(sent[0]?.text).not.toContain('[[tm.link.');
  });
});

describe('renderTextReport', () => {
  it('draws an internal report: first line as the heading, each group a paragraph', () => {
    const html = renderTextReport('[TManage alert] x', 'Head line.\n\nKind: x\nTime: y\n\nFoot.');
    expect(html).toContain(MAIL_LAYOUT_MARK);
    expect(html).toContain('>Head line.</h1>');
    expect(html).toContain('Kind: x\nTime: y');
    expect(html).toContain('>Operations</p>');
  });
});
