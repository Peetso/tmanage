import type { MailMessage } from '@tmanage/mail';
import type { CollaborationEmailFacts } from './collaboration-mailer.js';

/**
 * R4 slice 12 — the proofing viewer's three emails (`review-comment`, `review-mention`,
 * `review-decided`), in English or Arabic by the recipient's locale, studio or portal variant by
 * who receives it.
 *
 * Same card as the designed approval request (wordmark, rule, one heading, one line, one button,
 * the footer under the card) with the colours and families of `packages/ui/src/styles/tokens.css`
 * — the worker cannot import the web's tokens, so the few values are restated here. The copy names
 * who, which file, which comment number and the project, and never quotes what anybody wrote: a
 * reply can be edited or deleted after the email leaves, and an email cannot be taken back.
 *
 * The studio variant's footer points at the recipient's notification settings; the portal variant
 * (a client person) says it was sent on the studio's behalf, and its link opens the portal viewer.
 */

export type ReviewMailKind = 'review_comment' | 'review_mention' | 'review_decided';

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
} as const;

/** U+200F, the right-to-left mark: keeps a mixed Arabic/Latin line anchored right. */
const RLM = '‏';

function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function arabic(locale: string | undefined): boolean {
  return locale !== undefined && /^ar(?:-|$)/iu.test(locale);
}

export interface ReviewEmailCopy {
  readonly subject: string;
  readonly greeting: string;
  readonly line: string;
  readonly button: string;
  readonly footer: string;
}

/** The words of one review email — exported so the suite can read them without the markup. */
export function reviewEmailCopy(
  kind: ReviewMailKind,
  facts: CollaborationEmailFacts,
): ReviewEmailCopy {
  const ar = arabic(facts.locale);
  const studio = oneLine(facts.organizationName);
  const actor = oneLine(facts.actorName ?? facts.organizationName);
  const file = oneLine(facts.subjectTitle);
  const name = oneLine(facts.recipientName);
  const pin = facts.pinNumber;
  const portal = facts.portal === true;

  if (ar) {
    const where = facts.projectName === undefined ? '' : ` في ${oneLine(facts.projectName)}`;
    const which = pin === undefined ? 'تعليقًا' : `التعليق ${pin}`;
    const footer = portal
      ? `${RLM}أُرسلت من TManage نيابةً عن ${studio}`
      : `${RLM}تصلك هذه الرسالة بسبب إعدادات الإشعارات لديك في ${studio} على TManage.`;
    const greeting = `مرحبًا ${name}،`;
    switch (kind) {
      case 'review_comment':
        return {
          subject: `${RLM}علّق ${actor} على ${file}`,
          greeting,
          line: `${RLM}ترك ${actor} ${which} على ${file}${where}.`,
          button: 'فتح التعليق',
          footer,
        };
      case 'review_mention':
        return {
          subject: `${RLM}أشار إليك ${actor} في ${file}`,
          greeting,
          line: `${RLM}أشار إليك ${actor} في ${pin === undefined ? 'تعليق' : which} على ${file}${where}.`,
          button: 'فتح التعليق',
          footer,
        };
      case 'review_decided': {
        const approved = facts.decision === 'approved';
        const said = approved ? `اعتمد ${actor} ${file}` : `طلب ${actor} تعديلات على ${file}`;
        return {
          subject: `${RLM}${said}`,
          greeting,
          line: `${RLM}${said}${where}.`,
          button: 'فتح الملف',
          footer,
        };
      }
    }
  }

  const where = facts.projectName === undefined ? '' : ` in ${oneLine(facts.projectName)}`;
  const which = pin === undefined ? 'a comment' : `comment ${pin}`;
  const footer = portal
    ? `Sent by TManage on behalf of ${studio}`
    : `You are receiving this because of your notification settings in ${studio} on TManage.`;
  const greeting = `Hello ${name},`;
  switch (kind) {
    case 'review_comment':
      return {
        subject: `${actor} commented on ${file}`,
        greeting,
        line: `${actor} left ${which} on ${file}${where}.`,
        button: 'Open the comment',
        footer,
      };
    case 'review_mention':
      return {
        subject: `${actor} mentioned you on ${file}`,
        greeting,
        line: `${actor} mentioned you in ${which} on ${file}${where}.`,
        button: 'Open the comment',
        footer,
      };
    case 'review_decided': {
      const said =
        facts.decision === 'approved'
          ? `${actor} approved ${file}`
          : `${actor} asked for changes on ${file}`;
      return {
        subject: said,
        greeting,
        line: `${said}${where}.`,
        button: 'Open the file',
        footer,
      };
    }
  }
}

function renderHtml(copy: ReviewEmailCopy, link: string, ar: boolean): string {
  const t = TOKENS;
  const e = escapeHtml;
  const dir = ar ? 'rtl' : 'ltr';
  const align = ar ? 'right' : 'left';
  const font = ar ? t.fontArabic : t.fontLatin;
  const href = e(link);
  return `<!doctype html>
<html lang="${ar ? 'ar' : 'en'}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${e(copy.subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${t.paper50};">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${t.paper50};">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" dir="${dir}" style="max-width:600px;">
<tr><td style="background-color:${t.paper0};border:1px solid ${t.paper150};border-radius:24px;padding:40px;text-align:${align};font-family:${font};">
<p style="margin:0;padding:0 0 24px 0;border-bottom:1px solid ${t.paper150};font-family:${t.fontLatin};font-size:20px;line-height:28px;font-weight:600;color:${t.ink950};" dir="ltr" align="${align}">TManage</p>
<p style="margin:24px 0 8px 0;font-family:${font};font-size:15px;line-height:22px;color:${t.ink650};">${e(copy.greeting)}</p>
<h1 style="margin:0 0 16px 0;font-family:${font};font-size:24px;line-height:32px;font-weight:600;color:${t.ink950};">${e(copy.subject)}</h1>
<p style="margin:0 0 24px 0;font-family:${font};font-size:15px;line-height:22px;color:${t.ink650};">${e(copy.line)}</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="${align}"><tr>
<td align="center" bgcolor="${t.lime500}" style="border-radius:999px;"><a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 20px;font-family:${font};font-size:14px;line-height:20px;color:${t.ink950};text-decoration:none;border-radius:999px;">${e(copy.button)}</a></td>
</tr></table>
<div style="clear:both;height:4px;line-height:4px;font-size:0;">&nbsp;</div>
</td></tr>
<tr><td align="center" style="padding:20px 8px 0 8px;font-family:${font};font-size:12px;line-height:18px;color:${t.ink500};">${e(copy.footer)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function composeReviewEmail(
  kind: ReviewMailKind,
  facts: CollaborationEmailFacts,
): MailMessage {
  const copy = reviewEmailCopy(kind, facts);
  const ar = arabic(facts.locale);
  return {
    to: facts.recipientEmail,
    subject: copy.subject,
    text: [copy.greeting, copy.line, `${copy.button}: ${facts.link}`, copy.footer].join('\n\n'),
    html: renderHtml(copy, facts.link, ar),
  };
}
