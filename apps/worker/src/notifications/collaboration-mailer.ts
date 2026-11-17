import { forCompany, greeting } from '@tmanage/mail';
import type { Mailer, MailMessage } from '@tmanage/mail';
import { noticeSignature, signatureRowHtml } from './notice-sign-off.js';
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
  // R4 slice 12 — the proofing viewer: a comment, a reply, a mention, a decision on a file under
  // review.
  | 'review_comment'
  | 'review_reply'
  | 'review_mention'
  | 'review_decided'
  // C27 — the people on a task: made a doer or supervisor; a supervised task waits for approval.
  | 'people_assigned'
  | 'supervised_done';

export interface CollaborationEmailFacts {
  /** 56-26: the sending company — its Message-ID is signed and its bounce suppressions apply. */
  readonly organizationId?: string;
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
  /**
   * t8-b — `approval_requested`: the version number sent for approval. R4 Batch F follow-up: also
   * the review emails, which name the file as drawn in V-51 ("Homepage Concept v2.png").
   */
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
  /** C27 — `people_assigned` only: the role the recipient was given on the task. */
  readonly assigneeRole?: 'doer' | 'supervisor';
}

/** Whether a BCP-47 locale asks for Arabic copy. */
export function isArabicLocale(locale: string | undefined): boolean {
  return locale !== undefined && /^ar(?:-|$)/iu.test(locale);
}

/** Flattened before it reaches a header or a line: these are strings people typed. */
function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
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
  readonly greeting: string;
  readonly sender: string;
  readonly project: string;
  /** The lead sentence, then the sender's note and the decide-by line when there are any. */
  readonly lines: readonly string[];
  readonly button: string;
  readonly signature: readonly string[];
}

/** EMAIL-COPY N6 (a team approver) and K8 (a client approver in the portal). */
function approvalCopy(facts: CollaborationEmailFacts, arabic: boolean): ApprovalCopy {
  const language = arabic ? 'ar' : 'en';
  const studio = oneLine(facts.organizationName);
  const actor = facts.actorName === undefined ? null : oneLine(facts.actorName);
  const who = actor ?? studio;
  const title = oneLine(facts.subjectTitle);
  const project = facts.projectName === undefined ? '' : oneLine(facts.projectName);
  const due = facts.dueDate === undefined ? null : oneLine(facts.dueDate);
  const check = facts.checkNote === undefined ? '' : oneLine(facts.checkNote);
  const version = facts.versionNumber;
  const portal = facts.portal === true;
  const sender = actor === null || actor === studio ? studio : `${actor} · ${studio}`;
  const signature = noticeSignature(language, { portal, workspaceName: studio, link: facts.link });
  const head = { greeting: greeting(language, facts.recipientName), project, signature };
  if (arabic) {
    const suffix = version === undefined ? '' : `، الإصدار ${version}`;
    const lead = portal
      ? `يطلب ${who} من ${studio} اعتمادك على ${title}${suffix}.`
      : `طلب ${who} اعتمادك على ${title}${suffix}.`;
    return {
      ...head,
      subject: portal
        ? `${RLM}${studio}: مطلوب اعتمادك على ${title}${suffix}`
        : `${RLM}مطلوب اعتمادك: ${title}${suffix}`,
      sender: `${RLM}${sender}`,
      lines: [
        `${RLM}${lead}`,
        check === '' ? '' : `"${check}"`,
        due === null ? '' : `مطلوب قبل ${due}.`,
      ].filter(Boolean),
      button: 'راجع وقرّر',
    };
  }
  const suffix = version === undefined ? '' : `, version ${version}`;
  const lead = portal
    ? `${who} from ${studio} asks for your approval on ${title}${suffix}.`
    : `${who} asked for your approval on ${title}${suffix}.`;
  return {
    ...head,
    subject: portal
      ? `${studio}: your approval is needed on ${title}${suffix}`
      : `Your approval is needed: ${title}${suffix}`,
    sender,
    lines: [
      lead,
      check === '' ? '' : `"${check}"`,
      due === null ? '' : `Requested by ${due}.`,
    ].filter(Boolean),
    button: 'Review and decide',
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
  const body = copy.lines
    .map(
      (line) =>
        `<p style="margin:0 0 20px 0;font-family:${font};font-size:15px;line-height:22px;color:${t.ink650};">${e(line)}</p>`,
    )
    .join('');
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
${button(copy.button, true)}
</tr></table>
<div style="clear:both;height:4px;line-height:4px;font-size:0;">&nbsp;</div>
</td></tr>
${signatureRowHtml(copy.signature, font, align)}
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
    language: arabic ? 'ar' : 'en',
    subject: copy.subject,
    text: [
      copy.greeting,
      ...copy.lines,
      `${copy.button}: ${facts.link}`,
      copy.signature.join('\n'),
    ].join('\n\n'),
    html: renderApprovalHtml(copy, initialsOf(who), facts.link, arabic),
  };
}

