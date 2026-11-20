import { PASSWORD_POLICY } from '@tmanage/domain';
import type { MessageKey } from './i18n/t';

/**
 * Whether public sign-up is offered, as the website's links see it.
 *
 * `NEXT_PUBLIC_SIGNUP` is `PUBLIC_SIGNUP` inlined by `next.config.ts` (default `on`); the literal
 * `process.env['NEXT_PUBLIC_SIGNUP']` read is what lets Next inline it. The API enforces the switch
 * itself (its routes 404 when off), and `/sign-up` checks the API at runtime, so this only
 * decides where the marketing buttons point.
 */
export function isPublicSignupOffered(
  value: string | undefined = process.env['NEXT_PUBLIC_SIGNUP'],
): boolean {
  return !['off', 'false', '0', 'no'].includes((value ?? 'on').trim().toLowerCase());
}

/** Where "Start free" / "Get started" go: the sign-up form, or sign-in when sign-up is off. */
export const SIGN_UP_HREF: '/sign-up' | '/sign-in' = isPublicSignupOffered()
  ? '/sign-up'
  : '/sign-in';

/**
 * The `GettingIn.*` keys the invitation and Start free screens use (slice P1). They arrive in
 * `en.json`/`ar.json` through the wave's i18n fragment, so they are listed here and widened to
 * `MessageKey` in one place rather than cast at every call site.
 */
export type GettingInKey = `GettingIn.${
  | 'invitedLine'
  | 'createTitle'
  | 'joiningAs'
  | 'joinTitle'
  | 'joiningAsExisting'
  | 'workEmail'
  | 'fromInvitation'
  | 'fullName'
  | 'password'
  | 'passwordHint'
  | 'confirmPassword'
  | 'confirmPlaceholder'
  | 'agree'
  | 'createAndJoin'
  | 'creatingAccount'
  | 'accept'
  | 'accepting'
  | 'signInInstead'
  | 'expiresOn'
  | 'nameMissing'
  | 'emailMissing'
  | 'organizationMissing'
  | 'passwordShort'
  | 'passwordMismatch'
  | 'mustAgree'
  | 'fieldsNeedAttention'
  | 'freePlan'
  | 'startTitle'
  | 'startLede'
  | 'organizationName'
  | 'organizationHint'
  | 'createWorkspace'
  | 'creatingWorkspace'
  | 'checkEmailTitle'
  | 'checkEmailBody'
  | 'openWorkspace'}`;

/**
 * Look a `GettingIn.*` key up through the screen's `t` and fill its `{name}` placeholders. The
 * placeholders keep word order in the catalog, where Arabic needs it different from English.
 * `{min}` is always the shared password floor (`PASSWORD_POLICY`, AR-8).
 */
export function gettingIn(
  t: (key: MessageKey) => string,
  key: GettingInKey,
  values: Readonly<Record<string, string>> = {},
): string {
  const filled: Readonly<Record<string, string>> = {
    min: String(PASSWORD_POLICY.minLength),
    ...values,
  };
  return t(key as string as MessageKey).replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(filled, name) ? (filled[name] ?? match) : match,
  );
}
