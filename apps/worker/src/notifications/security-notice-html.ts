import { renderMailLayout } from '@tmanage/mail';

/**
 * The HTML twin of a security receipt's text body, in the one shared mail layout
 * (`@tmanage/mail` `layout.ts`) minus the button and the link — a security notice must never carry
 * one (see `credential-change-mailer.ts`). Every string is HTML-escaped by the layout; callers pass
 * plain text.
 */

export interface SecurityNoticeContent {
  /** Also the heading. */
  readonly subject: string;
  readonly intro: string;
  /** Label/value facts in a panel under the intro. */
  readonly rows: readonly { readonly label: string; readonly value: string }[];
  /** The dashed note — what to do if the change was not the recipient's. */
  readonly note: string;
  /** Under the card: why this person received the message. */
  readonly footer: string;
  /** EMAILBUILD (c): Arabic, right to left. */
  readonly arabic?: boolean;
  /** EMAILBUILD (c): the eyebrow over the heading (default "Security notice"). */
  readonly eyebrow?: string;
  /** EMAILBUILD (c): the [SEC] sign-off lines, drawn under the card. */
  readonly signature?: readonly string[];
}

export function renderSecurityNoticeHtml(content: SecurityNoticeContent): string {
  return renderMailLayout({
    arabic: content.arabic === true,
    subject: content.subject,
    preheader: content.intro,
    eyebrow: content.eyebrow ?? 'Security notice',
    heading: content.subject,
    blocks: [
      { kind: 'text', text: content.intro },
      { kind: 'rows', rows: content.rows },
    ],
    note: content.note,
    signature: content.signature ?? [],
    footer: content.footer,
  });
}
