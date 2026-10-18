import type { MailMessage } from '@tmanage/mail';

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

/** The design tokens this email uses — the same values as `packages/ui/src/styles/tokens.css`. */
const TOKENS = {
  ink950: '#090a09',
  ink650: '#4d5049',
  ink500: '#74786f',
  paper0: '#ffffff',
  paper50: '#f7f7f3',
  paper150: '#e9e9e5',
  lime500: '#b7ff57',
  client500: '#7755c7',
  fontLatin: "Manrope, 'Segoe UI', Helvetica, Arial, sans-serif",
  fontArabic: "Alexandria, Tahoma, 'Segoe UI', Arial, sans-serif",
  fontMono: "'Geist Mono', Consolas, 'Courier New', monospace",
} as const;

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

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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
    html: renderHtml(copy, facts.link, arabic),
  };
}

function renderHtml(copy: Copy, link: string, arabic: boolean): string {
  const dir = arabic ? 'rtl' : 'ltr';
  const lang = arabic ? 'ar' : 'en';
  const align = arabic ? 'right' : 'left';
  const font = arabic ? TOKENS.fontArabic : TOKENS.fontLatin;
  const e = escapeHtml;
  const href = e(link);

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
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${TOKENS.paper50};border-radius:12px;">
<tr><td style="padding:14px 16px;border-bottom:1px solid ${TOKENS.paper150};font-family:${font};font-size:13px;line-height:18px;color:${TOKENS.ink500};text-align:${align};">${e(copy.roleLabel)}<br><span style="font-size:15px;line-height:22px;font-weight:700;color:${TOKENS.ink950};">${e(copy.roleValue)}</span></td></tr>
<tr><td style="padding:14px 16px;font-family:${font};font-size:13px;line-height:18px;color:${TOKENS.ink500};text-align:${align};">${e(copy.accessLabel)}<br><span style="font-size:15px;line-height:22px;font-weight:700;color:${TOKENS.ink950};">${e(copy.accessValue)}</span></td></tr>
</table>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="${align}" style="margin:28px 0 0 0;"><tr>
<td align="center" bgcolor="${TOKENS.ink950}" style="border-radius:999px;">
<a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 28px;font-family:${font};font-size:15px;line-height:20px;font-weight:700;color:${TOKENS.paper0};text-decoration:none;border-radius:999px;">${e(copy.button)}</a>
</td></tr></table>
<div style="clear:both;height:28px;line-height:28px;font-size:0;">&nbsp;</div>
<p style="margin:0 0 6px 0;font-family:${font};font-size:13px;line-height:18px;color:${TOKENS.ink650};">${e(copy.fallback)}</p>
<p style="margin:0 0 24px 0;font-family:${TOKENS.fontMono};font-size:12px;line-height:17px;word-break:break-all;" dir="ltr"><a href="${href}" target="_blank" rel="noopener" style="color:${TOKENS.ink950};text-decoration:underline;">${href}</a></p>
<p style="margin:0;padding:12px 14px;border:1px dashed ${TOKENS.paper150};border-radius:12px;font-family:${font};font-size:13px;line-height:18px;color:${TOKENS.ink650};">${e(copy.expiry)}</p>
</td></tr>
<tr><td style="padding:16px 8px 0 8px;font-family:${font};font-size:12px;line-height:17px;color:${TOKENS.ink500};text-align:${align};">${e(copy.why)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
