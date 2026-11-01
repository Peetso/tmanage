import type { Mailer, MailMessage } from '@tmanage/mail';
import { composeReviewEmail } from './review-email.js';

/**
 * CQ-12 — the collaboration emails (COL-05) and the client-action email (APR-03), on the same
 * `@tmanage/mail` port and in the same shape as the other relay mailers: composed from facts the
 * consumer re-read at delivery, sent after the batch commits, and `deliver` never throws.
 *
 * The copy names who did what and where, and links to the one screen that shows it. It never
 * quotes what anybody wrote: a message or a comment can be moderated or edited after the email
 * leaves, and an email cannot be taken back.
 */

export type CollaborationMailKind =
  | 'mention'
  | 'comment'
  | 'meeting_invite'
  | 'meeting_changed'
  | 'project_added'
  | 'client_action'
  | 'approval_requested'
  | 'request_message'
  | 'approval_decided'
  // R4 slice 12 — the proofing viewer: a comment, a mention, a decision on a file under review.
  | 'review_comment'
  | 'review_mention'
  | 'review_decided';

export interface CollaborationEmailFacts {
  readonly recipientEmail: string;
  readonly recipientName: string;
  /** The studio's name — the organization the recipient belongs to or works with. */
  readonly organizationName: string;
  /** Who did it — absent for the client-action email, which comes from the studio. */
  readonly actorName?: string;
  /** What it is about: a channel or document name, a meeting, a project, a work item title. */
  readonly subjectTitle: string;
  /** The project, when the subject is not the project itself. */
  readonly projectName?: string;
  /** Meeting start, already a readable UTC string. */
  readonly when?: string;
  /** The absolute link to the screen that shows it. */
  readonly link: string;
  /**
   * NT1 — the recipient's `users.locale`. `approval_requested` and `request_message` are written
   * in Arabic for an `ar*` locale and in English otherwise; the older kinds are English-only yet.
   */
  readonly locale?: string;
  /** t8-b — `approval_requested` only: the version number sent for approval. */
  readonly versionNumber?: number;
  /** t8-b — `approval_requested` only: the decide-by date, already a readable string. */
  readonly dueDate?: string;
  /** t8-b — `approval_requested` only: what the reviewer should check, as the sender wrote it. */
  readonly checkNote?: string;
  /** Q3 — `approval_decided` only: what the client decided. R4: also `review_decided`. */
  readonly decision?: 'approved' | 'changes_requested';
  /** R4 — `review_comment` / `review_mention`: the comment's number on the file. */
  readonly pinNumber?: number;
  /** R4 — the recipient is a client person: the link is the portal's, the footer the studio's. */
  readonly portal?: boolean;
}

/** Whether a BCP-47 locale asks for Arabic copy. */
export function isArabicLocale(locale: string | undefined): boolean {
  return locale !== undefined && /^ar(?:-|$)/iu.test(locale);
}

/** Flattened before it reaches a header or a line: these are strings people typed. */
function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

function inProject(facts: CollaborationEmailFacts): string {
  return facts.projectName === undefined ? '' : ` in ${oneLine(facts.projectName)}`;
}

/**
 * NT1 — `request_message` in Arabic. Same facts, same lines, same link; never what anybody wrote.
 * (`approval_requested` has its own designed composer in `approval-email` below.)
 */
function composeArabicRequestMessage(facts: CollaborationEmailFacts): MailMessage {
  const name = oneLine(facts.recipientName);
  const actor = oneLine(facts.actorName ?? facts.organizationName);
  const title = oneLine(facts.subjectTitle);
  const studio = oneLine(facts.organizationName);
  const where = facts.projectName === undefined ? '' : ` في ${oneLine(facts.projectName)}`;
  const subject = `رسالة جديدة على ${title}`;
  const middle = `نشر ${actor} رسالة جديدة على الطلب ${title}${where}.`;
  return {
    to: facts.recipientEmail,
    subject,
    text: [
      `مرحبًا ${name}،`,
      middle,
      `افتحه من هنا: ${facts.link}`,
      `تصلك هذه الرسالة بسبب إعدادات الإشعارات لديك في ${studio} على TManage.`,
    ].join('\n\n'),
  };
}