interface NoticeCopy {
  readonly subject: string;
  readonly lines: readonly string[];
  readonly button: string;
}

type PlainKind = Exclude<
  CollaborationMailKind,
  'approval_requested' | 'review_comment' | 'review_reply' | 'review_mention' | 'review_decided'
>;

/** EMAIL-COPY N1-N5, N7, N10-N12 (team) and K8 (portal). Never what anybody wrote. */
function noticeCopy(kind: PlainKind, facts: CollaborationEmailFacts, arabic: boolean): NoticeCopy {
  const studio = oneLine(facts.organizationName);
  const actorName = oneLine(facts.actorName ?? facts.organizationName);
  const portal = facts.portal === true;
  const actor =
    portal && actorName !== studio
      ? arabic
        ? `${actorName} من ${studio}`
        : `${actorName} from ${studio}`
      : actorName;
  const title = oneLine(facts.subjectTitle);
  const when = facts.when === undefined ? null : oneLine(facts.when);
  const due = facts.dueDate === undefined ? null : oneLine(facts.dueDate);
  const approved = facts.decision === 'approved';
  const supervisor = facts.assigneeRole === 'supervisor';
  if (arabic) {
    switch (kind) {
      case 'mention':
        return {
          subject: `أشار إليك ${actorName} في ${title}`,
          lines: [`أشار إليك ${actor} في ${title} (${studio}).`],
          button: 'افتح المحادثة',
        };
      case 'comment':
        return {
          subject: `علّق ${actorName} على ${title}`,
          lines: [`كتب ${actor} تعليقًا على ${title}.`],
          button: 'اقرأ وردّ',
        };
      case 'meeting_invite':
        return {
          subject: `دعاك ${actorName} إلى ${title}`,
          lines: [`دعاك ${actor} إلى ${title}.`, when === null ? '' : `الموعد: ${when}`],
          button: 'عرض الاجتماع',
        };
      case 'meeting_changed':
        return {
          subject: `تغيّر موعد ${title}`,
          lines: [`غيّر ${actor} موعد ${title}.`, when === null ? '' : `الموعد الجديد: ${when}`],
          button: 'عرض الاجتماع',
        };
      case 'project_added':
        return {
          subject: `أصبحت ضمن مشروع ${title}`,
          lines: [`أضافك ${actor} إلى مشروع ${title} في ${studio}.`],
          button: 'افتح المشروع',
        };
      case 'approval_decided':
        return {
          subject: `${approved ? 'تم الاعتماد' : 'مطلوب تعديلات'}: تسليم في ${title}`,
          lines: [
            approved
              ? `اعتمد ${actor} تسليمًا في ${title}.`
              : `طلب ${actor} تعديلات على تسليم في ${title}.`,
          ],
          button: 'عرض القرار',
        };
      case 'people_assigned':
        return {
          subject: `مهمة جديدة لك: ${title}`,
          lines: [
            `عيّنك ${actor} ${supervisor ? 'مشرفًا' : 'منفّذًا'} لمهمة ${title}.`,
            due === null ? '' : `موعد التسليم ${due}.`,
          ],
          button: 'افتح المهمة',
        };
      case 'supervised_done':
        return {
          subject: `جاهزة لمراجعتك: ${title}`,
          lines: [`أنهى ${actor} مهمة ${title}، وهي الآن في انتظار اعتمادك كمشرف.`],
          button: 'راجع المهمة',
        };
      case 'request_message':
        return portal
          ? {
              subject: `ردّ ${actorName} على طلبك ${title}`,
              lines: [`كتب ${actor} على طلبك ${title}.`],
              button: 'اقرأ وردّ',
            }
          : {
              subject: `رسالة جديدة على الطلب ${title}`,
              lines: [`كتب ${actor} على الطلب ${title}.`],
              button: 'ردّ من داخل TManage',
            };
      case 'client_action':
        return {
          subject: `${studio} تحتاج إلى ردّك على ${title}`,
          lines: [`${studio} في انتظارك بخصوص ${title}.`],
          button: 'افتح البوابة',
        };
    }
  }
  switch (kind) {
    case 'mention':
      return {
        subject: `${actorName} mentioned you in ${title}`,
        lines: [`${actor} mentioned you in ${title} (${studio}).`],
        button: 'Open the conversation',
      };
    case 'comment':
      return {
        subject: `${actorName} commented on ${title}`,
        lines: [`${actor} left a comment on ${title}.`],
        button: 'Read and answer',
      };
    case 'meeting_invite':
      return {
        subject: `${actorName} invited you to ${title}`,
        lines: [`${actor} invited you to ${title}.`, when === null ? '' : `When: ${when}`],
        button: 'See the meeting',
      };
    case 'meeting_changed':
      return {
        subject: `New time for ${title}`,
        lines: [`${actor} moved ${title}.`, when === null ? '' : `New time: ${when}`],
        button: 'See the meeting',
      };
    case 'project_added':
      return {
        subject: `You are now on ${title}`,
        lines: [`${actor} added you to the project ${title} in ${studio}.`],
        button: 'Open the project',
      };
    case 'approval_decided':
      return {
        // The worker reads no deliverable title: the subject is the project the deliverable is in.
        subject: approved
          ? `A deliverable in ${title} was approved`
          : `Changes requested on a deliverable in ${title}`,
        lines: [
          approved
            ? `${actor} approved a deliverable in ${title}.`
            : `${actor} asked for changes on a deliverable in ${title}.`,
        ],
        button: 'See the decision',
      };
    case 'people_assigned':
      return {
        subject: `New task for you: ${title}`,
        lines: [
          `${actor} made you the ${supervisor ? 'supervisor' : 'doer'} of ${title}.`,
          due === null ? '' : `Due ${due}.`,
        ],
        button: 'Open the task',
      };
    case 'supervised_done':
      return {
        subject: `Ready for your check: ${title}`,
        lines: [`${actor} finished ${title} and it now waits for your approval as supervisor.`],
        button: 'Check the task',
      };
    case 'request_message':
      return portal
        ? {
            subject: `${actorName} answered your request ${title}`,
            lines: [`${actor} wrote on your request ${title}.`],
            button: 'Read and answer',
          }
        : {
            subject: `New message on the request ${title}`,
            lines: [`${actor} wrote on the request ${title}.`],
            button: 'Answer in TManage',
          };
    case 'client_action':
      return {
        subject: `${studio} needs your input on ${title}`,
        lines: [`${studio} is waiting on you for ${title}.`],
        button: 'Open the portal',
      };
  }
}

