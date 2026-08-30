import type { MailMessage } from '@tmanage/mail';

/**
 * The invitation templates from `35-NOTIFICATION-AND-EMAIL-COPY` §3, rendered.
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
}

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

function expiryDate(expiresAt: Date): string {
  return expiresAt.toISOString().slice(0, 10);
}

export function composeInvitationEmail(facts: InvitationEmailFacts): MailMessage {
  const organization = oneLine(facts.organizationName);
  const inviter = oneLine(facts.inviterName);
  const role = oneLine(facts.role);
  const expiry = `${expiryDate(facts.expiresAt)} (UTC)`;
  const whyAndSupport =
    `You are receiving this because ${inviter} (${facts.inviterEmail}) invited this ` +
    `address. If you were not expecting it, ignore this email or reply to the inviter.`;

  if (facts.clientOrganizationName === null) {
    return {
      to: facts.to,
      subject: `${inviter} invited you to ${organization} on TManage`,
      text: [
        `You’ve been invited as ${role} with access to ${organization}. ` +
          `This invitation expires ${expiry}.`,
        `Review invitation: ${facts.link}`,
        whyAndSupport,
      ].join('\n\n'),
    };
  }

  const clientOrganization = oneLine(facts.clientOrganizationName);
  return {
    to: facts.to,
    subject: `${organization} invited you to their client portal`,
    text: [
      `Use TManage to view progress, files, and actions shared with ${clientOrganization}. ` +
        `Your role is ${role}. You will not see the team’s internal workspace.`,
      `Review access: ${facts.link}`,
      `This invitation expires ${expiry}.`,
      whyAndSupport,
    ].join('\n\n'),
  };
}
