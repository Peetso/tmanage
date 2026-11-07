import { authBoundary } from '../../lib/auth-boundary';

/**
 * The organization slugs this browser has seen in the session's own organization list (B16).
 *
 * The API answers an organization the session does not belong to the same way whether the person
 * was removed from it or never belonged to it — and whether it exists at all — so the client cannot
 * ask. What it can know is its own history: an organization that was in this browser's list and is
 * now absent is a removed membership; one it has never seen (a mistyped slug, `/admin` without an
 * organization in front) is simply not found. Deciding that from local history keeps the API from
 * confirming that an unknown slug exists.
 *
 * The record is per browser, holds slugs only, and is dropped at every change of principal
 * (`authBoundary`), so the next person on a shared browser starts with no history of the last.
 */
const STORAGE_KEY = 'tmanage.shell.knownOrganizations';
/** A bound on what is kept: far above any real membership count, small enough to never matter. */
const LIMIT = 200;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null; // Storage disabled by the browser: behave as a browser with no history.
  }
}

function read(): string[] {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((slug) => typeof slug === 'string') : [];
  } catch {
    return [];
  }
}

/** Adds every slug of a loaded organization list to this browser's history. */
export function rememberOrganizations(slugs: readonly string[]): void {
  const known = read();
  if (slugs.every((slug) => known.includes(slug))) return;
  const next = [...new Set([...known, ...slugs])].slice(-LIMIT);
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A full or blocked storage only loses the distinction, never access.
  }
}

/** True when this browser saw the slug in an earlier organization list. */
export function wasKnownOrganization(slug: string): boolean {
  return read().includes(slug);
}

export function forgetOrganizations(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored, nothing to forget.
  }
}

if (typeof window !== 'undefined') authBoundary.subscribe(() => forgetOrganizations());
