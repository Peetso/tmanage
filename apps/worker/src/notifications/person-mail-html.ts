import { MAIL_TOKENS, escapeHtml, signatureRowHtml } from './notice-sign-off.js';

/**
 * The HTML part of a person mail (tip, reminder, feature news) in the existing mail card: the
 * wordmark, the greeting as the heading, the kind's lines, one button, the reply line, then the
 * person's signature block under the card (name and role, the honesty line, the links line).
 * Callers pass plain text; every string is escaped here. The [PERSON] and link tokens pass
 * through untouched (they hold no escapable character) for the resolver and the transport.
 */
export interface PersonMailHtmlContent {
  readonly subject: string;
  readonly heading: string;
  readonly lines: readonly string[];
  readonly button: { readonly label: string; readonly url: string };
  readonly close: string;
  readonly signature: readonly string[];
  readonly arabic: boolean;
}

export function renderPersonMailHtml(content: PersonMailHtmlContent): string {
  const t = MAIL_TOKENS;
  const e = escapeHtml;
  const { arabic } = content;
  const dir = arabic ? 'rtl' : 'ltr';
  const align = arabic ? 'right' : 'left';
  const font = arabic ? t.fontArabic : t.fontLatin;
  const paragraph = (line: string): string =>
    `<p style="margin:0 0 20px 0;font-family:${font};font-size:15px;line-height:22px;color:${t.ink650};">${e(line)}</p>`;
  const lines = content.lines.filter((line) => line !== '').map(paragraph);
  return `<!doctype html>
<html lang="${arabic ? 'ar' : 'en'}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${e(content.subject)}</title>
</head>
<body dir="${dir}" style="margin:0;padding:0;background-color:${t.paper50};">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${t.paper50};">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" dir="${dir}" style="max-width:600px;">
<tr><td style="background-color:${t.paper0};border:1px solid ${t.paper150};border-radius:24px;padding:40px;text-align:${align};font-family:${font};">
<p style="margin:0;padding:0 0 24px 0;border-bottom:1px solid ${t.paper150};font-family:${t.fontLatin};font-size:20px;line-height:28px;font-weight:600;color:${t.ink950};" dir="ltr" align="${align}">TManage</p>
<h1 style="margin:24px 0 16px 0;font-family:${font};font-size:24px;line-height:32px;font-weight:600;color:${t.ink950};">${e(content.heading)}</h1>
${lines.join('\n')}
<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="${align}"><tr>
<td align="center" bgcolor="${t.lime500}" style="border-radius:999px;"><a href="${e(content.button.url)}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 20px;font-family:${font};font-size:14px;line-height:20px;color:${t.ink950};text-decoration:none;border-radius:999px;">${e(content.button.label)}</a></td>
</tr></table>
<div style="clear:both;height:20px;line-height:20px;font-size:0;">&nbsp;</div>
${paragraph(content.close)}
</td></tr>
${signatureRowHtml(content.signature, font, align)}
</table>
</td></tr>
</table>
</body>
</html>`;
}
