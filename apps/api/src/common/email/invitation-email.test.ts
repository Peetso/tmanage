import { describe, expect, it } from 'vitest';
import { composeInvitationEmail } from './invitation-email.js';
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
    expect(message.subject).toBe('Omar Farouk invited you to Northstar Studio on TManage');
    expect(message.text).toContain('You’ve been invited as producer');
    expect(message.text).toContain(
      'Review invitation: https://app.tmanage.example/invitations/tok123',
    );
    // §1: deadline with timezone.
    expect(message.text).toContain('expires on 13 September 2026 (UTC)');
    // §1: why this recipient, and a route for the unexpected case.
    expect(message.text).toContain('because Omar Farouk (omar@northstar.example) invited');
  });

  it('renders the client template — §3 "Invitation — client", minus the project it cannot name', () => {
    const message = composeInvitationEmail(facts({ clientOrganizationName: 'BrightOps' }));

    // The template's `{{project}}` has no column on an invitation; the subject says the
    // portal without inventing one. Recorded in docs/implementation-status.md.
    expect(message.subject).toBe('Northstar Studio invited you to their client portal');
    expect(message.text).toContain('shared with BrightOps');
    expect(message.text).toContain('Your role is producer.');
    expect(message.text).toContain('You will not see the team’s internal workspace.');
    expect(message.text).toContain('Review access: https://app.tmanage.example/invitations/tok123');
    expect(message.text).toContain('expires on 13 September 2026 (UTC)');
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

    expect(message.subject).toBe('Omar Farouk invited you to North star on TManage');
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
    expect(internal.text).toContain('invited as Team member');
    expect(internal.html).toContain('Team member');

    const client = composeInvitationEmail(
      facts({ role: 'client_viewer', clientOrganizationName: 'BrightOps' }),
    );
    expect(client.text).toContain('Your role is Client viewer.');
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
    expect(html).toContain('Review invitation');
    expect(html).toContain('13 September 2026 (UTC)');
  });

  it('escapes every interpolated name in the HTML part', () => {
    const html =
      composeInvitationEmail(facts({ organizationName: '<img src=x onerror=alert(1)>' })).html ??
      '';
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('writes Arabic, right to left, for an Arabic organization', () => {
    const message = composeInvitationEmail(facts({ locale: 'ar', role: 'member' }));

    expect(message.html).toContain('dir="rtl"');
    expect(message.html).toContain('lang="ar"');
    expect(message.text).toContain('عضو في الفريق');
    expect(message.subject).toContain('دعاك');
  });
});