/**
 * t8-b — the designed approval request (Figma 371:1786 English, 371:2214 Arabic): wordmark, rule,
 * who sent it and the project, "Your approval is needed: <title>, version N", the decide-by date
 * and what to check, the portal buttons, and "Sent by TManage on behalf of …" under the card.
 * Colours and families are `packages/ui/src/styles/tokens.css` values (the worker cannot import
 * the api's `action-email`). Both buttons open the same portal screen, where the decision is made.
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
} as const;

/** U+200F, the right-to-left mark: keeps a mixed Arabic/Latin line anchored right. */
const RLM = '‏';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function initialsOf(name: string): string {
  const words = name.split(' ').filter(Boolean);
  const first = words[0] ?? '';
  if (/^\p{Script=Arabic}/u.test(first)) return [...first][0] ?? '';
  return words
    .slice(0, 2)
    .map((word) => [...word][0] ?? '')
    .join('')
    .toUpperCase();
}

interface ApprovalCopy {
  readonly subject: string;
  readonly sender: string;
  readonly project: string;
  readonly body: string;
  readonly approve: string;
  readonly change: string;
  readonly note: string;
  readonly footer: string;
}

function approvalCopy(facts: CollaborationEmailFacts, arabic: boolean): ApprovalCopy {
  const studio = oneLine(facts.organizationName);
  const actor = facts.actorName === undefined ? null : oneLine(facts.actorName);
  const title = oneLine(facts.subjectTitle);
  const project = facts.projectName === undefined ? '' : oneLine(facts.projectName);
  const due = facts.dueDate === undefined ? null : oneLine(facts.dueDate);
  const check = facts.checkNote === undefined ? '' : oneLine(facts.checkNote);
  const version = facts.versionNumber;
  const sender = actor === null || actor === studio ? studio : `${actor} · ${studio}`;
  if (arabic) {
    return {
      subject: `${RLM}مطلوب اعتمادك: ${title}${version === undefined ? '' : `، الإصدار ${version}`}`,
      sender: `${RLM}${sender}`,
      project,
      body: [due === null ? '' : `يُرجى اتخاذ القرار قبل ${due}.`, check].filter(Boolean).join(' '),
      approve: 'المراجعة والاعتماد',
      change: 'طلب تعديلات',
      note: 'يُسجَّل قرارك على هذا الإصدار تحديدًا.',
      footer: `${RLM}أُرسلت من TManage نيابةً عن ${studio}`,
    };
  }
  return {
    subject: `Your approval is needed: ${title}${version === undefined ? '' : `, version ${version}`}`,
    sender,
    project,
    body: [due === null ? '' : `Please decide by ${due}.`, check].filter(Boolean).join(' '),
    approve: 'Review and approve',
    change: 'Request changes',
    note: 'Your decision is recorded against this exact version.',
    footer: `Sent by TManage on behalf of ${studio}`,
  };
}

