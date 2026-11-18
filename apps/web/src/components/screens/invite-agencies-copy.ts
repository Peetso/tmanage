/**
 * 57-08 REFERRAL — Settings › People › Invite agencies, English copy (`InviteAgencies.*`, Figma
 * 724:39791; review copy table C). Arabic and the other locales come from the catalogs.
 */
export const INVITE_AGENCIES_COPY = {
  navLabel: 'Invite agencies',
  title: 'Invite other agencies',
  lead: 'Share your link with agencies you know. You see which ones signed up through it.',
  linkHeading: 'Your invite link',
  linkHint: 'Anyone who opens this link can sign up. It does not let them into your workspace.',
  copy: 'Copy link',
  copied: 'Copied',
  copyFailed: 'The link was not copied. Select it and copy it yourself.',
  preparing: 'Preparing your link',
  statLabel: 'Agencies signed up',
  listHeading: 'Agencies that signed up through your link',
  signedUp: 'Signed up',
  empty: 'No agency has signed up through your link yet.',
  selfNote: 'If you sign up yourself through your own link, it is not counted.',
  rewardsRecorded: 'Account credit recorded: {count}',
  ownerOnly: 'Only the workspace owner can use the invite link.',
  loadFailed: 'Your invite link did not load. Try again.',
  retry: 'Try again',
} as const;

export type InviteAgenciesCopyKey = keyof typeof INVITE_AGENCIES_COPY;
