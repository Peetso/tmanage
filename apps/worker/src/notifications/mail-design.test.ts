import {
  MAIL_LAYOUT_MARK,
  composeMonthlyGtmReport,
  composeSecurityAlertDigest,
} from '@tmanage/mail';
import type { MailMessage } from '@tmanage/mail';
import { describe, expect, it } from 'vitest';
import {
  composeClarificationRequiredEmail,
  composeClientRequestReceivedEmail,
  composeRequestAcceptedEmail,
  composeRequestDeclinedEmail,
  composeRequestDeferredEmail,
} from './client-request-email.js';
import type { ClientRequestEmailFacts } from './client-request-email.js';
import { composeCollaborationEmail } from './collaboration-mailer.js';
import type { CollaborationEmailFacts, CollaborationMailKind } from './collaboration-mailer.js';
import { composeCredentialChangeEmail } from './credential-change-mailer.js';
import { composeDigestEmail } from './digest-mailer.js';
import { composePrivacyEmail } from './privacy-mailer.js';
import type { PrivacyMailKind } from './privacy-mailer.js';
import { composeStorageRootEmail } from './storage-root-mailer.js';
import { composeUsageThresholdEmail } from './usage-threshold-mailer.js';

/**
 * MAILDESIGN (2026-11-24) — every worker mail that used to leave as bare text now carries the
 * shared designed layout (`@tmanage/mail` `layout.ts`) beside a correct text/plain part, and the
 * Arabic ones are right to left.
 */

const RLM = String.fromCodePoint(0x20_0f);
const LANGUAGES = ['en', 'ar'] as const;

function expectDesigned(mail: Pick<MailMessage, 'text' | 'html'>, language: 'en' | 'ar'): void {
  const html = mail.html ?? '';
  expect(html).toContain(MAIL_LAYOUT_MARK);
  expect(html).toContain(`<html lang="${language}" dir="${language === 'ar' ? 'rtl' : 'ltr'}">`);
  if (language === 'ar') {
    expect(html).toContain('Alexandria');
    expect(html).not.toContain(RLM);
  }
  expect(mail.text.length).toBeGreaterThan(20);
  expect(mail.text).not.toMatch(/<[a-z!/]/iu);
}

