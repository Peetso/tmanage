import { TOTP_FACTOR_KIND } from './credentials.repository.js';

/**
 * STEPUPFIX. Which of a person's factors re-authentication asks a code from — the one rule,
 * shared by `AuthenticationService.confirmReauthentication` (which enforces it) and every read
 * that tells a screen whether to show a code field (`/v1/platform/me`, `GET /v1/auth/factors`),
 * so the form can never ask for a code the server does not want, or leave out one it does.
 *
 * Only a confirmed authenticator (TOTP) factor counts (MFAOPTIONS). A person whose methods are
 * e-mail codes (and backup codes) re-authenticates with the password alone: the session already
 * passed their second step, and nothing mails a code for a re-authentication. Disabled rows never
 * reach here — every caller reads factors with `disabled_at is null`.
 */
export function reauthenticationCodeFactors<
  T extends { readonly kind: string; readonly confirmedAt: Date | null },
>(factors: readonly T[]): readonly T[] {
  return factors.filter(
    (factor) => factor.kind === TOTP_FACTOR_KIND && factor.confirmedAt !== null,
  );
}

/** STEPUPFIX. Whether re-authentication needs the 6-digit authenticator code next to the password. */
export function reauthenticationNeedsAuthenticatorCode(
  factors: readonly { readonly kind: string; readonly confirmedAt: Date | null }[],
): boolean {
  return reauthenticationCodeFactors(factors).length > 0;
}
