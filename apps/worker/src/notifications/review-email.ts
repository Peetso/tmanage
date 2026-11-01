import type { MailMessage } from '@tmanage/mail';
import type { CollaborationEmailFacts } from './collaboration-mailer.js';

/**
 * R4 slice 12 — the proofing viewer's four emails (`review-comment`, `review-reply`,
 * `review-mention`, `review-decided`), in English or Arabic by the recipient's locale, studio or
 * portal variant by who receives it.
 *
 * Drawn in Figma as R4 Batch F (V-51, section "R4 Batch F — review notices" on the Product page),
 * in the security notice's layout (`security-notice-html.ts`): the wordmark above the card, a mono
 * "File review" eyebrow, one heading, one line, a panel of facts (file, comment number, project),
 * one lime button, and the footer under the card. The worker cannot import the web's tokens, so
 * the few values are restated here. The copy names who, which file, which comment number and the
 * project, and never quotes what anybody wrote: a reply can be edited or deleted after the email
 * leaves, and an email cannot be taken back.
 *
 * The studio variant's footer points at the recipient's notification settings; the portal variant
 * (a client person) says it was sent on the studio's behalf, and its link opens the portal viewer.
 */

export type ReviewMailKind =
  'review_comment' | 'review_reply' | 'review_mention' | 'review_decided';

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
  fontMono: "'Geist Mono', ui-monospace, Menlo, Consolas, monospace",
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

export interface ReviewEmailFact {
  readonly label: string;
  readonly value: string;
}

export interface ReviewEmailCopy {
  readonly subject: string;
  /** The plain-text body's first line only; the designed HTML card has no greeting. */
  readonly greeting: string;
  readonly eyebrow: string;
  readonly line: string;
  /** File, comment number (when there is one) and project, in that order. */
  readonly facts: readonly ReviewEmailFact[];
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
  const project = facts.projectName === undefined ? undefined : oneLine(facts.projectName);
  const factRows = (labels: {
    file: string;
    comment: string;
    project: string;
  }): ReviewEmailFact[] => [
    { label: labels.file, value: file },
    ...(pin === undefined || kind === 'review_decided'
      ? []
      : [{ label: labels.comment, value: String(pin) }]),
    ...(project === undefined ? [] : [{ label: labels.project, value: project }]),
  ];

  if (ar) {
    const where = project === undefined ? '' : ` في ${project}`;
    const which = pin === undefined ? 'تعليقًا' : `التعليق ${pin}`;
    const footer = portal
      ? `${RLM}أُرسلت من TManage نيابةً عن ${studio}`
      : `${RLM}تصلك هذه الرسالة بسبب إعدادات الإشعارات لديك في ${studio} على TManage.`;
    const base = {
      greeting: `مرحبًا ${name}،`,
      eyebrow: 'مراجعة ملف',
      facts: factRows({ file: 'الملف', comment: 'التعليق', project: 'المشروع' }),
      footer,
    };
    switch (kind) {
      case 'review_comment':
        return {
          ...base,
          subject: `${RLM}علّق ${actor} على ${file}`,
          line: `${RLM}ترك ${actor} ${which} على ${file}${where}.`,
          button: 'فتح التعليق',
        };
      case 'review_reply':
        return {
          ...base,
          subject: `${RLM}ردّ ${actor} على ${file}`,
          line: `${RLM}ردّ ${actor} على ${pin === undefined ? 'تعليق' : which} على ${file}${where}.`,
          button: 'فتح التعليق',
        };
      case 'review_mention':
        return {
          ...base,
          subject: `${RLM}أشار إليك ${actor} في ${file}`,
          line: `${RLM}أشار إليك ${actor} في ${pin === undefined ? 'تعليق' : which} على ${file}${where}.`,
          button: 'فتح التعليق',
        };
      case 'review_decided': {
        const approved = facts.decision === 'approved';
        const said = approved ? `اعتمد ${actor} ${file}` : `طلب ${actor} تعديلات على ${file}`;
        return {
          ...base,
          subject: `${RLM}${said}`,
          line: `${RLM}${said}${where}.`,
          button: 'فتح الملف',
        };
      }
    }
  }

