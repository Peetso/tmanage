import { ApiRequestError, NetworkError } from '../../lib/api/errors';

/**
 * Small helpers the People screens (PEO-01..04, heatmap, org chart) share. Kept beside the screens
 * rather than in `lib/` because they are presentation only: initials for the design's avatar orbs,
 * and the one sentence a refusal or outage becomes.
 */

/** "Omar Adel" → "OA"; a single name gives its first two letters; empty gives "?". */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`.toUpperCase();
}

/** "Omar Adel" → "Omar". */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
export function describePeopleError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}
