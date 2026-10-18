import type { Mailer, MailMessage } from '@tmanage/mail';

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
  'mention' | 'comment' | 'meeting_invite' | 'project_added' | 'client_action';

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
}

/** Flattened before it reaches a header or a line: these are strings people typed. */
function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

function inProject(facts: CollaborationEmailFacts): string {
  return facts.projectName === undefined ? '' : ` in ${oneLine(facts.projectName)}`;
}

export function composeCollaborationEmail(
  kind: CollaborationMailKind,
  facts: CollaborationEmailFacts,
): MailMessage {
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
    case 'project_added':
      subject = `${actor} added you to ${title}`;
      middle = `${actor} added you to the project ${title}. Its work, channels and documents are now open to you.`;
      break;
    case 'client_action':
      subject = `${studio} needs your input on ${title}`;
      middle = `${studio} is waiting on you for ${title}${inProject(facts)}.`;
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
