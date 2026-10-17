/**
 * Injection tokens for the first-owner setup module. Kept local to `modules/setup/` rather than
 * added to the shared `common/http/tokens.ts`, so this slice stays file-disjoint (ADR-0003: every
 * provider still carries an explicit token).
 */
export const FIRST_OWNER_SERVICE = Symbol.for('tmanage.FirstOwnerService');
export const FIRST_OWNER_ADMISSION = Symbol.for('tmanage.FirstOwnerAdmission');
export const FIRST_OWNER_SESSIONS = Symbol.for('tmanage.FirstOwnerSessions');
