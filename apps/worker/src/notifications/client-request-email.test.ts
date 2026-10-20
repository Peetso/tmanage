import { describe, expect, it } from 'vitest';
import {
  composeClarificationRequiredEmail,
  composeClientRequestReceivedEmail,
  composeRequestAcceptedEmail,
  composeRequestDeclinedEmail,
  composeRequestDeferredEmail,
} from './client-request-email.js';
import type { ClientRequestEmailFacts } from './client-request-email.js';

/**
 * The three templates, as words. What the consumers do to real rows — the revocation
 * silences, which transitions mail at all, the send happening after the batch commits — is
 * proved against a real server in `apps/api/test/notif-002-client-request-mail.db.test.ts`.
 */

const BASE: ClientRequestEmailFacts = {
  recipientEmail: 'dana@atlas.example',
  recipientName: 'Dana Client',
  organizationName: 'Northwind Studio',
  organizationSlug: 'northwind',
  projectName: 'Spring Campaign',
  title: 'New landing page',
  desiredAt: '2026-09-30',
  committedAt: null,
  commitment: null,
  hasClarificationQuestion: false,
  clientSafeScopeSummary: null,
  clientVisibleReason: null,
  link: 'https://app.example/northwind/portal/requests/req-1',
};

/**
 * Every character a mail header parser treats as a line break. Built from code points: two of
 * them are invisible, and a character class holding them is unreviewable.
 */
const LINE_SEPARATORS = [0x0d, 0x0a, 0x2028, 0x2029].map((point) => String.fromCharCode(point));

function facts(overrides: Partial<ClientRequestEmailFacts>): ClientRequestEmailFacts {
  return { ...BASE, ...overrides };
}

describe('composeClientRequestReceivedEmail', () => {
  it('renders §3’s subject and says the requested date is not a commitment', () => {
    const message = composeClientRequestReceivedEmail(BASE);
    expect(message.to).toBe('dana@atlas.example');
    expect(message.subject).toBe('Request received: New landing page');
    expect(message.text).toContain('We received your request for Spring Campaign.');
    expect(message.text).toContain('2026-09-30 is a requested date, not a confirmed commitment');
  });

  it('drops the date caveat rather than writing a sentence about nothing', () => {
    const message = composeClientRequestReceivedEmail(facts({ desiredAt: null }));
    expect(message.text).toContain('You did not ask for a particular date.');
    expect(message.text).not.toContain('requested date, not a confirmed');
  });

  it('names the studio where §3 names a {{manager}} this product cannot resolve', () => {
    const message = composeClientRequestReceivedEmail(BASE);
    expect(message.text).toContain('The Northwind Studio team will review the scope');
  });
});

describe('composeClarificationRequiredEmail', () => {
  it('renders §3’s subject and says a question is waiting, never how many', () => {
    const message = composeClarificationRequiredEmail(facts({ hasClarificationQuestion: true }));
    expect(message.subject).toBe('Your input is needed for New landing page');
    expect(message.text).toContain('needs an answer to a question');
    // `{{questionCount}}` has no value: one column, one question. Never render a count.
    expect(message.text).not.toMatch(/\banswer\(s\)/u);
  });

  it('never carries the question itself — the facts do not even hold it', () => {
    const message = composeClarificationRequiredEmail(facts({ hasClarificationQuestion: true }));
    expect(Object.keys(BASE)).not.toContain('clarificationQuestion');
    expect(message.text).toContain('The question is on your request in the portal.');
  });

  it('does not promise an in-portal reply the portal cannot accept', () => {
    const message = composeClarificationRequiredEmail(facts({ hasClarificationQuestion: true }));
    expect(message.text).toContain('You cannot reply inside the portal');
    // REQ-16: no "yet", which promised a reply surface the portal has not committed to.
    expect(message.text).not.toContain('portal yet');
    expect(message.text).toContain('View request: https://app.example/northwind/portal/requests/');
    expect(message.text).not.toContain('Answer questions:');
  });
});

describe('composeRequestAcceptedEmail', () => {
  it('renders §3’s subject, the client-safe summary and the committed date', () => {
    const message = composeRequestAcceptedEmail(
      facts({
        commitment: 'committed',
        committedAt: '2026-10-15',
        clientSafeScopeSummary: 'One landing page, two rounds of revisions.',
      }),
    );
    expect(message.subject).toBe('Request accepted: New landing page');
    expect(message.text).toContain('Committed outcome: One landing page, two rounds of revisions.');
    expect(message.text).toContain('Current committed date: 2026-10-15.');
  });

  it('prints no zone, because a DATE has none since migration 0012', () => {
    const message = composeRequestAcceptedEmail(
      facts({ commitment: 'committed', committedAt: '2026-10-15' }),
    );
    expect(message.text).not.toMatch(/UTC|GMT|[+-]\d{2}:\d{2}/u);
  });

  it('says an unscheduled acceptance is unscheduled instead of printing an empty date', () => {
    const message = composeRequestAcceptedEmail(
      facts({ commitment: 'unscheduled', committedAt: null, clientSafeScopeSummary: 'Scoped.' }),
    );
    expect(message.text).toContain('No date is committed.');
    expect(message.text).not.toContain('committed yet');
    expect(message.text).not.toContain('Current committed date');
  });

  it('falls back to a plain acceptance when no client-safe summary was written', () => {
    const message = composeRequestAcceptedEmail(
      facts({ commitment: 'committed', committedAt: '2026-10-15' }),
    );
    expect(message.text).toContain('Northwind Studio accepted your request.');
    expect(message.text).not.toContain('null');
  });
});