  const where = project === undefined ? '' : ` in ${project}`;
  const which = pin === undefined ? 'a comment' : `comment ${pin}`;
  const footer = portal
    ? `Sent by TManage on behalf of ${studio}`
    : `You are receiving this because of your notification settings in ${studio} on TManage.`;
  const base = {
    greeting: `Hello ${name},`,
    eyebrow: 'File review',
    facts: factRows({ file: 'File', comment: 'Comment', project: 'Project' }),
    footer,
  };
  switch (kind) {
    case 'review_comment':
      return {
        ...base,
        subject: `${actor} commented on ${file}`,
        line: `${actor} left ${which} on ${file}${where}.`,
        button: 'Open the comment',
      };
    case 'review_reply':
      return {
        ...base,
        subject: `${actor} replied on ${file}`,
        line: `${actor} replied to ${which} on ${file}${where}.`,
        button: 'Open the comment',
      };
    case 'review_mention':
      return {
        ...base,
        subject: `${actor} mentioned you on ${file}`,
        line: `${actor} mentioned you in ${which} on ${file}${where}.`,
        button: 'Open the comment',
      };
    case 'review_decided': {
      const said =
        facts.decision === 'approved'
          ? `${actor} approved ${file}`
          : `${actor} asked for changes on ${file}`;
      return {
        ...base,
        subject: said,
        line: `${said}${where}.`,
        button: 'Open the file',
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
  const facts = copy.facts
    .map(
      (fact, index) =>
        `<tr><td style="padding:14px 16px;${index < copy.facts.length - 1 ? `border-bottom:1px solid ${t.paper150};` : ''}text-align:${align};font-family:${font};font-size:12px;line-height:17px;color:${t.ink500};">${e(fact.label)}<br><span style="font-family:${t.fontLatin};font-size:14px;line-height:20px;font-weight:600;color:${t.ink950};" dir="ltr">${e(fact.value)}</span></td></tr>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="${ar ? 'ar' : 'en'}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${e(copy.subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${t.paper50};">
<div style="display:none;max-height:0;overflow:hidden;">${e(copy.line)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${t.paper50};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" dir="${dir}" style="max-width:560px;">
<tr><td style="padding:0 4px 16px 4px;font-family:${t.fontLatin};">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="${align}" dir="ltr"><tr>
${ar ? '' : `<td width="28" height="28" align="center" valign="middle" style="background-color:${t.ink950};border-radius:8px;color:${t.lime500};font-family:${t.fontLatin};font-size:15px;font-weight:800;line-height:28px;">T</td>\n`}<td style="padding:0 8px;font-family:${t.fontLatin};font-size:17px;font-weight:700;color:${t.ink950};">TManage</td>${ar ? `\n<td width="28" height="28" align="center" valign="middle" style="background-color:${t.ink950};border-radius:8px;color:${t.lime500};font-family:${t.fontLatin};font-size:15px;font-weight:800;line-height:28px;">T</td>` : ''}
</tr></table>
</td></tr>
<tr><td style="background-color:${t.paper0};border:1px solid ${t.paper150};border-radius:16px;padding:32px;text-align:${align};font-family:${font};">
<p style="margin:0 0 12px 0;font-family:${ar ? font : t.fontMono};font-size:12px;line-height:17px;letter-spacing:${ar ? '0' : '0.08em'};text-transform:uppercase;color:${t.ink500};">${e(copy.eyebrow)}</p>
<h1 style="margin:0 0 12px 0;font-family:${font};font-size:24px;line-height:31px;font-weight:600;color:${t.ink950};">${e(copy.subject)}</h1>
<p style="margin:0 0 24px 0;font-family:${font};font-size:15px;line-height:22px;color:${t.ink650};">${e(copy.line)}</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${t.paper50};border-radius:12px;">
${facts}
</table>
<div style="height:24px;line-height:24px;font-size:0;">&nbsp;</div>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="${align}"><tr>
<td align="center" bgcolor="${t.lime500}" style="border-radius:999px;"><a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 20px;font-family:${font};font-size:14px;line-height:20px;color:${t.ink950};text-decoration:none;border-radius:999px;">${e(copy.button)}</a></td>
</tr></table>
<div style="clear:both;height:4px;line-height:4px;font-size:0;">&nbsp;</div>
</td></tr>
<tr><td style="padding:16px 8px 0 8px;text-align:${align};font-family:${font};font-size:12px;line-height:17px;color:${t.ink500};">${e(copy.footer)}</td></tr>
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
