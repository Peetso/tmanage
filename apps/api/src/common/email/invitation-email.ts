import type { MailMessage } from '@tmanage/mail';
import { EMAIL_TOKENS, escapeHtml } from './action-email.js';
import { emailIsRtl, emailT, type EmailKey } from '../i18n/email-messages.js';

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
  /** The organization's `default_locale`; `emailT` picks the catalog (English when it has none). */
  readonly locale?: string;
}

/** The role names people read — the same labels `apps/web/src/lib/roles.ts` shows. */
const ROLE_KEYS: Readonly<Record<string, EmailKey>> = {
  owner: 'role.owner',
  org_admin: 'role.org_admin',
  workspace_admin: 'role.workspace_admin',
  manager: 'role.manager',
  moderator: 'role.moderator',
  member: 'role.member',
  guest: 'role.guest',
  client_admin: 'role.client_admin',
  client_reviewer: 'role.client_reviewer',
  client_member: 'role.client_member',
  client_viewer: 'role.client_viewer',
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

/** F36b: an interpolated name is at most this many characters in a subject or a body. */
export const MAX_MAIL_NAME_LENGTH = 60;

/** A run that a mail client would turn into a link: a scheme, `www.`, or `label.tld/…`. */
const URL_LIKE =
  /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*|[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[a-z]{2,}(?:[/:?#]\S*)?/giu;

/**
 * A run that reads as a phone number: seven or more digits joined by spaces, dots, dashes,
 * brackets or slashes. `\p{Nd}` so any script's decimal digits count (F36b: Arabic-Indic
 * "٠١٠..." reads as a number just as well as "010...").
 */
const PHONE_LIKE = /\+?\p{Nd}(?:[\s()./-]*\p{Nd}){6,}/gu;

/** F36b: the ideographic, full-width and half-width full stops a reader takes for a dot. */
const DOT_LOOKALIKES = /[\u3002\uFF0E\uFF61]/gu;

/**
 * M03 / F36: code points a reader does not see but that split a run for the filters below —
 * "evil<U+200B>.com" renders as "evil.com" while no longer matching URL_LIKE. Every format
 * character (`\p{Cf}`: U+200B-U+200F, U+2060-U+2064, U+FEFF, U+00AD, the bidi embeddings and
 * isolates U+202A-U+202E / U+2066-U+2069, U+061C, tags, …) plus every
 * Default_Ignorable_Code_Point, which covers the fillers that are not Cf: U+034F, the Hangul
 * fillers U+115F / U+1160 / U+3164 / U+FFA0, U+17B4-U+17B5, the Mongolian selectors
 * U+180B-U+180F and the variation selectors U+FE00-U+FE0F / U+E0100-U+E01EF. Property
 * escapes, not a literal class, so no combining mark sits inside a character class.
 *
 * Decision for U+200F (RLM) and its kin inside an Arabic name: stripped silently, and the name
 * passes. The templates already put one RLM at the head of every mixed Arabic/Latin line
 * (the Arabic catalog lines), so a mark inside a typed name adds nothing the design needs, and a bidi
 * override inside a name is exactly how text is made to read differently from what it is.
 */
const INVISIBLE = /\p{Cf}|\p{Default_Ignorable_Code_Point}/gu;

/**
 * F36b: compatibility-normalise (NFKC: full-width letters, digits, '@' and '/' become their
 * plain forms), drop the invisible code points above (after NFKC, which maps U+3164 / U+FFA0
 * to U+1160), and fold the dot look-alikes, so the filters below see what a reader sees. The
 * name is rendered in this folded form, never the raw one, so what passed is what is shown.
 */
function canonicalForFilters(value: string): string {
  return value.normalize('NFKC').replaceAll(INVISIBLE, '').replaceAll(DOT_LOOKALIKES, '.');
}

/** An email address, which a name must never smuggle into the copy either. */
const EMAIL_LIKE = /\S+@\S+/gu;

/**
 * F36b — names somebody else typed (the organization, the inviter, the client company) are
 * flattened to one line, stripped of anything a reader or a mail client would act on (a link,
 * an address, a phone number), and capped. A platform-branded invitation must not carry an
 * attacker's "call +1 555 0100" or "pay at evil.example" in its own voice.
 */
export function mailSafeName(value: string): string {
  const neutralised = oneLine(canonicalForFilters(value))
    .replaceAll(EMAIL_LIKE, '…')
    .replaceAll(URL_LIKE, '…')
    .replaceAll(PHONE_LIKE, '…')
    .replaceAll(/(?:…\s*)+/gu, '… ')
    .trim();
  const chars = [...neutralised];
  const capped =
    chars.length > MAX_MAIL_NAME_LENGTH
      ? `${chars
          .slice(0, MAX_MAIL_NAME_LENGTH - 1)
          .join('')
          .trimEnd()}…`
      : neutralised;
  return capped === '' || capped === '…' ? '—' : capped;
}

/**
 * A date a person reads — "13 September 2026" — fixed to UTC, which the copy then names. The
 * language's catalog names its date locale (`meta.dateLocale`).
 */
function expiryDate(expiresAt: Date, locale: string | undefined): string {
  return new Intl.DateTimeFormat(emailT(locale, 'meta.dateLocale'), {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(expiresAt);
}

function roleLabel(role: string, locale: string | undefined): string {
  const key = Object.prototype.hasOwnProperty.call(ROLE_KEYS, role) ? ROLE_KEYS[role] : undefined;
  return key ? emailT(locale, key) : role;
}

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
  // R12 R2: the catalogs (`common/i18n/email`) hold the copy; Arabic lines carry U+200F (RLM) at
  // the head of every line that mixes Arabic with a Latin brand name.
  const locale = facts.locale;
  const arabic = emailIsRtl(locale);
  const organization = mailSafeName(facts.organizationName);
  const inviter = mailSafeName(facts.inviterName);
  const role = roleLabel(oneLine(facts.role), locale);
  const expiry = `${expiryDate(facts.expiresAt, locale)} (UTC)`;
  const client =
    facts.clientOrganizationName === null ? null : mailSafeName(facts.clientOrganizationName);
  const vars = { organization, inviter, role, client: client ?? '', date: expiry };

  return {
    arabic,
    copy: {
      subject: emailT(locale, 'invitation.subject', vars),
      heading: emailT(
        locale,
        client === null ? 'invitation.headingInternal' : 'invitation.headingClient',
        vars,
      ),
      intro: emailT(
        locale,
        client === null ? 'invitation.introInternal' : 'invitation.introClient',
        vars,
      ),
      button: emailT(locale, 'invitation.button'),
      fallback: emailT(locale, 'common.fallback'),
      expiry: emailT(locale, 'invitation.expiry', vars),
      footer: emailT(locale, 'invitation.footer', vars),
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
  const inviter = mailSafeName(facts.inviterName);
  const sender: Sender = {
    initials: initialsOf(inviter),
    name: inviter,
    organization: mailSafeName(facts.organizationName),
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
