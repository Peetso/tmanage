'use client';

import { useCallback } from 'react';
import { useTOr } from '../i18n/use-t-or';
import { ApiRequestError, NetworkError } from './errors';

/** The catalog lookup this helper needs: `useTOr()`'s shape (key, English fallback). */
export type TranslateOr = (key: string, english: string) => string;

/** The English text of the two shared error lines; the catalog keys carry the translations. */
export const API_ERROR_NETWORK_DOWN_EN = 'The API did not answer. Is it running?';
export const API_ERROR_GENERIC_EN = 'Something went wrong. Try again.';

/**
 * The one sentence a screen shows for a failed API call, in the active language.
 *
 * A refusal the API answered with keeps the server's own message (the API already words it for
 * the member). A request that never got an answer, and anything else, use the shared catalog lines
 * `ApiError.networkDown` and `ApiError.generic`, so an Arabic screen never shows English here.
 */
export function describeApiError(error: unknown, t: TranslateOr): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('ApiError.networkDown', API_ERROR_NETWORK_DOWN_EN);
  return t('ApiError.generic', API_ERROR_GENERIC_EN);
}

/** `describeApiError` bound to the active locale, for use inside a component. */
export function useDescribeApiError(): (error: unknown) => string {
  const tOr = useTOr();
  return useCallback((error: unknown) => describeApiError(error, tOr), [tOr]);
}
