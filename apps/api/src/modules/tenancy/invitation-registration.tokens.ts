/**
 * Injection tokens for the invitation-registration route (ACC-01). Kept local to
 * `modules/tenancy/`, as `first-owner.tokens.ts` is to `modules/setup/`.
 */
export const INVITATION_REGISTRATION_SESSIONS = Symbol.for(
  'tmanage.InvitationRegistrationSessions',
);
export const INVITATION_REGISTRATION_ADMISSION = Symbol.for(
  'tmanage.InvitationRegistrationAdmission',
);
