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
