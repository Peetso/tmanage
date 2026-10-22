import type { MailMessage } from '@tmanage/mail';
import { EMAIL_TOKENS, escapeHtml } from './action-email.js';

/**
 * The invitation templates from `35-NOTIFICATION-AND-EMAIL-COPY` §3, rendered — as plain text
 * and as a table-based HTML part that Gmail and Outlook both draw the same way.
 *
 * Two of that section's placeholders do not exist on an invitation, and the divergence is
 * recorded in `docs/implementation-status.md` rather than papered over here:
 *
 * - The internal template's `{{scope}}`: an invitation grants membership in the
 *   organization and names nothing narrower (`0005_invitations.sql` has no project
 *   column), so the sentence says the organization.
 * - The client template's `{{project}}`: same column, same reason — the subject says
 *   "their client portal" instead of naming a project the row does not hold.
 *
 * §1's checklist is the body's shape: organization, action, deadline with timezone, why
 * this recipient, one CTA, and a route for the unexpected case. There is no preference
 * centre to link — the honest route for a mis-sent invitation is the inviter, whose
 * address the preview endpoint already discloses to anyone holding the token.
 *
 * ## The HTML part, and why it cannot hide a different link
 *
 * `MailMessage.text` is the authoritative body; `html` is the same sentences in the TManage
 * design tokens (ink, paper, Manrope / Alexandria). The one button's `href` is the very link
 * printed underneath it as the fallback, so the visible URL and the clicked one can never
 * differ — the phishing shape a credential-bearing mail must not have. Every interpolated
 * string is HTML-escaped, and the only URL is the one `InvitationMailer` built from
 * configuration.
 *
 * The layout is the Figma frame t1-e (369:1362 English, 369:1538 Arabic): wordmark, rule, the
 * inviter's initials and name, the heading, one sentence with the role, one pill button, the
 * expiry line, the fallback link, and "Sent by TManage on behalf of …" under the card.
 *
 * A recipient whose locale starts `ar` gets the Arabic copy, `dir="rtl"`, the Alexandria stack,
 * and U+200F at the head of every line that mixes Arabic with a Latin brand name. Any other
 * locale, or none, gets English.
 */

export interface InvitationEmailFacts {
  readonly to: string;
  /** Which template: `null` renders the internal one, a name renders the client one. */
  readonly clientOrganizationName: string | null;
  readonly organizationName: string;
  readonly inviterName: string;
  readonly inviterEmail: string;
  readonly role: string;
  readonly expiresAt: Date;
  /** The accept URL, token included — built by `InvitationMailer`, which owns the base. */
  readonly link: string;
  /** The organization's `default_locale`. Anything starting `ar` renders the Arabic copy. */
  readonly locale?: string;
}

/** The role names people read — the same labels `apps/web/src/lib/roles.ts` shows. */
const ROLE_LABELS: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  owner: { en: 'Owner', ar: 'المالك' },
  org_admin: { en: 'Organization admin', ar: 'مسؤول المؤسسة' },
  workspace_admin: { en: 'Workspace admin', ar: 'مسؤول مساحة العمل' },
  manager: { en: 'Manager', ar: 'مدير' },
  moderator: { en: 'Moderator', ar: 'مشرف' },
  member: { en: 'Team member', ar: 'عضو في الفريق' },
  guest: { en: 'Freelancer or partner', ar: 'مستقل أو شريك' },
  client_admin: { en: 'Client admin', ar: 'مسؤول العميل' },
  client_reviewer: { en: 'Client reviewer', ar: 'مراجع لدى العميل' },
  client_member: { en: 'Client member', ar: 'عضو لدى العميل' },
  client_viewer: { en: 'Client viewer', ar: 'مشاهد لدى العميل' },
};

/**
 * Interpolations are flattened to one line before they touch a header or the body.
 *
 * An organization is named by its tenant and an inviter by themselves, so either string is
 * attacker-adjacent; a newline in a subject is how one message grows a second recipient or
 * an extra header. nodemailer refuses such headers outright — this keeps the console
 * driver, and the body, on the same rule rather than relying on which driver is wired.
 */