/** Q3 — `approval_decided` (N7): who decided, on what, and the link. Never the feedback text. */
export function composeApprovalDecidedEmail(facts: CollaborationEmailFacts): MailMessage {
  return composePlainNotice('approval_decided', facts);
}

function composePlainNotice(kind: PlainKind, facts: CollaborationEmailFacts): MailMessage {
  const arabic = isArabicLocale(facts.locale);
  const language = arabic ? 'ar' : 'en';
  const copy = noticeCopy(kind, facts, arabic);
  // The client-action e-mail always reaches a client person: the agency signs it.
  const portal = facts.portal === true || kind === 'client_action';
  const signature = noticeSignature(language, {
    portal,
    workspaceName: oneLine(facts.organizationName),
    link: facts.link,
  });
  const mark = arabic ? RLM : '';
  return {
    to: facts.recipientEmail,
    language,
    subject: `${mark}${copy.subject}`,
    text: [
      greeting(language, facts.recipientName),
      ...copy.lines.filter(Boolean).map((line) => `${mark}${line}`),
      `${copy.button}: ${facts.link}`,
      signature.join('\n'),
    ].join('\n\n'),
  };
}

export function composeCollaborationEmail(
  kind: CollaborationMailKind,
  facts: CollaborationEmailFacts,
): MailMessage {
  if (kind === 'approval_requested') return composeApprovalRequestedEmail(facts);
  if (
    kind === 'review_comment' ||
    kind === 'review_reply' ||
    kind === 'review_mention' ||
    kind === 'review_decided'
  ) {
    return composeReviewEmail(kind, facts);
  }
  return composePlainNotice(kind, facts);
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
      return await this.mailer.send(
        forCompany(composeCollaborationEmail(kind, facts), facts.organizationId),
      );
    } catch (error) {
      // Absorbed loudly, without the address: the driver's words may name the recipient.
      console.error(`[worker] ${kind} email failed`, error);
      return 'failed';
    }
  }
}
