'use client';

import { useCallback } from 'react';
import { activeLocale } from '../i18n/locale-store';
import { translate, type MessageKey } from '../i18n/t';
import { useTOr } from '../i18n/use-t-or';
import { ApiRequestError, NetworkError } from './errors';

/** The catalog lookup this helper needs: `useTOr()`'s shape (key, English fallback). */
export type TranslateOr = (key: string, english: string) => string;

/** The English text of the shared error lines; the catalog keys carry the translations. */
export const API_ERROR_NETWORK_DOWN_EN = 'The API did not answer. Is it running?';
export const API_ERROR_GENERIC_EN = 'Something went wrong. Try again.';
export const API_ERROR_OFFLINE_EN =
  'We could not reach TManage. Check your connection and try again.';
export const API_ERROR_PORTAL_DOWN_EN = 'The portal is not answering. Try again shortly.';
export const API_ERROR_STATUS_DOWN_EN = 'The status service did not answer. Try again shortly.';

/** A catalog key and the English line shown until the key is in the catalogs. */
export type CatalogLine = readonly [key: string, english: string];

/**
 * The lines a screen shows instead of the shared defaults. Each one is still a catalog key, so a
 * screen can word its network failure for its own audience (the client portal, the status page)
 * without ever hard-coding English. Declare it once at module level so the hook's callback is stable.
 */
export interface ApiErrorLines {
  network?: CatalogLine;
  generic?: CatalogLine;
}

/** "We could not reach TManage…" — for member screens whose request never got an answer. */
export const OFFLINE_LINES: ApiErrorLines = {
  network: ['ApiError.offline', API_ERROR_OFFLINE_EN],
};
/** "The portal is not answering…" — for the client portal's screens. */
export const PORTAL_LINES: ApiErrorLines = {
  network: ['ApiError.portalDown', API_ERROR_PORTAL_DOWN_EN],
};
/** "The status service did not answer…" — for the public status page. */
export const STATUS_LINES: ApiErrorLines = {
  network: ['ApiError.statusDown', API_ERROR_STATUS_DOWN_EN],
};

const NETWORK_DOWN: CatalogLine = ['ApiError.networkDown', API_ERROR_NETWORK_DOWN_EN];
const GENERIC: CatalogLine = ['ApiError.generic', API_ERROR_GENERIC_EN];

/**
 * The one sentence a screen shows for a failed API call, in the active language.
 *
 * A refusal the API answered with keeps the server's own message (the API already words it for
 * the member). A request that never got an answer, and anything else, use the shared catalog lines
 * `ApiError.networkDown` and `ApiError.generic` (or the screen's own `lines`), so an Arabic screen
 * never shows English here.
 */
export function describeApiError(error: unknown, t: TranslateOr, lines?: ApiErrorLines): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t(...(lines?.network ?? NETWORK_DOWN));
  return t(...(lines?.generic ?? GENERIC));
}

/**
 * `describeApiError` in the locale active right now, for a shared helper that is not a hook (it is
 * called during render, so a locale change re-renders it with the new language). Components use
 * {@link useDescribeApiError}.
 */
export function describeApiErrorNow(error: unknown, lines?: ApiErrorLines): string {
  const locale = activeLocale.get();
  const tOr: TranslateOr = (key, english) => {
    const value = translate(locale, key as MessageKey);
    return value === key ? english : value;
  };
  return describeApiError(error, tOr, lines);
}

/** `describeApiError` bound to the active locale, for use inside a component. */
export function useDescribeApiError(lines?: ApiErrorLines): (error: unknown) => string {
  const tOr = useTOr();
  return useCallback((error: unknown) => describeApiError(error, tOr, lines), [tOr, lines]);
}
