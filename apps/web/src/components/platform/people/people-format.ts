/**
 * platform-admin v2 · PA-06 — small, pure helpers the People screens share (B1–B4).
 */

/** "Maya Hassan" → "MH"; one word → its first two letters. */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== '');
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0] ?? '?').slice(0, 2).toUpperCase();
  return `${(words[0] ?? '').charAt(0)}${(words[words.length - 1] ?? '').charAt(0)}`.toUpperCase();
}

/** The first name, for the sentences that speak about the person ("Maya's sessions"). */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/u)[0] ?? name;
}

/** "21 Oct" / "21 Oct 2025" (another year), in the viewer's language. */
export function shortDay(iso: string | null, locale: string, now = new Date()): string {
  if (iso === null) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).format(at);
}

/** "27 Oct 10:12". */
export function dayAndTime(iso: string | null, locale: string): string {
  if (iso === null) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);
}

/** "12 Aug 2026". */
export function fullDay(iso: string | null, locale: string): string {
  if (iso === null) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(at);
}

/**
 * A readable device from a user agent: "Chrome · Windows", "Safari · iPhone". Never the whole
 * string — the session table has a column, not a paragraph.
 */
export function deviceOf(userAgent: string | null): string {
  if (!userAgent) return '—';
  const browser = /Edg\//u.test(userAgent)
    ? 'Edge'
    : /Firefox\//u.test(userAgent)
      ? 'Firefox'
      : /Chrome\//u.test(userAgent)
        ? 'Chrome'
        : /Safari\//u.test(userAgent)
          ? 'Safari'
          : /TManage/iu.test(userAgent)
            ? 'TManage app'
            : null;
  const system = /iPhone/u.test(userAgent)
    ? 'iPhone'
    : /iPad/u.test(userAgent)
      ? 'iPad'
      : /Android/u.test(userAgent)
        ? 'Android'
        : /Mac OS X|Macintosh/u.test(userAgent)
          ? 'macOS'
          : /Windows/u.test(userAgent)
            ? 'Windows'
            : /Linux/u.test(userAgent)
              ? 'Linux'
              : null;
  if (browser && system) return `${browser} · ${system}`;
  return browser ?? system ?? userAgent.slice(0, 40);
}

/** The ISO day `days` before `now` (the "Signed in: last 30 days" filter). */
export function daysAgoIso(days: number, now = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/** A short user id for the crumb: "USER 3f9c1e2a". */
export function shortId(id: string): string {
  return id.replace(/-/gu, '').slice(0, 8);
}

export const BUILT_IN_ROLES = [
  'owner',
  'org_admin',
  'workspace_admin',
  'manager',
  'moderator',
  'member',
  'guest',
] as const;
export const CLIENT_ROLES = [
  'client_admin',
  'client_reviewer',
  'client_member',
  'client_viewer',
] as const;
