import { cookies, headers } from 'next/headers';
import type { DisplayLocale } from '../api/display-preferences';
import { LANG_REQUEST_HEADER, LOCALE_COOKIE_NAME, resolveServerLocale } from './locale-cookie';

/**
 * The locale this request renders in, for server components and `generateMetadata`: an
 * allowlisted `?lang=` (put in {@link LANG_REQUEST_HEADER} by `proxy.ts`), else the saved-locale
 * cookie, else the shipped default. Reading the request makes the page dynamic, so Next marks its
 * HTML `private, no-store` and no shared cache can hand one visitor's language to another.
 */
export async function serverLocale(): Promise<DisplayLocale> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return resolveServerLocale({
    lang: headerStore.get(LANG_REQUEST_HEADER),
    cookie: cookieStore.get(LOCALE_COOKIE_NAME)?.value,
  });
}
