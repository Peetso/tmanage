/**
 * The one HTML layout TManage's action emails share — an invitation, a password-reset link.
 *
 * Table-based so Gmail and Outlook draw it the same way; every colour and type family is a
 * value from `packages/ui/src/styles/tokens.css` (ink, paper, lime, Manrope / Alexandria /
 * Geist Mono). One button, and its `href` is exactly the URL printed under it as the fallback,
 * so the visible link and the clicked one can never differ. Every string is HTML-escaped here;
 * callers pass plain text. `arabic` switches to `dir="rtl"` and the Arabic family.
 *
 * The layout follows the existing tokens; a Figma pass of the email is still to come.
 */

export const EMAIL_TOKENS = {
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

const TOKENS = EMAIL_TOKENS;

export interface ActionEmailContent {
  readonly arabic: boolean;
  readonly subject: string;
  readonly eyebrow: string;
  readonly heading: string;
  readonly intro: string;
  /** Label/value facts in a panel under the intro (role, access). May be empty. */
  readonly rows: readonly { readonly label: string; readonly value: string }[];
  readonly button: string;
  /** The one URL. Built from configuration by the caller, never from a request. */
  readonly link: string;
  /** "Button not working? Copy this link…" */
  readonly fallback: string;
  /** The dashed note — an expiry. */
  readonly note: string;
  /** Under the card: why this person received the message. */
  readonly footer: string;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderActionEmail(content: ActionEmailContent): string {
  const { arabic, link } = content;
  const copy = content;
  const dir = arabic ? 'rtl' : 'ltr';
  const lang = arabic ? 'ar' : 'en';
  const align = arabic ? 'right' : 'left';
  const font = arabic ? TOKENS.fontArabic : TOKENS.fontLatin;
  const e = escapeHtml;
  const href = e(link);
  const rows =
    content.rows.length === 0
      ? ''
      : `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${TOKENS.paper50};border-radius:12px;">` +
        content.rows
          .map(
            (row, index) =>
              `<tr><td style="padding:14px 16px;${index < content.rows.length - 1 ? `border-bottom:1px solid ${TOKENS.paper150};` : ''}font-family:${font};font-size:13px;line-height:18px;color:${TOKENS.ink500};text-align:${align};">${e(row.label)}<br><span style="font-size:15px;line-height:22px;font-weight:700;color:${TOKENS.ink950};">${e(row.value)}</span></td></tr>`,
          )
          .join('\n') +
        '</table>';

  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${e(copy.subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${TOKENS.paper50};">
<div style="display:none;max-height:0;overflow:hidden;">${e(copy.intro)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${TOKENS.paper50};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" dir="${dir}" style="max-width:560px;">
<tr><td style="padding:0 4px 16px 4px;text-align:${align};font-family:${font};">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="${align}"><tr>
<td width="28" height="28" align="center" valign="middle" style="background-color:${TOKENS.ink950};border-radius:8px;color:${TOKENS.lime500};font-family:${TOKENS.fontLatin};font-size:15px;font-weight:800;line-height:28px;">T</td>
<td style="padding:0 8px;font-family:${TOKENS.fontLatin};font-size:17px;font-weight:700;color:${TOKENS.ink950};" dir="ltr">TManage</td>
</tr></table>
</td></tr>
<tr><td style="background-color:${TOKENS.paper0};border:1px solid ${TOKENS.paper150};border-radius:16px;padding:32px;text-align:${align};font-family:${font};">
<p style="margin:0 0 12px 0;font-family:${arabic ? font : TOKENS.fontMono};font-size:12px;line-height:17px;letter-spacing:${arabic ? '0' : '0.08em'};text-transform:uppercase;color:${TOKENS.ink500};">${e(copy.eyebrow)}</p>
<h1 style="margin:0 0 12px 0;font-family:${font};font-size:24px;line-height:31px;font-weight:700;color:${TOKENS.ink950};">${e(copy.heading)}</h1>
<p style="margin:0 0 24px 0;font-family:${font};font-size:15px;line-height:22px;color:${TOKENS.ink650};">${e(copy.intro)}</p>
${rows}
<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="${align}" style="margin:28px 0 0 0;"><tr>
<td align="center" bgcolor="${TOKENS.ink950}" style="border-radius:999px;">
<a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 28px;font-family:${font};font-size:15px;line-height:20px;font-weight:700;color:${TOKENS.paper0};text-decoration:none;border-radius:999px;">${e(copy.button)}</a>
</td></tr></table>
<div style="clear:both;height:28px;line-height:28px;font-size:0;">&nbsp;</div>
<p style="margin:0 0 6px 0;font-family:${font};font-size:13px;line-height:18px;color:${TOKENS.ink650};">${e(copy.fallback)}</p>
<p style="margin:0 0 24px 0;font-family:${TOKENS.fontMono};font-size:12px;line-height:17px;word-break:break-all;" dir="ltr"><a href="${href}" target="_blank" rel="noopener" style="color:${TOKENS.ink950};text-decoration:underline;">${href}</a></p>
<p style="margin:0;padding:12px 14px;border:1px dashed ${TOKENS.paper150};border-radius:12px;font-family:${font};font-size:13px;line-height:18px;color:${TOKENS.ink650};">${e(copy.note)}</p>
</td></tr>
<tr><td style="padding:16px 8px 0 8px;font-family:${font};font-size:12px;line-height:17px;color:${TOKENS.ink500};text-align:${align};">${e(copy.footer)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
