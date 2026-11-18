import { inviteLinkFor } from './api/referrals';
import { localizeHref } from './i18n/public-locale-routes';
import { languageOf } from './i18n/t';

/**
 * TESTUX P1 12: the owner's invite link opens sign-up in the owner's language where the page has
 * a twin in it (an Arabic owner's link opened the English sign-up). Kept out of `lib/api/` so the
 * API shapes module stays free of the routing and catalog imports.
 */
export function localizedInviteLink(origin: string, code: string, locale: string): string {
  const signUp = '/sign-up';
  return inviteLinkFor(origin, code, languageOf(locale) === 'ar' ? localizeHref(signUp) : signUp);
}