function renderApprovalHtml(
  copy: ApprovalCopy,
  initials: string,
  link: string,
  arabic: boolean,
): string {
  const t = TOKENS;
  const e = escapeHtml;
  const dir = arabic ? 'rtl' : 'ltr';
  const align = arabic ? 'right' : 'left';
  const font = arabic ? t.fontArabic : t.fontLatin;
  const href = e(link);
  const body =
    copy.body === ''
      ? ''
      : `<p style="margin:0 0 20px 0;font-family:${font};font-size:15px;line-height:22px;color:${t.ink650};">${e(copy.body)}</p>`;
  const project =
    copy.project === ''
      ? ''
      : `<br><span style="font-size:12px;line-height:18px;color:${t.ink500};">${e(copy.project)}</span>`;
  const button = (label: string, primary: boolean): string =>
    `<td align="center" bgcolor="${primary ? t.lime500 : t.paper0}" style="border-radius:999px;${primary ? '' : `border:1px solid ${t.ink650};`}">` +
    `<a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 20px;font-family:${font};font-size:14px;line-height:20px;color:${t.ink950};text-decoration:none;border-radius:999px;">${e(label)}</a></td>`;
  return `<!doctype html>
<html lang="${arabic ? 'ar' : 'en'}" dir="${dir}">
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
<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="${align}" style="margin:20px 0 0 0;"><tr>
<td width="40" height="40" align="center" valign="middle" style="background-color:${t.paper150};border-radius:999px;font-family:${font};font-size:14px;line-height:40px;color:${t.ink650};">${e(initials)}</td>
<td style="padding:0 12px;font-family:${font};text-align:${align};"><span style="font-size:14px;line-height:20px;color:${t.ink950};">${e(copy.sender)}</span>${project}</td>
</tr></table>
<div style="clear:both;height:20px;line-height:20px;font-size:0;">&nbsp;</div>
<h1 style="margin:0 0 16px 0;font-family:${font};font-size:24px;line-height:32px;font-weight:600;color:${t.ink950};">${e(copy.subject)}</h1>
${body}
<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="${align}"><tr>
${button(copy.approve, true)}<td width="12" style="font-size:0;">&nbsp;</td>${button(copy.change, false)}
</tr></table>
<div style="clear:both;height:20px;line-height:20px;font-size:0;">&nbsp;</div>
<p style="margin:0;font-family:${font};font-size:12px;line-height:18px;color:${t.ink500};">${e(copy.note)}</p>
</td></tr>
<tr><td align="center" style="padding:20px 8px 0 8px;font-family:${font};font-size:12px;line-height:18px;color:${t.ink500};">${e(copy.footer)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** t8-b, English or Arabic by the recipient's locale (any other locale reads English). */
export function composeApprovalRequestedEmail(facts: CollaborationEmailFacts): MailMessage {
  const arabic = isArabicLocale(facts.locale);
  const copy = approvalCopy(facts, arabic);
  const who = oneLine(facts.actorName ?? facts.organizationName);
  return {
    to: facts.recipientEmail,
    subject: copy.subject,
    text: [
      copy.subject,
      [copy.sender, copy.project].filter(Boolean).join(' — '),
      copy.body,
      `${copy.approve} / ${copy.change}: ${facts.link}`,
      copy.note,
      copy.footer,
    ]
      .filter(Boolean)
      .join('\n\n'),
    html: renderApprovalHtml(copy, initialsOf(who), facts.link, arabic),
  };
}

/**
 * Q3 — `approval_decided`, English or Arabic by the recipient's locale: "<who> approved / requested
 * changes on a deliverable in <project>", and the link to the deliverable. Never the feedback text:
 * the deliverable page shows it to people who may read it.
 */
export function composeApprovalDecidedEmail(facts: CollaborationEmailFacts): MailMessage {
  const name = oneLine(facts.recipientName);
  const actor = oneLine(facts.actorName ?? facts.organizationName);
  const project = oneLine(facts.projectName ?? facts.subjectTitle);
  const studio = oneLine(facts.organizationName);
  const approved = facts.decision === 'approved';
  if (isArabicLocale(facts.locale)) {
    const line = approved
      ? `اعتمد ${actor} تسليمًا في ${project}`
      : `طلب ${actor} تعديلات على تسليم في ${project}`;
    return {
      to: facts.recipientEmail,
      subject: `${RLM}${line}`,
      text: [
        `مرحبًا ${name}،`,
        `${RLM}${line}.`,
        `افتحه من هنا: ${facts.link}`,
        `${RLM}تصلك هذه الرسالة بسبب إعدادات الإشعارات لديك في ${studio} على TManage.`,
      ].join('\n\n'),
    };
  }
  const subject = approved
    ? `${actor} approved a deliverable in ${project}`
    : `${actor} requested changes on a deliverable in ${project}`;
  return {
    to: facts.recipientEmail,
    subject,
    text: [
      `Hello ${name},`,
      `${subject}.`,
      `Open it here: ${facts.link}`,
      `You are receiving this because of your notification settings in ${studio} on TManage.`,
    ].join('\n\n'),
  };
}

/**
 * BK5 — the meeting invite and the "meeting changed" notice in Arabic, for an `ar*` locale. Same
 * facts, same link; the time is the readable UTC string, kept left-to-right inside the line.
 */
function composeArabicMeetingEmail(
  kind: 'meeting_invite' | 'meeting_changed',
  facts: CollaborationEmailFacts,
): MailMessage {
  const name = oneLine(facts.recipientName);
  const actor = oneLine(facts.actorName ?? facts.organizationName);
  const title = oneLine(facts.subjectTitle);
  const studio = oneLine(facts.organizationName);
  const where = facts.projectName === undefined ? '' : ` في ${oneLine(facts.projectName)}`;
  const when = facts.when === undefined ? '' : `، في ${facts.when}`;
  const subject =
    kind === 'meeting_invite' ? `${RLM}دعاك ${actor} إلى ${title}` : `${RLM}تغيّر موعد ${title}`;
  const middle =
    kind === 'meeting_invite'
      ? `${RLM}دعاك ${actor} إلى الاجتماع ${title}${where}${when}. يمكنك القبول أو الاعتذار من صفحة الاجتماع.`
      : `${RLM}عدّل ${actor} الاجتماع ${title}${where}. الموعد الآن${when === '' ? '' : `: ${facts.when}`}.`;
  return {
    to: facts.recipientEmail,
    subject,
    text: [
      `مرحبًا ${name}،`,
      middle,
      `افتحه من هنا: ${facts.link}`,
      `${RLM}تصلك هذه الرسالة بسبب إعدادات الإشعارات لديك في ${studio} على TManage.`,
    ].join('\n\n'),
  };
}

export function composeCollaborationEmail(
  kind: CollaborationMailKind,
  facts: CollaborationEmailFacts,
): MailMessage {
  if (kind === 'approval_requested') return composeApprovalRequestedEmail(facts);
  if (kind === 'review_comment' || kind === 'review_mention' || kind === 'review_decided') {
    return composeReviewEmail(kind, facts);
  }
  if ((kind === 'meeting_invite' || kind === 'meeting_changed') && isArabicLocale(facts.locale)) {
    return composeArabicMeetingEmail(kind, facts);
  }
  if (kind === 'approval_decided') return composeApprovalDecidedEmail(facts);
  if (kind === 'request_message' && isArabicLocale(facts.locale)) {
    return composeArabicRequestMessage(facts);
  }
  const name = oneLine(facts.recipientName);
  const actor = oneLine(facts.actorName ?? facts.organizationName);
  const title = oneLine(facts.subjectTitle);
  const studio = oneLine(facts.organizationName);
  let subject: string;
  let middle: string;
  switch (kind) {
    case 'mention':
      subject = `${actor} mentioned you in ${title}`;
      middle = `${actor} mentioned you in ${title}${inProject(facts)}.`;
      break;
    case 'comment':
      subject = `${actor} commented on ${title}`;
      middle = `${actor} commented on the document ${title}${inProject(facts)}.`;
      break;
    case 'meeting_invite':
      subject = `${actor} invited you to ${title}`;
      middle =
        `${actor} invited you to the meeting ${title}${inProject(facts)}` +
        (facts.when === undefined ? '.' : `, on ${facts.when}.`) +
        ' You can accept or decline from the meeting page.';
      break;
    case 'meeting_changed':
      subject = `${title} has changed`;
      middle =
        `${actor} changed the meeting ${title}${inProject(facts)}.` +
        (facts.when === undefined ? '' : ` It is now on ${facts.when}.`);
      break;
    case 'project_added':
      subject = `${actor} added you to ${title}`;
      middle = `${actor} added you to the project ${title}. Its work, channels and documents are now open to you.`;
      break;
    case 'client_action':
      subject = `${studio} needs your input on ${title}`;
      middle = `${studio} is waiting on you for ${title}${inProject(facts)}.`;
      break;
    case 'request_message':
      subject = `New message on ${title}`;
      middle = `${actor} posted a new message on the request ${title}${inProject(facts)}.`;
      break;
  }
  return {
    to: facts.recipientEmail,
    subject,
    text: [
      `Hello ${name},`,
      middle,
      `Open it here: ${facts.link}`,
      `You are receiving this because of your notification settings in ${studio} on TManage.`,
    ].join('\n\n'),
  };
}

export type CollaborationMailDelivery = 'sent' | 'none' | 'failed';

export class CollaborationMailer {
  /**
   * @param mailer `null` when no transport is wired.
   * @param webPublicUrl `WEB_PUBLIC_URL`, the origin links are built from.
   */
  constructor(
    private readonly mailer: Mailer | null,
    private readonly webPublicUrl: string,
  ) {}

  get enabled(): boolean {
    return this.mailer !== null;
  }

  /** An absolute link to a path in the web app (`/<slug>/chat/<id>`). */
  linkTo(path: string): string {
    const origin = this.webPublicUrl.replace(/\/+$/u, '');
    return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
  }

  compose(kind: CollaborationMailKind, facts: CollaborationEmailFacts): MailMessage {
    return composeCollaborationEmail(kind, facts);
  }

  async deliver(
    kind: CollaborationMailKind,
    facts: CollaborationEmailFacts,
  ): Promise<CollaborationMailDelivery> {
    if (this.mailer === null) return 'none';
    try {
      return await this.mailer.send(composeCollaborationEmail(kind, facts));
    } catch (error) {
      // Absorbed loudly, without the address: the driver's words may name the recipient.
      console.error(`[worker] ${kind} email failed`, error);
      return 'failed';
    }
  }
}
