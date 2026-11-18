import { signOff, workspaceReplyLine, workspaceSignOff } from '@tmanage/mail';
import type { MailLanguage } from '@tmanage/mail';

/**
 * EMAILBUILD (c) — the sign-off of a worker notification, by who reads it (amendment 1):
 * a team member gets [TM] ("TManage", automatic, replies not read, settings and unsubscribe
 * links); a client person in the portal gets the agency's [WS] with reply line R3 (replies are
 * not read, answer in the portal). Never a TManage person: person names are for tips only.
 */
export function noticeSignature(
  language: MailLanguage,
  audience: { readonly portal: boolean; readonly workspaceName: string; readonly link: string },
): readonly string[] {
  if (!audience.portal) return signOff('notice', language);
  const reply = workspaceReplyLine(language, 'none', {
    workspaceName: audience.workspaceName,
    portalLink: audience.link,
  });
  return workspaceSignOff(language, audience.workspaceName, reply);
}

/** The language of a mail from a BCP-47 locale: Arabic for `ar*`, English otherwise. */
export function mailLanguage(locale: string | undefined): MailLanguage {
  return locale !== undefined && /^ar(?:-|$)/iu.test(locale) ? 'ar' : 'en';
}

/** The mail card's `packages/ui` token values (the worker cannot import the api's layout). */
export const MAIL_TOKENS = {
  ink950: '#090a09',
  ink650: '#4d5049',
  ink500: '#74786f',
  paper0: '#ffffff',
  paper50: '#f7f7f3',
  paper150: '#e9e9e5',
  lime500: '#b7ff57',
  fontLatin: "Manrope, 'Segoe UI', Helvetica, Arial, sans-serif",
  fontArabic: "Alexandria, Tahoma, 'Segoe UI', Arial, sans-serif",
} as const;

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * The signature block under a worker mail's card, as the API layout draws it (`signatureRow` in
 * `action-email.ts`; the worker cannot import the API): the first line in ink, the rest small,
 * one paragraph per line so an unfilled links line can be dropped by the resolver.
 */
export function signatureRowHtml(
  lines: readonly string[],
  font: string,
  align: 'left' | 'right',
): string {
  if (lines.length === 0) return '';
  const body = lines
    .map((line, index) =>
      index === 0
        ? `<p style="margin:0 0 4px 0;font-family:${font};font-size:14px;line-height:20px;font-weight:700;color:#090a09;">${escapeHtml(line)}</p>`
        : `<p style="margin:0 0 4px 0;font-family:${font};font-size:12px;line-height:17px;color:#4d5049;">${escapeHtml(line)}</p>`,
    )
    .join('\n');
  // dir on the cell itself: a client that drops the outer dir still keeps the footer's order.
  const dir = align === 'right' ? 'rtl' : 'ltr';
  return `<tr><td dir="${dir}" style="padding:20px 8px 0 8px;text-align:${align};">\n${body}\n</td></tr>`;
}