describe('MAILDESIGN: worker mails in the shared layout', () => {
  const collaboration: CollaborationEmailFacts = {
    recipientEmail: 'lina@studio.test',
    recipientName: 'Lina Saad',
    organizationName: 'Northstar Studio',
    actorName: 'Omar',
    subjectTitle: 'Homepage',
    projectName: 'Website',
    when: '2026-11-25 10:00 UTC',
    link: 'https://app.test/northstar/x',
    dueDate: '2026-11-30',
    decision: 'approved',
    assigneeRole: 'doer',
  };
  const plainKinds: readonly CollaborationMailKind[] = [
    'mention',
    'comment',
    'meeting_invite',
    'meeting_changed',
    'project_added',
    'client_action',
    'request_message',
    'approval_decided',
    'people_assigned',
    'supervised_done',
  ];

  it('the collaboration notices: a button to the screen, in each language', () => {
    for (const kind of plainKinds) {
      for (const language of LANGUAGES) {
        const mail = composeCollaborationEmail(kind, { ...collaboration, locale: language });
        expectDesigned(mail, language);
        expect(mail.html).toContain(`href="${collaboration.link}"`);
        expect(mail.text).toContain(collaboration.link);
      }
    }
  });

  it("a portal reader's notice carries the agency as the eyebrow and its sign-off", () => {
    const mail = composeCollaborationEmail('request_message', { ...collaboration, portal: true });
    expect(mail.html).toContain('>Northstar Studio</p>');
    expect(mail.html).toContain('Sent by TManage on behalf of Northstar Studio.');
  });

  it('the five client-request mails', () => {
    const facts: ClientRequestEmailFacts = {
      recipientEmail: 'c@client.test',
      recipientName: 'Client',
      organizationName: 'Northstar',
      organizationSlug: 'northstar',
      projectName: 'Website',
      title: 'New page',
      desiredAt: null,
      committedAt: null,
      commitment: null,
      hasClarificationQuestion: false,
      clientSafeScopeSummary: null,
      clientVisibleReason: null,
      link: 'https://app.test/northstar/portal/requests/1',
    };
    for (const compose of [
      composeClientRequestReceivedEmail,
      composeClarificationRequiredEmail,
      composeRequestAcceptedEmail,
      composeRequestDeclinedEmail,
      composeRequestDeferredEmail,
    ]) {
      const mail = compose(facts);
      expectDesigned(mail, 'en');
      expect(mail.html).toContain(`href="${facts.link}"`);
      expect(mail.text).toContain('You are receiving this because you submitted this request');
    }
  });

  it('the digest, in each language', () => {
    for (const language of LANGUAGES) {
      const mail = composeDigestEmail({
        recipientEmail: 'a@b.test',
        recipientName: 'Sara',
        organizationName: 'Northstar',
        locale: language,
        cadence: 'daily',
        counts: { mention: 2, work_item: 1 },
        inboxLink: 'https://app.test/inbox',
        settingsLink: 'https://app.test/settings/notifications',
      });
      expectDesigned(mail, language);
      expect(mail.html).toContain('href="https://app.test/inbox"');
    }
  });

  it('the four privacy mails, in each language', () => {
    const kinds: readonly PrivacyMailKind[] = [
      'export_ready',
      'deletion_scheduled',
      'deletion_cancelled',
      'deletion_executed',
    ];
    for (const kind of kinds) {
      for (const language of LANGUAGES) {
        const mail = composePrivacyEmail(kind, {
          recipientEmail: 'a@b.test',
          recipientName: 'Sara',
          locale: language,
          organizationName: 'Northstar',
          scope: 'account',
          scheduledFor: new Date('2026-12-24T00:00:00Z'),
          ...(kind === 'deletion_executed' ? {} : { link: 'https://app.test/privacy' }),
        });
        expectDesigned(mail, language);
        if (kind !== 'deletion_executed') {
          expect(mail.html).toContain('href="https://app.test/privacy"');
        }
      }
    }
  });

  it('the storage and usage notices, with and without a link, in each language', () => {
    for (const language of LANGUAGES) {
      for (const link of ['https://app.test/settings/storage', undefined]) {
        const storage = composeStorageRootEmail({
          recipientEmail: 'a@b.test',
          recipientName: 'Sara',
          provider: 'google_drive',
          reason: 'personal_root',
          workspaceName: 'Northstar',
          locale: language,
          ...(link === undefined ? {} : { link }),
        });
        expectDesigned(storage, language);
        const usage = composeUsageThresholdEmail({
          recipientEmail: 'a@b.test',
          recipientName: 'Sara',
          band: 85,
          used: 850,
          reserved: 0,
          quota: 1000,
          workspaceName: 'Northstar',
          locale: language,
          ...(link === undefined ? {} : { link }),
        });
        expectDesigned(usage, language);
        if (link === undefined) {
          // No button without a link: the line names the place in the app instead.
          expect(usage.html).not.toContain('<a href');
        } else expect(usage.html).toContain(`href="${link}"`);
      }
    }
  });

  it('the security receipt draws through the same layout, in each language', () => {
    for (const language of LANGUAGES) {
      const mail = composeCredentialChangeEmail({
        recipient: { email: 'a@b.test', displayName: 'Sara' },
        action: 'password_set',
        occurredAt: new Date('2026-11-24T10:00:00Z'),
        locale: language,
      });
      expect(mail).not.toBeNull();
      expectDesigned(mail!, language);
      expect(mail!.html).not.toMatch(/<a\b/iu);
    }
  });

  it("the operator's security digest and growth report", () => {
    const digest = composeSecurityAlertDigest({
      audience: 'platform',
      generatedAt: new Date('2026-11-24T10:00:00Z'),
      signals: [],
    });
    expectDesigned(digest, 'en');
    const growth = composeMonthlyGtmReport({
      month: '2026-10',
      generatedAt: new Date('2026-11-01T00:00:00Z'),
      signups: 3,
      signupsBySource: [],
      activation: { rate: null, steps: [] },
      serviceActivation: { rate: null, steps: [] },
      timeToFirstProjectP50Hours: null,
      approvalTurnaroundHours: null,
      mrr: null,
      rows: [],
    });
    expectDesigned(growth, 'en');
  });
});
