'use client';

import { useCallback } from 'react';
import { useTOr } from '../../../lib/i18n/use-t-or';

/**
 * 52-26 — every e-sign line, keyed `Esign.<name>` in the catalogs. The English here is the
 * fallback `useTOr` shows until the catalog fragment is merged; after that the catalogs win.
 */
export const ESIGN_EN = {
  // Portal sign page (Figma 610:34405 / 610:34521)
  signTitle: 'Sign: {title}',
  askedYouToSign: '{agency} asked you to sign this document. Read it, then add your signature.',
  backToApprovals: 'Back to approvals',
  waitingForYou: 'Waiting for your signature',
  openDocument: 'Open the document',
  documentLabel: 'Document',
  yourSignature: 'Your signature',
  signatureMode: 'How to sign',
  modeType: 'Type',
  modeDraw: 'Draw',
  fullName: 'Full name',
  preview: 'Preview',
  padLabel: 'Signature pad. Draw your signature with a finger, pen or mouse.',
  padHint: 'Sign with your finger',
  padKeyboardHint: 'Using a keyboard? Choose Type instead.',
  clear: 'Clear',
  codeSentTo: 'We sent a 6-digit code to {email}',
  codeWillSendTo: 'We send a 6-digit code to {email} to check it is you.',
  sendCode: 'Send me a code',
  sendingCode: 'Sending the code',
  resendCode: "Didn't get it? Send a new code",
  codeSent: 'A new code is on its way.',
  codeTooSoon: 'You asked for a code a moment ago. Wait a minute, then try again.',
  signDocument: 'Sign document',
  signing: 'Signing',
  footer: 'Simple e-sign. You and {agency} both get the signed copy.',
  // Refusals
  codeWrong: 'That code is not right. Check the e-mail and try again.',
  codeLocked: 'Too many wrong tries. Ask for a new code.',
  codeMissing: 'Ask for a code first.',
  codeExpiredTitle: 'Code expired',
  codeExpiredBody: 'Codes last 10 minutes. We can send you a new one.',
  sendNewCode: 'Send a new code',
  signInvalid: 'Check your name or signature and try again.',
  documentChanged: 'The document changed after it was sent. Ask {agency} to send it again.',
  // States (611:34597 … 611:34651)
  signed: 'Signed',
  thankYou: 'Thank you, {name}. The document is signed.',
  signedOn: 'Signed on {date}. A signed copy is on its way to your e-mail.',
  alreadySigned: 'Already signed',
  alreadySignedBody: 'You signed this document on {date}. There is nothing more to do.',
  loading: 'Opening the document',
  couldNotOpen: "Couldn't open",
  couldNotOpenBody: 'Check your connection and try again. Nothing has been signed yet.',
  tryAgain: 'Try again',
  expiredTitle: 'This link has expired',
  expiredBody: 'Ask {agency} to send the document again.',
  cancelledTitle: 'This request was cancelled',
  cancelledBody: '{agency} no longer needs your signature on this document.',
  notFoundTitle: 'Nothing to sign here',
  notFoundBody: 'This signature request is not addressed to you, or it no longer exists.',
  // Portal list
  waitingListTitle: 'Waiting for your signature',
  waitingCard: 'Expires {date}',
  signNow: 'Sign',
  // Internal status page (611:34439)
  sentOn: 'Sent for signature on {sent} · link expires {expires}',
  signedCount: '{signed} of {total} signed',
  signers: 'Signers',
  anyOrder: 'Any signing order',
  signerSigned: 'Signed {date} · e-mail code checked',
  signerOpened: 'Opened {date} · not signed yet',
  signerNotOpened: 'Not opened yet',
  waiting: 'Waiting',
  showRecord: 'Show the signature record of {name}',
  recordTitle: 'Signature record · {name}',
  recordEmpty: 'Choose a signer who has signed to see their record.',
  email: 'E-mail',
  codeChecked: 'E-mail code checked',
  signedAt: 'Signed',
  signedFrom: 'Signed from',
  signedWith: 'Signature',
  methodTyped: 'Typed name: {name}',
  methodDrawn: 'Drawn by hand',
  unknown: 'Not recorded',
  fingerprint: 'Document fingerprint (SHA-256)',
  unchangedTitle: 'Document unchanged',
  unchangedBody: 'The file matches the version sent for signature.',
  mismatchTitle: 'Does not match',
  mismatchBody: 'The file or the record no longer matches what was signed.',
  cancelRequest: 'Cancel request',
  cancelling: 'Cancelling',
  remind: 'Remind {name}',
  reminding: 'Sending the reminder',
  reminded: 'Reminder sent.',
  remindTooSoon: 'A reminder already went out in the last 24 hours.',
  actionFailed: 'That did not work',
  stateCompleted: 'All signed',
  stateCancelled: 'Cancelled',
  stateExpired: 'Expired',
  statePending: 'Waiting for signatures',
  loadingRequest: 'Loading the signature request',
  backToDeliverable: 'Back to the deliverable',
  // Deliverable detail panel + sheet
  panelTitle: 'Signatures',
  panelEmpty: 'No signature requests for this version yet.',
  requestSignature: 'Request signature',
  sheetTitle: 'Request a signature',
  sheetIntro: 'The people you choose sign version {version} in the client portal.',
  chooseSigners: 'Who signs',
  noSigners: 'No client contacts on this project yet. Invite one first.',
  expiryDays: 'Link expires after (days)',
  expiryHint: 'Between 1 and 30 days.',
  titleLabel: 'Title (optional)',
  cancel: 'Cancel',
  send: 'Send for signature',
  sending: 'Sending',
  sendFailed: 'Could not send for signature',
} as const;

export type EsignKey = keyof typeof ESIGN_EN;

/** `t(key, vars)` over the e-sign lines; `{name}` placeholders are filled from `vars`. */
export function useEsignT(): (key: EsignKey, vars?: Readonly<Record<string, string>>) => string {
  const tOr = useTOr();
  return useCallback(
    (key: EsignKey, vars?: Readonly<Record<string, string>>) => {
      let text = tOr(`Esign.${key}`, ESIGN_EN[key]);
      for (const [name, value] of Object.entries(vars ?? {})) {
        text = text.split(`{${name}}`).join(value);
      }
      return text;
    },
    [tOr],
  );
}
