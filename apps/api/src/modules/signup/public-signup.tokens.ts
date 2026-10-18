/**
 * Injection tokens for the public sign-up module, kept local to `modules/signup/` as
 * `first-owner.tokens.ts` is to `modules/setup/` (ADR-0003: every provider has a token).
 */
export const PUBLIC_SIGNUP_SERVICE = Symbol.for('tmanage.PublicSignupService');
export const PUBLIC_SIGNUP_SESSIONS = Symbol.for('tmanage.PublicSignupSessions');
/** Per source address. */
export const PUBLIC_SIGNUP_ADMISSION = Symbol.for('tmanage.PublicSignupAdmission');
/** Per email address — a rotating-IP script still meets this one. */
export const PUBLIC_SIGNUP_EMAIL_ADMISSION = Symbol.for('tmanage.PublicSignupEmailAdmission');
