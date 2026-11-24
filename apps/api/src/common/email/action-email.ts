/**
 * The one HTML layout TManage's action emails share — an invitation, a password-reset link.
 *
 * MAILDESIGN (2026-11-24): the layout itself moved to `@tmanage/mail` (`layout.ts`) so the worker
 * draws the same card; this file keeps the API's action-mail shape (intro, facts, one button, the
 * fallback URL, the dashed note) and re-exports the tokens, the escaper and the signature row for
 * the API's other mail files. One button, and its `href` is exactly the URL printed under it.
 */

import { EMAIL_TOKENS, escapeHtml, renderMailLayout, signatureRow } from '@tmanage/mail';

export { EMAIL_TOKENS, escapeHtml, signatureRow };

export interface ActionEmailContent {
  readonly arabic: boolean;
  readonly subject: string;
  readonly eyebrow: string;
  readonly heading: string;
  readonly intro: string;
  /** Label/value facts in a panel under the intro (role, access). May be empty. */
  readonly rows: readonly { readonly label: string; readonly value: string }[];
  readonly button: string;
  /** The one URL. Built from configuration by the caller, never from a request. */
  readonly link: string;
  /** "Button not working? Copy this link…" */
  readonly fallback: string;
  /** The dashed note — an expiry. */
  readonly note: string;
  /** Under the card: why this person received the message. */
  readonly footer: string;
  /** EMAILBUILD (c): the preview line a mail app shows after the subject (default: the intro). */
  readonly preheader?: string;
  /** EMAILBUILD (c): the sign-off lines (`signOff` in `@tmanage/mail`), one paragraph each. */
  readonly signature?: readonly string[];
}

export function renderActionEmail(content: ActionEmailContent): string {
  return renderMailLayout({
    arabic: content.arabic,
    subject: content.subject,
    preheader: content.preheader ?? content.intro,
    eyebrow: content.eyebrow,
    heading: content.heading,
    blocks: [
      { kind: 'text', text: content.intro },
      { kind: 'rows', rows: content.rows },
      {
        kind: 'button',
        label: content.button,
        link: content.link,
        fallback: content.fallback,
      },
    ],
    note: content.note,
    ...(content.signature === undefined ? {} : { signature: content.signature }),
    footer: content.footer,
  });
}