function oneLine(value: string): string {
  // `\s` so U+2028/U+2029 are covered too — the line separators a header parser
  // honours and a reviewer cannot see in a character class.
  return value.replaceAll(/\s+/gu, ' ').trim();
}

/** A date a person reads — "13 September 2026" — fixed to UTC, which the copy then names. */
function expiryDate(expiresAt: Date, arabic: boolean): string {
  return new Intl.DateTimeFormat(arabic ? 'ar-EG-u-nu-latn' : 'en-GB', {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(expiresAt);
}

function roleLabel(role: string, arabic: boolean): string {
  const known = ROLE_LABELS[role];
  if (!known) return role;
  return arabic ? known.ar : known.en;
}

/** U+200F, the right-to-left mark: keeps a mixed Arabic/Latin line anchored right. */
const RLM = '‏';

/** Two initials for a Latin name, the first letter alone for an Arabic one (the design's "ع"). */
export function initialsOf(name: string): string {
  const words = oneLine(name).split(' ').filter(Boolean);
  const first = words[0] ?? '';
  if (/^\p{Script=Arabic}/u.test(first)) return [...first][0] ?? '';
  return words
    .slice(0, 2)
    .map((word) => [...word][0] ?? '')
    .join('')
    .toUpperCase();
}

/** Everything the two languages say, already flattened; HTML escaping happens at render. */
interface Copy {
  readonly subject: string;
  readonly heading: string;
  readonly intro: string;
  readonly button: string;
  readonly fallback: string;
  readonly expiry: string;
  readonly footer: string;
}

function copyFor(facts: InvitationEmailFacts): { readonly copy: Copy; readonly arabic: boolean } {
  const arabic = (facts.locale ?? 'en').toLowerCase().startsWith('ar');
  const organization = oneLine(facts.organizationName);
  const inviter = oneLine(facts.inviterName);
  const role = roleLabel(oneLine(facts.role), arabic);
  const expiry = `${expiryDate(facts.expiresAt, arabic)} (UTC)`;
  const client =
    facts.clientOrganizationName === null ? null : oneLine(facts.clientOrganizationName);

  if (arabic) {
    return {
      arabic,
      copy: {
        subject: `${RLM}${inviter} دعاك إلى ${organization} بدور ${role}`,
        heading:
          client === null
            ? `${RLM}أنت مدعو للانضمام إلى ${organization} على TManage`
            : `${RLM}أنت مدعو إلى بوابة عملاء ${organization} على TManage`,
        intro:
          client === null
            ? `${RLM}ستعمل مع فريق ${organization}. دورك: ${role}.`
            : `${RLM}تابع التقدم والملفات والإجراءات المشتركة مع ${client}. دورك: ${role}. لن ترى مساحة العمل الداخلية للفريق.`,
        button: 'قبول الدعوة',
        fallback: 'إذا لم يعمل الزر، انسخ هذا الرابط والصقه في المتصفح:',
        expiry: `تنتهي صلاحية هذه الدعوة في ${expiry}. إذا لم تكن تتوقعها، يمكنك تجاهل هذه الرسالة.`,
        footer: `${RLM}أُرسلت من TManage نيابةً عن ${organization}`,
      },
    };
  }

  return {
    arabic,
    copy: {
      subject: `${inviter} invited you to ${organization} as ${role}`,
      heading:
        client === null
          ? `You are invited to join ${organization} on TManage`
          : `You are invited to the ${organization} client portal on TManage`,
      intro:
        client === null
          ? `You will work with the team at ${organization}. Your role: ${role}.`
          : `Follow progress, files and actions shared with ${client}. Your role: ${role}. ` +
            `You will not see the team’s internal workspace.`,
      button: 'Accept invitation',
      fallback: 'Button not working? Copy this link into your browser:',
      expiry: `This invitation expires on ${expiry}. If you were not expecting it, you can ignore this email.`,
      footer: `Sent by TManage on behalf of ${organization}`,
    },
  };
}

interface Sender {
  readonly initials: string;
  readonly name: string;
  readonly organization: string;
}

/** The t1-e layout: table-based so Gmail and Outlook draw it alike; tokens only. */
function renderInvitationHtml(copy: Copy, sender: Sender, link: string, arabic: boolean): string {
  const t = EMAIL_TOKENS;
  const e = escapeHtml;
  const dir = arabic ? 'rtl' : 'ltr';
  const align = arabic ? 'right' : 'left';
  const font = arabic ? t.fontArabic : t.fontLatin;
  const href = e(link);
  return `<!doctype html>
<html lang="${arabic ? 'ar' : 'en'}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${e(copy.subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${t.paper50};">
<div style="display:none;max-height:0;overflow:hidden;">${e(copy.intro)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${t.paper50};">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" dir="${dir}" style="max-width:600px;">
<tr><td style="background-color:${t.paper0};border:1px solid ${t.paper150};border-radius:24px;padding:40px;text-align:${align};font-family:${font};">
<p style="margin:0;padding:0 0 24px 0;border-bottom:1px solid ${t.paper150};font-family:${t.fontLatin};font-size:20px;line-height:28px;font-weight:600;color:${t.ink950};" dir="ltr" align="${align}">TManage</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="${align}" style="margin:20px 0 0 0;"><tr>
<td width="40" height="40" align="center" valign="middle" style="background-color:${t.paper150};border-radius:999px;font-family:${font};font-size:14px;line-height:40px;color:${t.ink650};">${e(sender.initials)}</td>
<td style="padding:0 12px;font-family:${font};text-align:${align};"><span style="font-size:14px;line-height:20px;color:${t.ink950};">${e(sender.name)}</span><br><span style="font-size:12px;line-height:18px;color:${t.ink500};">${e(sender.organization)}</span></td>
</tr></table>
<div style="clear:both;height:20px;line-height:20px;font-size:0;">&nbsp;</div>
<h1 style="margin:0 0 16px 0;font-family:${font};font-size:24px;line-height:32px;font-weight:600;color:${t.ink950};">${e(copy.heading)}</h1>
<p style="margin:0 0 20px 0;font-family:${font};font-size:15px;line-height:22px;color:${t.ink650};">${e(copy.intro)}</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="${align}"><tr>
<td align="center" bgcolor="${t.ink950}" style="border-radius:999px;">
<a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 20px;font-family:${font};font-size:14px;line-height:20px;color:${t.paper0};text-decoration:none;border-radius:999px;">${e(copy.button)}</a>
</td></tr></table>
<div style="clear:both;height:20px;line-height:20px;font-size:0;">&nbsp;</div>
<p style="margin:0 0 12px 0;font-family:${font};font-size:12px;line-height:18px;color:${t.ink500};">${e(copy.expiry)}</p>
<p style="margin:0;font-family:${font};font-size:12px;line-height:18px;color:${t.ink500};">${e(copy.fallback)}<br><a href="${href}" target="_blank" rel="noopener" dir="ltr" style="font-family:${t.fontMono};color:${t.ink650};text-decoration:underline;word-break:break-all;">${href}</a></p>
</td></tr>
<tr><td align="center" style="padding:20px 8px 0 8px;font-family:${font};font-size:12px;line-height:18px;color:${t.ink500};">${e(copy.footer)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function composeInvitationEmail(facts: InvitationEmailFacts): MailMessage {
  const { copy, arabic } = copyFor(facts);
  const inviter = oneLine(facts.inviterName);
  const sender: Sender = {
    initials: initialsOf(inviter),
    name: inviter,
    organization: oneLine(facts.organizationName),
  };
  const action = `${copy.button}: ${facts.link}`;
  const text = [copy.heading, copy.intro, action, copy.expiry, copy.footer].join('\n\n');

  return {
    to: facts.to,
    subject: copy.subject,
    text,
    // A reply reaches the person who invited, not the platform's no-reply mailbox.
    replyTo: oneLine(facts.inviterEmail),
    html: renderInvitationHtml(copy, sender, facts.link, arabic),
  };
}
