import type { MessageKey } from '../i18n/t';
import { ApiRequestError } from './errors';

/**
 * Sign-in and sign-up refusals in the reader's language (`/ar/sign-in`, `/ar/sign-up`).
 *
 * The API words its refusals in English, and the English screens show them verbatim — except a
 * 401, which is the catalog's credentials line in every language (QA-FIX-P S10). A reader in
 * another language gets the catalog line for every refusal's status instead, so an Arabic screen
 * never shows an English sentence — and still cannot tell an unknown address from a wrong
 * password, because every 401 gets the same line.
 */

/** True when the API's own (English) words can be shown as they are. */
export function readsApiLanguage(locale: string): boolean {
  return (locale.split('-')[0] ?? '').toLowerCase() === 'en';
}

/**
 * The catalog line for an API refusal, or `undefined` when the API's own message should be shown
 * (an English reader) or the failure is not an API refusal (a network failure is already
 * translated by `describeApiError`).
 */
export function refusalLine(error: unknown, locale: string): MessageKey | undefined {
  if (!(error instanceof ApiRequestError)) return undefined;
  // QA-FIX-P S10: the API answers bad credentials with its generic session sentence ("The
  // request carries no valid session"), which read like a broken page rather than a wrong
  // password. Every 401 is one plain line in every language, English included — still the same
  // line for an unknown address and a wrong password (OWASP Authentication Cheat Sheet,
  // "Authentication Responses": a generic "invalid user ID or password").
  if (error.status === 401) return 'AuthRefusal.invalidCredentials';
  if (readsApiLanguage(locale)) return undefined;
  if (error.status === 429) return 'signUp.rateLimited';
  if (error.status === 400 || error.status === 422) return 'signUp.fieldsNeedAttention';
  return 'signUp.generic';
}
