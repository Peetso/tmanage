/**
 * The one password-length policy (AR-8 "one decision, one place"; DC-2). The API's screen
 * (`apps/api/src/modules/identity/password.ts`) and every web form that sets a password read it
 * from here; nobody keeps a copy.
 *
 * Source: NIST SP 800-63B-4 (final, 2025-07-31; ENGINEERING-STANDARD source S19), §3.1.1.2
 * Password Verifiers, items 1-2:
 * - passwords "used as a single-factor authentication mechanism" SHALL be at least 15
 *   characters; only passwords used solely inside multi-factor authentication MAY be as short as
 *   8. Two-step sign-in is optional per workspace here, so a TManage password can be the only
 *   factor: the floor is **15**.
 * - verifiers SHOULD permit at least 64 characters; the 256 ceiling only stops a megabyte
 *   password from becoming a denial of service.
 * - no composition rules (same section): length, not symbols.
 *
 * The floor applies when a password is chosen (sign-up, invitation, first owner, reset, change).
 * Sign-in never checks length, so an existing shorter password keeps working until it is changed.
 */
export const PASSWORD_POLICY = { minLength: 15, maxLength: 256 } as const;

/**
 * Length as the policy counts it: Unicode code points after NFKC (the form the API hashes), so
 * an emoji is one character and a decomposed accent is not two.
 */
export function passwordLength(password: string): number {
  return [...password.normalize('NFKC')].length;
}

export function passwordTooShort(password: string): boolean {
  return passwordLength(password) < PASSWORD_POLICY.minLength;
}
