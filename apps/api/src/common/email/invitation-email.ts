import type { MailMessage } from '@tmanage/mail';
import { renderActionEmail } from './action-email.js';

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
 * Arabic organizations (`default_locale` starting `ar`) get the Arabic copy, `dir="rtl"`.
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

/** Everything the two languages say, already flattened; HTML escaping happens at render. */
interface Copy {
  readonly subject: string;
  readonly eyebrow: string;
  readonly heading: string;
  readonly intro: string;
  readonly roleLabel: string;
  readonly roleValue: string;
  readonly accessLabel: string;
  readonly accessValue: string;
  readonly button: string;
  readonly fallback: string;
  readonly expiry: string;
  readonly why: string;
}

function copyFor(facts: InvitationEmailFacts): { readonly copy: Copy; readonly arabic: boolean } {
  const arabic = (facts.locale ?? 'en').toLowerCase().startsWith('ar');
  const organization = oneLine(facts.organizationName);
  const inviter = oneLine(facts.inviterName);
  const inviterEmail = oneLine(facts.inviterEmail);
  const role = roleLabel(oneLine(facts.role), arabic);
  const expiry = `${expiryDate(facts.expiresAt, arabic)} (UTC)`;
  const client =
    facts.clientOrganizationName === null ? null : oneLine(facts.clientOrganizationName);

  if (arabic) {
    return {
      arabic,
      copy: {
        subject:
          client === null
            ? `${inviter} دعاك للانضمام إلى ${organization} على TManage`
            : `${organization} دعاك إلى بوابة العملاء الخاصة بها`,
        eyebrow: 'دعوة',
        heading:
          client === null
            ? `${inviter} دعاك للانضمام إلى ${organization}`
            : `${organization} دعاك إلى بوابة العملاء`,
        intro:
          client === null
            ? `ستنضم إلى ${organization} على TManage بدور ${role}.`
            : `استخدم TManage لمتابعة التقدم والملفات والإجراءات المشتركة مع ${client}. لن ترى مساحة العمل الداخلية للفريق.`,
        roleLabel: 'الدور',
        roleValue: role,
        accessLabel: 'الوصول',
        accessValue: client === null ? `فريق ${organization}` : `بوابة عملاء ${client}`,
        button: client === null ? 'مراجعة الدعوة' : 'مراجعة الوصول',
        fallback: 'إذا لم يعمل الزر، انسخ هذا الرابط والصقه في المتصفح:',
        expiry: `تنتهي صلاحية هذه الدعوة في ${expiry}. بعد ذلك اطلب من ${inviter} دعوة جديدة.`,
        why: `تصلك هذه الرسالة لأن ${inviter} (${inviterEmail}) دعا هذا العنوان. إن لم تكن تتوقعها فتجاهلها أو راسل صاحب الدعوة.`,
      },
    };
  }

  return {
    arabic,
    copy: {
      subject:
        client === null
          ? `${inviter} invited you to ${organization} on TManage`
          : `${organization} invited you to their client portal`,
      eyebrow: 'Invitation',
      heading:
        client === null
          ? `${inviter} invited you to join ${organization}`
          : `${organization} invited you to their client portal`,
      intro:
        client === null
          ? `You’ve been invited as ${role} with access to ${organization}.`
          : `Use TManage to view progress, files, and actions shared with ${client}. ` +
            `Your role is ${role}. You will not see the team’s internal workspace.`,
      roleLabel: 'Role',
      roleValue: role,
      accessLabel: 'Access',
      accessValue: client === null ? `${organization} team` : `${client} client portal`,
      button: client === null ? 'Review invitation' : 'Review access',
      fallback: 'Button not working? Copy this link into your browser:',
      expiry: `This invitation expires on ${expiry}. After that, ask ${inviter} for a new one.`,
      why:
        `You are receiving this because ${inviter} (${inviterEmail}) invited this ` +
        `address. If you were not expecting it, ignore this email or reply to the inviter.`,
    },
  };
}

export function composeInvitationEmail(facts: InvitationEmailFacts): MailMessage {
  const { copy, arabic } = copyFor(facts);
  const action = `${copy.button}: ${facts.link}`;

  const text = [copy.heading, copy.intro, action, copy.expiry, copy.why].join('\n\n');

  return {
    to: facts.to,
    subject: copy.subject,
    text,
    // The copy says "reply to the inviter"; the From is the platform's no-reply mailbox.
    replyTo: oneLine(facts.inviterEmail),
    html: renderActionEmail({
      arabic,
      subject: copy.subject,
      eyebrow: copy.eyebrow,
      heading: copy.heading,
      intro: copy.intro,
      rows: [
        { label: copy.roleLabel, value: copy.roleValue },
        { label: copy.accessLabel, value: copy.accessValue },
      ],
      button: copy.button,
      link: facts.link,
      fallback: copy.fallback,
      note: copy.expiry,
      footer: copy.why,
    }),
  };
}
