import { describe, expect, it } from 'vitest';
import { composeInvitationEmail, mailSafeName, MAX_MAIL_NAME_LENGTH } from './invitation-email.js';
import type { InvitationEmailFacts } from './invitation-email.js';

/**
 * The composer against `35-NOTIFICATION-AND-EMAIL-COPY` §3's two invitation templates and
 * §1's checklist. The database suite proves a real issue sends a real message; this file
 * proves the message says what the copy specification wrote, without a server anywhere.
 */

const facts = (overrides: Partial<InvitationEmailFacts> = {}): InvitationEmailFacts => ({
  to: 'nadia@brightops.example',
  clientOrganizationName: null,
  organizationName: 'Northstar Studio',
  inviterName: 'Omar Farouk',
  inviterEmail: 'omar@northstar.example',
  role: 'producer',
  expiresAt: new Date('2026-09-13T10:00:00.000Z'),
  link: 'https://app.tmanage.example/invitations/tok123',
  ...overrides,
});

describe('composeInvitationEmail', () => {
  it('renders the internal template — §3 "Invitation — internal"', () => {
    const message = composeInvitationEmail(facts());

    expect(message.to).toBe('nadia@brightops.example');
    expect(message.subject).toBe('Omar Farouk invited you to Northstar Studio');
    expect(message.text).toContain(
      'invited you to work with the team at Northstar Studio on TManage',
    );
    expect(message.text).toContain('Your role: producer.');
    expect(message.text).toContain(
      'Accept the invitation: https://app.tmanage.example/invitations/tok123',
    );
    // §1: deadline with timezone, and a route for the unexpected case.
    expect(message.text).toContain('open until 13 September 2026 (UTC)');
    expect(message.text).toContain('You can ignore this e-mail');
    expect(message.text).toContain('Sent by TManage on behalf of Northstar Studio');
  });

  it('renders the client template — §3 "Invitation — client", minus the project it cannot name', () => {
    const message = composeInvitationEmail(facts({ clientOrganizationName: 'BrightOps' }));

    // The template's `{{project}}` has no column on an invitation; the subject says the
    // portal without inventing one. Recorded in docs/implementation-status.md.
    expect(message.text).toContain('the Northstar Studio client portal');
    expect(message.text).toContain('shared with BrightOps');
    expect(message.text).toContain('Your role: producer.');
    expect(message.text).toContain("You will not see the team's internal workspace.");
    expect(message.text).toContain(
      'Accept the invitation: https://app.tmanage.example/invitations/tok123',
    );
    expect(message.text).toContain('open until 13 September 2026 (UTC)');
  });

  it('flattens header-bound interpolations to one line', () => {
    // An organization is named by its tenant: a newline in a subject is how one message
    // grows extra headers. The line separator (U+2028) is built from a char code so no
    // invisible character sits in this file's source.
    const separator = String.fromCharCode(0x20_28);
    const message = composeInvitationEmail(
      facts({
        organizationName: 'North\r\nstar',
        inviterName: `Omar${separator}Farouk`,
      }),
    );

    expect(message.subject).toBe('Omar Farouk invited you to North star');
    expect(message.subject).not.toMatch(/[\r\n]/u);
    expect(message.subject).not.toContain(separator);
  });

  it('keeps the token out of everything except the link', () => {
    const message = composeInvitationEmail(facts());
    const occurrences = message.text.split('tok123').length - 1;

    expect(occurrences).toBe(1);
    expect(message.subject).not.toContain('tok123');
  });

  // ACC-05: the walkthrough's invitee read "invited as member" — an internal code.
  it('names the role in words, never the internal code', () => {
    const internal = composeInvitationEmail(facts({ role: 'member' }));
    expect(internal.text).toContain('Your role: Team member.');
    expect(internal.html).toContain('Team member');

    const client = composeInvitationEmail(
      facts({ role: 'client_viewer', clientOrganizationName: 'BrightOps' }),
    );
    expect(client.text).toContain('Your role: Client viewer.');
    expect(client.text).not.toContain('client_viewer');
  });

  // ACC-07: the copy says "reply to the inviter", so a reply has to reach the inviter.
  it('routes replies to the inviter', () => {
    expect(composeInvitationEmail(facts()).replyTo).toBe('omar@northstar.example');
  });

  it('renders one button whose href is exactly the link printed beneath it', () => {
    const html = composeInvitationEmail(facts()).html ?? '';
    const hrefs = [...html.matchAll(/href="([^"]*)"/gu)].map((match) => match[1]);

    expect(hrefs).toEqual([
      'https://app.tmanage.example/invitations/tok123',
      'https://app.tmanage.example/invitations/tok123',
    ]);
    expect(html).toContain('>https://app.tmanage.example/invitations/tok123</a>');
    expect(html).toContain('Accept the invitation');
    expect(html).toContain('>OF</td>');
    expect(html).toContain('13 September 2026 (UTC)');
  });

  it('escapes every interpolated name in the HTML part', () => {
    const html =
      composeInvitationEmail(facts({ organizationName: '<img src=x onerror=alert(1)>' })).html ??
      '';
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('F36b: neutralises links, phone numbers and addresses in names, and caps their length', () => {
    const message = composeInvitationEmail(
      facts({
        organizationName: 'Pay at evil.example/x +1 555 0100',
        inviterName: `Billing https://evil.example/pay call 0044 20 7946 0958 ${'x'.repeat(80)}`,
        clientOrganizationName: 'Write to refunds@evil.example',
      }),
    );
    const everything = `${message.subject}
${message.text}
${message.html ?? ''}`;
    for (const fragment of [
      'Pay at evil.example/x +1 555 0100',
      'evil.example',
      '555 0100',
      '7946',
      'refunds@',
      'https://evil',
    ]) {
      expect(everything).not.toContain(fragment);
    }
    expect(message.subject).toContain('Pay at');
    // The one real link is still there, exactly once in the text.
    expect(message.text).toContain('https://app.tmanage.example/invitations/tok123');
    expect(mailSafeName('y'.repeat(200))).toHaveLength(MAX_MAIL_NAME_LENGTH);
    expect(mailSafeName('Northstar Studio')).toBe('Northstar Studio');
  });

  it('wave11 Q6 M03: a zero-width split does not get a link past the filter', () => {
    const zwsp = String.fromCodePoint(0x20_0b);
    expect(mailSafeName(`pay at evil${zwsp}.com`)).toBe(mailSafeName('pay at evil.com'));
    expect(mailSafeName(`Northstar${zwsp} Studio`)).toBe('Northstar Studio');
  });

  it.each(['en', 'ar'])(
    'wave10 R2 F36b: %s — non-ASCII digits, slash-separated phones and look-alike dots are neutralised',
    (locale) => {
      const arabicIndicPhone = '٠١٠ ٠١٢٣ ٤٥٦٧';
      const extendedPhone = '۰۹۱۲-۳۴۵-۶۷۸۹';
      const fullWidthPhone = '０１００１２３４';
      const message = composeInvitationEmail(
        facts({
          locale,
          organizationName: `Call ${arabicIndicPhone} refund-portal。com`,
          inviterName: `Support +1/555/010/0100 evil．example pay｡example ${extendedPhone}`,
          clientOrganizationName: `Desk ${fullWidthPhone} refunds＠evil.example`,
        }),
      );
      const everything = `${message.subject}
${message.text}
${message.html ?? ''}`;
      for (const fragment of [
        arabicIndicPhone,
        '١٢٣',
        extendedPhone,
        '۳۴۵',
        fullWidthPhone,
        '01001234',
        '+1/555/010/0100',
        '555/010',
        '0100',
        'refund-portal。com',
        'refund-portal',
        'portal.com',
        'evil．example',
        'evil.example',
        'pay｡example',
        'pay.example',
        'refunds',
      ]) {
        expect(everything).not.toContain(fragment);
      }
      // The surrounding words survive, and the one real link is still there.
      expect(message.subject).toContain('Call');
      expect(message.text).toContain('https://app.tmanage.example/invitations/tok123');
    },
  );

  it('writes Arabic, right to left, for an Arabic recipient', () => {
    const message = composeInvitationEmail(facts({ locale: 'ar-EG', role: 'member' }));
    const rlm = String.fromCharCode(0x20_0f);

    expect(message.html).toContain('dir="rtl"');
    expect(message.html).toContain('lang="ar"');
    expect(message.html).toContain('Alexandria');
    expect(message.text).toContain('دورك: عضو في الفريق.');
    expect(message.text).toContain('13 سبتمبر 2026 (UTC)');
    expect(message.text).toContain(
      `${rlm}دعاك Omar Farouk للعمل مع فريق Northstar Studio على TManage`,
    );
    expect(message.subject).toContain('دعاك');
  });

  it('falls back to English for an unknown locale', () => {
    const message = composeInvitationEmail(facts({ locale: 'xx-YY' }));
    expect(message.html).toContain('dir="ltr"');
    expect(message.subject).toBe('Omar Farouk invited you to Northstar Studio');
  });
});
