import { greeting, signOff } from '@tmanage/mail';
import type { Mailer, MailMessage } from '@tmanage/mail';
import { serializeForLog } from '../observability/logger.js';
import { EMAIL_TOKENS, escapeHtml, signatureRow } from './action-email.js';
import { emailIsRtl, emailT } from '../i18n/email-messages.js';

/**
 * MFAOPTIONS. The e-mail that carries a two-step verification code, and its sender.
 *
 * It says what the code is for (finishing a sign-in, or turning the e-mail method on), how long
 * it works, and what to do if the person did not ask for it. It carries **no link**: a link that
 * signs in would make the mailbox a password, which is the opposite of a second step. The code is
 * in the body only; it never reaches a log line — a failed send logs the transport error alone.
 */

export type MfaCodeEmailPurpose = 'sign_in' | 'enrol';

export interface MfaCodeEmailFacts {
  readonly to: string;
  readonly displayName: string;
  /** Six digits. */
  readonly code: string;
  readonly purpose: MfaCodeEmailPurpose;
  /** How long the code works, in minutes. */
  readonly ttlMinutes: number;
  /** The account's `locale` (`emailT` picks the catalog; English when it has none). */
  readonly locale?: string;
}

function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

export function composeMfaCodeEmail(facts: MfaCodeEmailFacts): MailMessage {
  const locale = facts.locale;
  const arabic = emailIsRtl(locale);
  const name = oneLine(facts.displayName);
  const minutes = String(facts.ttlMinutes);
  const language = arabic ? 'ar' : 'en';
  const signature = signOff('security', language);
  const copy = {
    subject: emailT(locale, 'mfaCode.subject'),
    preheader: emailT(locale, 'mfaCode.preheader', { minutes }),
    eyebrow: emailT(locale, 'mfaCode.eyebrow'),
    heading: greeting(language, name),
    intro: emailT(
      locale,
      facts.purpose === 'sign_in' ? 'mfaCode.introSignIn' : 'mfaCode.introEnrol',
    ),
    note: emailT(locale, 'mfaCode.note', { minutes }),
    footer: emailT(locale, 'mfaCode.footer'),
  };

  return {
    to: facts.to,
    language,
    subject: copy.subject,
    text: [
      copy.heading,
      emailT(locale, 'mfaCode.codeLine', { code: facts.code }),
      copy.intro,
      copy.note,
      copy.footer,
      signature.join('\n'),
    ].join('\n\n'),
    html: renderCodeEmail({ arabic, code: facts.code, signature, ...copy }),
  };
}

/** `action-email.ts`'s layout with the button and link replaced by the code itself. */
function renderCodeEmail(content: {
  readonly arabic: boolean;
  readonly code: string;
  readonly subject: string;
  readonly eyebrow: string;
  readonly heading: string;
  readonly intro: string;
  readonly note: string;
  readonly footer: string;
  readonly preheader: string;
  readonly signature: readonly string[];
}): string {
  const T = EMAIL_TOKENS;
  const e = escapeHtml;
  const { arabic } = content;
  const dir = arabic ? 'rtl' : 'ltr';
  const lang = arabic ? 'ar' : 'en';
  const align = arabic ? 'right' : 'left';
  const font = arabic ? T.fontArabic : T.fontLatin;
  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${e(content.subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${T.paper50};">
<div style="display:none;max-height:0;overflow:hidden;">${e(content.preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${T.paper50};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" dir="${dir}" style="max-width:560px;">
<tr><td style="padding:0 4px 16px 4px;text-align:${align};font-family:${font};">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="${align}"><tr>
<td width="28" height="28" align="center" valign="middle" style="background-color:${T.ink950};border-radius:8px;color:${T.lime500};font-family:${T.fontLatin};font-size:15px;font-weight:800;line-height:28px;">T</td>
<td style="padding:0 8px;font-family:${T.fontLatin};font-size:17px;font-weight:700;color:${T.ink950};" dir="ltr">TManage</td>
</tr></table>
</td></tr>
<tr><td style="background-color:${T.paper0};border:1px solid ${T.paper150};border-radius:16px;padding:32px;text-align:${align};font-family:${font};">
<p style="margin:0 0 12px 0;font-family:${arabic ? font : T.fontMono};font-size:12px;line-height:17px;letter-spacing:${arabic ? '0' : '0.08em'};text-transform:uppercase;color:${T.ink500};">${e(content.eyebrow)}</p>
<h1 style="margin:0 0 12px 0;font-family:${font};font-size:24px;line-height:31px;font-weight:700;color:${T.ink950};">${e(content.heading)}</h1>
<p style="margin:0 0 24px 0;font-family:${font};font-size:15px;line-height:22px;color:${T.ink650};">${e(content.intro)}</p>
<p style="margin:0 0 24px 0;padding:16px;background-color:${T.paper50};border-radius:12px;text-align:center;font-family:${T.fontMono};font-size:32px;line-height:40px;font-weight:700;letter-spacing:0.3em;color:${T.ink950};" dir="ltr">${e(content.code)}</p>
<p style="margin:0;padding:12px 14px;border:1px dashed ${T.paper150};border-radius:12px;font-family:${font};font-size:13px;line-height:18px;color:${T.ink650};">${e(content.note)}</p>
</td></tr>
${signatureRow(content.signature, font, align)}
<tr><td style="padding:16px 8px 0 8px;font-family:${font};font-size:12px;line-height:17px;color:${T.ink500};text-align:${align};">${e(content.footer)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * Sends the code. Absorbs a transport failure into `'failed'` and logs it without the message,
 * so the code never reaches the operator's log.
 */
export class MfaCodeMailer {
  constructor(private readonly mailer: Mailer | null) {}

  get enabled(): boolean {
    return this.mailer !== null;
  }

  async deliver(facts: MfaCodeEmailFacts): Promise<'sent' | 'none' | 'failed'> {
    if (this.mailer === null) return 'none';
    try {
      return await this.mailer.send(composeMfaCodeEmail(facts));
    } catch (error) {
      console.error('[mailer] two-step code email failed', serializeForLog(error));
      return 'failed';
    }
  }
}
