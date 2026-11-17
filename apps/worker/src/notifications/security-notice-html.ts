import { signatureRowHtml } from './notice-sign-off.js';

/**
 * The HTML twin of a security receipt's text body, in the layout of the API's action emails
 * (`apps/api/src/common/email/action-email.ts`: same tokens, wordmark and card) minus the
 * button and the link — a security notice must never carry one (see
 * `credential-change-mailer.ts`). The worker cannot import from the API, so the token values
 * it needs are repeated here. Every string is HTML-escaped; callers pass plain text.
 */

const TOKENS = {
  ink950: '#090a09',
  ink650: '#4d5049',
  ink500: '#74786f',
  paper0: '#ffffff',
  paper50: '#f7f7f3',
  paper150: '#e9e9e5',
  lime500: '#b7ff57',
  fontLatin: "Manrope, 'Segoe UI', Helvetica, Arial, sans-serif",
  fontArabic: "Alexandria, Tahoma, 'Segoe UI', Arial, sans-serif",
  fontMono: "'Geist Mono', Consolas, 'Courier New', monospace",
} as const;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export interface SecurityNoticeContent {
  /** Also the heading. */
  readonly subject: string;
  readonly intro: string;
  /** Label/value facts in a panel under the intro. */
  readonly rows: readonly { readonly label: string; readonly value: string }[];
  /** The dashed note — what to do if the change was not the recipient's. */
  readonly note: string;
  /** Under the card: why this person received the message. */
  readonly footer: string;
  /** EMAILBUILD (c): Arabic, right to left. */
  readonly arabic?: boolean;
  /** EMAILBUILD (c): the eyebrow over the heading (default "Security notice"). */
  readonly eyebrow?: string;
  /** EMAILBUILD (c): the [SEC] sign-off lines, drawn under the card. */
  readonly signature?: readonly string[];
}

export function renderSecurityNoticeHtml(content: SecurityNoticeContent): string {
  const T = TOKENS;
  const e = escapeHtml;
  const arabic = content.arabic === true;
  const font = arabic ? T.fontArabic : T.fontLatin;
  const align = arabic ? 'right' : 'left';
  const dir = arabic ? 'rtl' : 'ltr';
  const rows = content.rows
    .map(
      (row, index) =>
        `<tr><td style="padding:14px 16px;${index < content.rows.length - 1 ? `border-bottom:1px solid ${T.paper150};` : ''}font-family:${font};font-size:13px;line-height:18px;color:${T.ink500};">${e(row.label)}<br><span style="font-size:15px;line-height:22px;font-weight:700;color:${T.ink950};">${e(row.value)}</span></td></tr>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="${arabic ? 'ar' : 'en'}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${e(content.subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${T.paper50};">
<div style="display:none;max-height:0;overflow:hidden;">${e(content.intro)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${T.paper50};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" dir="${dir}" style="max-width:560px;">
<tr><td style="padding:0 4px 16px 4px;font-family:${font};">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="${align}" dir="ltr"><tr>
<td width="28" height="28" align="center" valign="middle" style="background-color:${T.ink950};border-radius:8px;color:${T.lime500};font-family:${font};font-size:15px;font-weight:800;line-height:28px;">T</td>
<td style="padding:0 8px;font-family:${font};font-size:17px;font-weight:700;color:${T.ink950};">TManage</td>
</tr></table>
</td></tr>
<tr><td style="background-color:${T.paper0};border:1px solid ${T.paper150};border-radius:16px;padding:32px;text-align:${align};font-family:${font};">
<p style="margin:0 0 12px 0;font-family:${T.fontMono};font-size:12px;line-height:17px;letter-spacing:${arabic ? '0' : '0.08em'};text-transform:uppercase;color:${T.ink500};">${e(content.eyebrow ?? 'Security notice')}</p>
<h1 style="margin:0 0 12px 0;font-family:${font};font-size:24px;line-height:31px;font-weight:700;color:${T.ink950};">${e(content.subject)}</h1>
<p style="margin:0 0 24px 0;font-family:${font};font-size:15px;line-height:22px;color:${T.ink650};">${e(content.intro)}</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${T.paper50};border-radius:12px;">
${rows}
</table>
<div style="height:24px;line-height:24px;font-size:0;">&nbsp;</div>
<p style="margin:0;padding:12px 14px;border:1px dashed ${T.paper150};border-radius:12px;font-family:${font};font-size:13px;line-height:18px;color:${T.ink650};">${e(content.note)}</p>
</td></tr>
${signatureRowHtml(content.signature ?? [], font, align)}
<tr><td style="padding:16px 8px 0 8px;text-align:${align};font-family:${font};font-size:12px;line-height:17px;color:${T.ink500};">${e(content.footer)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
