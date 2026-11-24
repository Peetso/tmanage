import { anchored, greeting as greetingLine } from './sign-off.js';
import type { MailLanguage } from './sender.js';

/**
 * MAILDESIGN (2026-11-24) — the ONE designed HTML layout TManage mail is drawn in, and the helper
 * that gives a mail its two parts (text/plain and HTML) from the same lines.
 *
 * Before this file the layout lived in `apps/api/src/common/email/action-email.ts`, the worker
 * repeated it (`security-notice-html.ts`) because it cannot import the API, the MFA code mail had a
 * third copy, and the mails none of them reached went out as bare text (defect class DC-10). It now
 * lives in the package both apps already share for sending, so a producer in either app draws the
 * same card; `action-email.ts` re-exports it.
 *
 * Table-based so Gmail and Outlook draw it the same way; every colour and type family is a value
 * from `packages/ui/src/styles/tokens.css` (ink, paper, lime; Manrope / Alexandria / Geist Mono).
 * The wordmark above the card, an optional mono eyebrow, the heading, then the blocks: paragraphs,
 * a label/value panel, a one-time code, and buttons whose `href` is exactly the URL printed under
 * them (the visible link and the clicked one never differ). The dashed note ends the card; the
 * sign-off block and the footer sit under it. Every string is HTML-escaped here; callers pass plain
 * text. Arabic switches to `dir="rtl"`, right alignment and the Arabic family.
 *
 * The link and signature tokens of `sign-off.ts` hold no escapable character, so they pass through
 * for the sender resolver and the notification transport to fill.
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

const T = EMAIL_TOKENS;

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const RLM = String.fromCodePoint(0x20_0f);

/** U+200F marks anchor Arabic plain text; the HTML is already `dir="rtl"`, so they are dropped. */
function unmarked(value: string): string {
  return value.replaceAll(RLM, '');
}

export interface MailRow {
  readonly label: string;
  readonly value: string;
}

/** One block of the card, in reading order. */
export type MailBlock =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'rows'; readonly rows: readonly MailRow[] }
  | { readonly kind: 'code'; readonly code: string }
  | {
      readonly kind: 'button';
      readonly label: string;
      /** Built from configuration by the caller, never from a request. */
      readonly link: string;
      /** "Button not working? Copy this link…"; the URL is printed under it. */
      readonly fallback: string;
    };

export interface MailLayoutContent {
  readonly arabic: boolean;
  /** The document title. */
  readonly subject: string;
  /** The preview line a mail app shows after the subject. */
  readonly preheader: string;
  /** The small mono line over the heading; omitted when absent. */
  readonly eyebrow?: string;
  readonly heading: string;
  readonly blocks: readonly MailBlock[];
  /** The dashed note at the end of the card (an expiry, what to do if it was not you). */
  readonly note?: string;
  /** The sign-off lines (`signOff` / `workspaceSignOff`), drawn under the card. */
  readonly signature?: readonly string[];
  /** Under the card: why this person received the message. */
  readonly footer?: string;
}

/**
 * The signature block under the card: the first line (who signs) in ink, the rest (the honesty
 * or help line, the settings and unsubscribe links) small. One paragraph per line, so the resolver
 * can drop a links line the notification transport did not fill.
 */
export function signatureRow(
  lines: readonly string[] | undefined,
  font: string,
  align: 'left' | 'right',
): string {
  if (lines === undefined || lines.length === 0) return '';
  const e = escapeHtml;
  const body = lines
    .filter((line) => line !== '')
    .map((line, index) =>
      index === 0
        ? `<p style="margin:0 0 4px 0;font-family:${font};font-size:14px;line-height:20px;font-weight:700;color:${T.ink950};">${e(unmarked(line))}</p>`
        : `<p style="margin:0 0 4px 0;font-family:${font};font-size:12px;line-height:17px;color:${T.ink650};">${e(unmarked(line))}</p>`,
    )
    .join('\n');
  // dir on the cell itself: a client that drops the outer dir still keeps the footer's order.
  const dir = align === 'right' ? 'rtl' : 'ltr';
  return `<tr><td dir="${dir}" style="padding:20px 8px 0 8px;text-align:${align};">
${body}
</td></tr>`;
}