describe('composeRequestDeclinedEmail and composeRequestDeferredEmail', () => {
  it('declines with §3’s subject and carries the manager’s client-safe reason', () => {
    const message = composeRequestDeclinedEmail(
      facts({ clientVisibleReason: 'This sits outside the current statement of work.' }),
    );
    expect(message.subject).toBe('Request declined: New landing page');
    expect(message.text).toContain('Northwind Studio has declined this request.');
    expect(message.text).toContain('Reason: This sits outside the current statement of work.');
  });

  it('defers with §3’s subject and carries the reason', () => {
    const message = composeRequestDeferredEmail(
      facts({ clientVisibleReason: 'Parked until the next quarter.' }),
    );
    expect(message.subject).toBe('Request deferred: New landing page');
    expect(message.text).toContain('Northwind Studio has deferred this request.');
    expect(message.text).toContain('Reason: Parked until the next quarter.');
  });

  it('states the outcome plainly when no client-safe reason was written, never "null"', () => {
    for (const message of [
      composeRequestDeclinedEmail(facts({ clientVisibleReason: null })),
      composeRequestDeferredEmail(facts({ clientVisibleReason: null })),
    ]) {
      expect(message.text).toContain('this request.');
      expect(message.text).not.toContain('Reason:');
      expect(message.text).not.toContain('null');
    }
  });

  it('cannot grow a header out of a reason a manager typed', () => {
    const injected = composeRequestDeclinedEmail(
      facts({ clientVisibleReason: 'No.\r\nBcc: attacker@example.com' }),
    );
    expect(injected.subject.includes('\r')).toBe(false);
    expect(injected.text).not.toMatch(/\r\n/u);
  });
});

describe('subjectTitle', () => {
  it('leaves a short title whole and never cuts a long one mid-word', () => {
    const short = composeClientRequestReceivedEmail(BASE);
    expect(short.subject).toBe('Request received: New landing page');

    const long =
      'Redesign the entire marketing site including pricing careers and blog plans '.repeat(3);
    const message = composeClientRequestReceivedEmail(facts({ title: long }));
    const rendered = message.subject.replace('Request received: ', '');
    // Closed with a single ellipsis character — never the two-dot "plans.." REQ-09 found.
    expect(rendered.endsWith('…')).toBe(true);
    expect(rendered).not.toContain('..');
    expect(rendered.length).toBeLessThan(long.length);
    // No dangling space or punctuation immediately before the ellipsis.
    expect(rendered.at(-2)).not.toBe(' ');
  });
});

describe('every template', () => {
  const all = [
    composeClientRequestReceivedEmail(BASE),
    composeClarificationRequiredEmail(BASE),
    composeRequestAcceptedEmail(BASE),
  ];

  it('carries §1’s why-recipient and support route', () => {
    for (const message of all) {
      expect(message.text).toContain(
        'You are receiving this because you submitted this request to Northwind Studio',
      );
      expect(message.text).toContain('contact Northwind Studio directly');
    }
  });

  it('carries exactly one link, and it is the portal route', () => {
    for (const message of all) {
      const links = message.text.match(/https?:\/\/\S+/gu) ?? [];
      expect(links).toEqual(['https://app.example/northwind/portal/requests/req-1']);
    }
  });

  it('cannot grow a header out of a title a client typed', () => {
    const injected = facts({
      title: 'Rebrand\r\nBcc: attacker@example.com',
      organizationName: 'North\nwind',
      projectName: 'Spring\r\nCampaign',
    });
    for (const message of [
      composeClientRequestReceivedEmail(injected),
      composeClarificationRequiredEmail(injected),
      composeRequestAcceptedEmail(injected),
    ]) {
      // The line break is what makes a second header, and it is what has to go. The words
      // `Bcc: attacker@example.com` surviving *inside* one folded subject line are not a
      // header — they are a client who typed something odd into a title, which is their
      // right. `LINE_SEPARATORS` is built from code points rather than written literally,
      // because U+2028 and U+2029 are invisible in a source file and a reviewer cannot
      // check a character class that contains them.
      for (const separator of LINE_SEPARATORS) {
        const point = separator.codePointAt(0) ?? 0;
        expect(message.subject.includes(separator), `subject holds U+${point.toString(16)}`).toBe(
          false,
        );
        // The body is deliberately multi-paragraph, so its own U+000A is not a finding; what
        // must not appear there is a separator carried in from an interpolated string.
        if (point !== 0x0a) {
          expect(message.text.includes(separator), `body holds U+${point.toString(16)}`).toBe(
            false,
          );
        }
      }
    }
    // And the flattening is real, not accidental: the title arrives as one line.
    expect(composeClientRequestReceivedEmail(injected).subject).toBe(
      'Request received: Rebrand Bcc: attacker@example.com',
    );
  });

  it('is plain text with no markup anywhere', () => {
    for (const message of all) {
      expect(message.text).not.toMatch(/<[a-z/]/iu);
    }
  });
});
