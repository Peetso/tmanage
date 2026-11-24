import { MAIL_LAYOUT_MARK } from '@tmanage/mail';
import type { MailMessage } from '@tmanage/mail';
import { describe, expect, it } from 'vitest';
import { approvalMail } from '../../modules/approvals/external-approvals.service.js';
import {
  composeSignatureCodeMail,
  composeSignatureRequestMail,
} from '../../modules/approvals/esign.service.js';
import { composeSignInPolicyNotice } from '../../modules/identity/sign-in-policy.service.js';
import { composeAskResendEmail } from '../../modules/inbound-email/inbound-attachments.service.js';
import { composeSalesNotification } from '../../modules/outreach/walkthrough-content.js';
import { composeAcknowledgement } from '../../modules/security-reports/security-report-content.js';
import { renderAlert } from '../observability/alerts.js';
import { renderActionEmail } from './action-email.js';
import { composeCodeNotice } from './code-notice.js';
import { composeMfaCodeEmail } from './mfa-code-email.js';

/**
 * MAILDESIGN (2026-11-24) — every API mail that used to leave as bare text now carries the shared
 * designed layout (`@tmanage/mail` `layout.ts`) beside a correct text/plain part, and the Arabic
 * ones are right to left. The layouts that already existed draw through the same function.
 */

const RLM = String.fromCodePoint(0x20_0f);

type Parts = Pick<MailMessage, 'text' | 'html'>;

function expectDesigned(mail: Parts, language: 'en' | 'ar'): void {
  const html = mail.html ?? '';
  expect(html).toContain(MAIL_LAYOUT_MARK);
  expect(html).toContain(`<html lang="${language}" dir="${language === 'ar' ? 'rtl' : 'ltr'}">`);
  if (language === 'ar') expect(html).toContain('Alexandria');
  // The text part is real text: words, no markup.
  expect(mail.text.length).toBeGreaterThan(20);
  expect(mail.text).not.toMatch(/<[a-z!/]/iu);
}

describe('MAILDESIGN: API mails in the shared layout', () => {
  it('the one-time code (public link, challenge) shows the code in both parts, never in the subject', () => {
    for (const language of ['en', 'ar'] as const) {
      const mail = composeCodeNotice({
        to: 'a@b.test',
        code: '482913',
        minutes: 10,
        language,
        templateKey: 'public_link_code',
      });
      expectDesigned(mail, language);
      expect(mail.text).toContain('482913');
      expect(mail.html).toContain('>482913</p>');
      expect(mail.subject).not.toContain('482913');
    }
  });

  it('the e-sign code and the e-sign request', () => {
    const code = composeSignatureCodeMail({
      to: 'a@b.test',
      code: '102938',
      title: 'Contract',
      organizationName: 'Northstar',
    });
    expectDesigned(code, 'en');
    expect(code.html).toContain('>102938</p>');
    expect(code.templateKey).toBe('esign_code');

    const request = composeSignatureRequestMail({
      workspaceName: 'Northstar',
      title: 'Contract',
      link: 'https://app.test/northstar/portal/sign/1',
    });
    expectDesigned(request, 'en');
    expect(request.text).toContain('Read and sign: https://app.test/northstar/portal/sign/1');
    expect(request.html).toContain('href="https://app.test/northstar/portal/sign/1"');
    expect(request.html).toContain('Sent by TManage on behalf of Northstar.');
    expect(request.templateKey).toBe('esign_request');
    expect(request.audience).toBe('client');
  });

  it('the external approval, in each language', () => {
    for (const language of ['en', 'ar'] as const) {
      const mail = approvalMail({
        url: 'https://app.test/p/tok',
        organizationName: 'Northstar',
        title: 'Logo',
        versionNo: 2,
        message: null,
        expiresAt: '2026-12-01T00:00:00.000Z',
        language,
      });
      expectDesigned(mail, language);
      expect(mail.html).toContain('href="https://app.test/p/tok"');
      expect(mail.text).toContain('https://app.test/p/tok');
    }
  });

  it('the sign-in policy notice, in each language', () => {
    const before = {
      allowedMethods: ['password'],
      requireTwoStepRoles: 'nobody',
      graceUntil: null,
    } as const;
    const after = {
      allowedMethods: ['google'],
      requireTwoStepRoles: 'everyone',
      graceUntil: null,
    } as const;
    for (const language of ['en', 'ar'] as const) {
      const mail = composeSignInPolicyNotice(
        { email: 'owner@b.test', locale: language },
        before,
        after,
      );
      expectDesigned(mail, language);
      expect(mail.templateKey).toBe('credential_change');
    }
  });

  it('the ask-resend reply, in each language, with the agency as the eyebrow', () => {
    for (const language of ['en', 'ar'] as const) {
      const mail = composeAskResendEmail({
        to: 'client@b.test',
        replyTo: 'req@in.tmanageapp.com',
        subject: 'Brief',
        names: ['a.exe', 'b.zip'],
        workspaceName: 'Northstar',
        language,
      });
      expectDesigned(mail, language);
      expect(mail.html).toContain('>Northstar</p>');
      expect(mail.text).toContain('- a.exe');
    }
  });

  it('the security report acknowledgement, in each language', () => {
    for (const language of ['en', 'ar'] as const) {
      const mail = composeAcknowledgement('r@b.test', 'SR-1234', language);
      expectDesigned(mail, language);
      expect(mail.text).toContain('SR-1234');
      expect(mail.html).toContain('SR-1234');
    }
  });

  it('the internal mails: the ops alert and the walkthrough request', () => {
    const alert = renderAlert('http_5xx:/v1/x', { correlationId: 'c-1' }, new Date(0), 2);
    expectDesigned({ text: alert.text, html: alert.html }, 'en');
    expect(alert.html).toContain('>c-1</span>');

    const sales = composeSalesNotification(
      {
        name: 'Sam',
        email: 'sam@agency.example',
        company: 'Atlas',
        teamSize: '11-50',
        timeZone: 'Africa/Cairo',
        slots: ['2026-11-25T10:00', '2026-11-26T14:30', '2026-11-27T11:00'],
        topics: ['tour'],
        language: 'en',
        source: null,
      },
      'WT-ABCDEFGH',
    );
    expectDesigned(sales, 'en');
    expect(sales.html).toContain('>Atlas</span>');
  });

  it('the layouts that existed draw through the same shared function', () => {
    const action = renderActionEmail({
      arabic: true,
      subject: `${RLM}s`,
      eyebrow: 'e',
      heading: 'h',
      intro: 'i',
      rows: [],
      button: 'b',
      link: 'https://app.test/x',
      fallback: 'f',
      note: 'n',
      footer: 'ft',
    });
    expectDesigned({ text: 'plain text part of an action mail', html: action }, 'ar');
    const mfa = composeMfaCodeEmail({
      to: 'a@b.test',
      displayName: 'Sara',
      code: '042137',
      purpose: 'sign_in',
      ttlMinutes: 10,
      locale: 'ar',
    });
    expectDesigned(mfa, 'ar');
  });
});