function block(item: MailBlock, font: string, align: 'left' | 'right'): string {
  const e = escapeHtml;
  switch (item.kind) {
    case 'text':
      return `<p style="margin:0 0 16px 0;font-family:${font};font-size:15px;line-height:22px;color:${T.ink650};white-space:pre-line;">${e(unmarked(item.text))}</p>`;
    case 'rows':
      if (item.rows.length === 0) return '';
      return (
        `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 24px 0;background-color:${T.paper50};border-radius:12px;">` +
        item.rows
          .map(
            (row, index) =>
              `<tr><td style="padding:14px 16px;${index < item.rows.length - 1 ? `border-bottom:1px solid ${T.paper150};` : ''}font-family:${font};font-size:13px;line-height:18px;color:${T.ink500};text-align:${align};">${e(unmarked(row.label))}<br><span style="font-size:15px;line-height:22px;font-weight:700;color:${T.ink950};">${e(unmarked(row.value))}</span></td></tr>`,
          )
          .join('\n') +
        '</table>'
      );
    case 'code':
      return `<p style="margin:8px 0 24px 0;padding:16px;background-color:${T.paper50};border-radius:12px;text-align:center;font-family:${T.fontMono};font-size:32px;line-height:40px;font-weight:700;letter-spacing:0.3em;color:${T.ink950};" dir="ltr">${e(item.code)}</p>`;
    case 'button': {
      const href = e(item.link);
      return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="${align}" style="margin:12px 0 0 0;"><tr>
<td align="center" bgcolor="${T.ink950}" style="border-radius:999px;">
<a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 28px;font-family:${font};font-size:15px;line-height:20px;font-weight:700;color:${T.paper0};text-decoration:none;border-radius:999px;">${e(unmarked(item.label))}</a>
</td></tr></table>
<div style="clear:both;height:24px;line-height:24px;font-size:0;">&nbsp;</div>
<p style="margin:0 0 6px 0;font-family:${font};font-size:13px;line-height:18px;color:${T.ink650};">${e(unmarked(item.fallback))}</p>
<p style="margin:0 0 24px 0;font-family:${T.fontMono};font-size:12px;line-height:17px;word-break:break-all;" dir="ltr"><a href="${href}" target="_blank" rel="noopener" style="color:${T.ink950};text-decoration:underline;">${href}</a></p>`;
    }
  }
}

/** The designed HTML document. */
export function renderMailLayout(content: MailLayoutContent): string {
  const { arabic } = content;
  const dir = arabic ? 'rtl' : 'ltr';
  const lang = arabic ? 'ar' : 'en';
  const align = arabic ? 'right' : 'left';
  const font = arabic ? T.fontArabic : T.fontLatin;
  const e = escapeHtml;
  const eyebrow =
    content.eyebrow === undefined || content.eyebrow === ''
      ? ''
      : `<p style="margin:0 0 12px 0;font-family:${arabic ? font : T.fontMono};font-size:12px;line-height:17px;letter-spacing:${arabic ? '0' : '0.08em'};text-transform:uppercase;color:${T.ink500};">${e(unmarked(content.eyebrow))}</p>\n`;
  const blocks = content.blocks
    .map((item) => block(item, font, align))
    .filter((html) => html !== '')
    .join('\n');
  const note =
    content.note === undefined || content.note === ''
      ? ''
      : `\n<p style="margin:8px 0 0 0;padding:12px 14px;border:1px dashed ${T.paper150};border-radius:12px;font-family:${font};font-size:13px;line-height:18px;color:${T.ink650};">${e(unmarked(content.note))}</p>`;
  const footer =
    content.footer === undefined || content.footer === ''
      ? ''
      : `\n<tr><td style="padding:16px 8px 0 8px;font-family:${font};font-size:12px;line-height:17px;color:${T.ink500};text-align:${align};">${e(unmarked(content.footer))}</td></tr>`;

  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${e(unmarked(content.subject))}</title>
</head>
<body dir="${dir}" style="margin:0;padding:0;background-color:${T.paper50};">
<div style="display:none;max-height:0;overflow:hidden;">${e(unmarked(content.preheader))}</div>
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
${eyebrow}<h1 style="margin:0 0 16px 0;font-family:${font};font-size:24px;line-height:31px;font-weight:700;color:${T.ink950};">${e(unmarked(content.heading))}</h1>
${blocks}${note}
</td></tr>
${signatureRow(content.signature, font, align)}${footer}
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** The marker every mail drawn by {@link renderMailLayout} carries (tests and the audit use it). */
export const MAIL_LAYOUT_MARK = 'dir="ltr">TManage</td>';

// ---- the two parts of a mail from one set of lines ----

/** A line that is a link: "{label}: {link}" in text, a button (and the printed URL) in HTML. */
export interface MailActionLine {
  readonly label: string;
  readonly link: string;
}

/** A line that carries a one-time code: `text` in both parts, plus the code drawn large in HTML. */
export interface MailCodeLine {
  readonly code: string;
  readonly text: string;
}

/** Label/value facts: "{label}: {value}" lines in text, the facts panel in HTML. */
export interface MailRowsLine {
  readonly rows: readonly MailRow[];
}

/** A body line. An empty string is dropped, so an optional sentence can be passed as `''`. */
export type MailLine = string | MailActionLine | MailCodeLine | MailRowsLine;

const FALLBACK: Record<MailLanguage, string> = {
  en: 'Button not working? Copy this link into your browser:',
  ar: 'الزر لا يعمل؟ انسخ هذا الرابط وافتحه في المتصفح:',
};

/** The eyebrow words of the layout, by what the mail is about (English and Arabic). */
const EYEBROWS = {
  security: { en: 'Security', ar: 'الأمان' },
  notification: { en: 'Notification', ar: 'إشعار' },
  support: { en: 'TManage Support', ar: 'دعم TManage' },
  account: { en: 'Your account', ar: 'حسابك' },
  operations: { en: 'Operations', ar: 'التشغيل' },
} as const;

export type MailEyebrow = keyof typeof EYEBROWS;

export function mailEyebrow(kind: MailEyebrow, language: MailLanguage): string {
  return EYEBROWS[kind][language];
}

export interface DesignedMailInput {
  readonly language: MailLanguage;
  /** The subject: the HTML title, and the heading when there is no greeting. */
  readonly subject: string;
  /** The eyebrow: {@link mailEyebrow}, or the workspace name on agency mail. */
  readonly eyebrow?: string;
  /** The first paragraph of the text part; the heading of the HTML part. */
  readonly greeting?: string;
  readonly lines: readonly MailLine[];
  /** The sign-off block: one text paragraph after the lines; under the card in HTML. */
  readonly signature: readonly string[];
  /** Text paragraphs after the sign-off; the small footer under the card in HTML. */
  readonly after?: readonly string[];
  /** The preview line; the first body sentence by default. */
  readonly preheader?: string;
}

function isAction(line: MailLine): line is MailActionLine {
  return typeof line === 'object' && 'link' in line;
}

function isCode(line: MailLine): line is MailCodeLine {
  return typeof line === 'object' && 'code' in line;
}

function lineText(line: MailLine): string {
  if (typeof line === 'string') return line;
  if (isAction(line)) return `${line.label}: ${line.link}`;
  if (isCode(line)) return line.text;
  return line.rows.map((row) => `${row.label}: ${row.value}`).join('\n');
}

function present(line: MailLine): boolean {
  if (typeof line === 'string') return line !== '';
  if (isAction(line) || isCode(line)) return true;
  return line.rows.length > 0;
}

function blocksOf(lines: readonly MailLine[], language: MailLanguage): MailBlock[] {
  const blocks: MailBlock[] = [];
  for (const line of lines) {
    if (typeof line === 'string') blocks.push({ kind: 'text', text: line });
    else if (isAction(line)) {
      blocks.push({
        kind: 'button',
        label: line.label,
        link: line.link,
        fallback: FALLBACK[language],
      });
    } else if (isCode(line)) {
      blocks.push({ kind: 'text', text: line.text }, { kind: 'code', code: line.code });
    } else blocks.push({ kind: 'rows', rows: line.rows });
  }
  return blocks;
}

/**
 * The text/plain and HTML parts of one mail from the same lines. The text part is the paragraphs
 * joined by blank lines (greeting, lines, the sign-off block, `after`), exactly as the producers
 * wrote it before the layout; the HTML part is {@link renderMailLayout}. Lines are used as given (a
 * producer that anchors Arabic lines passes them anchored); {@link designedPlainMail} anchors.
 */
export function designedMail(input: DesignedMailInput): { text: string; html: string } {
  const lines = input.lines.filter(present);
  const text = [
    ...(input.greeting === undefined ? [] : [input.greeting]),
    ...lines.map(lineText),
    ...(input.signature.length === 0 ? [] : [input.signature.join('\n')]),
    ...(input.after ?? []),
  ].join('\n\n');
  const first = lines.find((line): line is string => typeof line === 'string');
  const after = input.after ?? [];
  const html = renderMailLayout({
    arabic: input.language === 'ar',
    subject: input.subject,
    preheader: input.preheader ?? first ?? input.subject,
    ...(input.eyebrow === undefined ? {} : { eyebrow: input.eyebrow }),
    heading: input.greeting ?? input.subject,
    blocks: blocksOf(lines, input.language),
    signature: input.signature,
    ...(after.length === 0 ? {} : { footer: after.join(' ') }),
  });
  return { text, html };
}

/**
 * `plainMailText`'s frame with the designed HTML beside it: the greeting ("Hi {first}," or
 * "Hello,"), each line anchored right in Arabic, then the sign-off. The text part is byte for byte
 * what `plainMailText` gives for the same lines.
 */
export function designedPlainMail(
  language: MailLanguage,
  body: {
    readonly subject: string;
    readonly eyebrow?: string;
    readonly name?: string;
    readonly lines: readonly MailLine[];
    readonly signature: readonly string[];
    readonly preheader?: string;
  },
): { text: string; html: string } {
  const anchor = (line: MailLine): MailLine => {
    if (typeof line === 'string') return line === '' ? line : anchored(language, line);
    if (isAction(line)) return { label: anchored(language, line.label), link: line.link };
    if (isCode(line)) return { code: line.code, text: anchored(language, line.text) };
    return line;
  };
  return designedMail({
    language,
    subject: body.subject,
    ...(body.eyebrow === undefined ? {} : { eyebrow: body.eyebrow }),
    greeting: anchored(language, greetingLine(language, body.name)),
    lines: body.lines.map(anchor),
    signature: body.signature,
    ...(body.preheader === undefined ? {} : { preheader: body.preheader }),
  });
}

/**
 * An internal report (operator alerts, the security digest, the growth report) in the layout: the
 * text part's first line is the heading, each blank-line group after it one paragraph (line breaks
 * kept), so the HTML says exactly what the text says. English, for the operator's inbox.
 */
export function renderTextReport(subject: string, text: string): string {
  const groups = text.split(/\n{2,}/u);
  const [head = subject, ...restOfHead] = (groups[0] ?? subject).split('\n');
  const rest = [restOfHead.join('\n'), ...groups.slice(1)].filter((group) => group.trim() !== '');
  return renderMailLayout({
    arabic: false,
    subject,
    preheader: head,
    eyebrow: mailEyebrow('operations', 'en'),
    heading: head,
    blocks: rest.map((group) => ({ kind: 'text', text: group })),
  });
}
