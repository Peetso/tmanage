/**
 * Row 55-16 — which help article a signed-in screen's "?" link opens.
 *
 * Patterns are matched against the app path after the workspace slug (`/acme/finance/timesheets`
 * → `/finance/timesheets`); the longest matching prefix wins, so a specific screen can point at a
 * different article than its area. Screens with no entry get no "?" link.
 */
const CONTEXT: readonly (readonly [string, string])[] = [
  ['/home', 'create-your-workspace'],
  ['/onboarding', 'create-your-workspace'],
  ['/people', 'invite-your-team'],
  ['/projects', 'start-a-project'],
  ['/projects/templates', 'start-a-project'],
  ['/projects/:id/milestones', 'milestones-and-dates'],
  ['/projects/:id/portal-access-log', 'what-clients-see'],
  ['/work', 'create-and-assign-tasks'],
  ['/work/:id', 'task-approval'],
  ['/clients', 'invite-a-client'],
  ['/portal', 'what-clients-see'],
  ['/files', 'upload-and-share-files'],
  ['/admin/storage', 'connect-drive-onedrive'],
  ['/finance', 'invoices-and-expenses'],
  ['/finance/timesheets', 'log-time-timesheets'],
  ['/finance/expenses', 'invoices-and-expenses'],
  ['/finance/invoices', 'invoices-and-expenses'],
  ['/billing/invoices', 'invoices-and-expenses'],
  ['/admin/security', 'two-step-sign-in'],
  ['/admin/sessions', 'sessions-and-devices'],
];

/** Top-level routes that are not a workspace slug. */
const NOT_A_WORKSPACE = new Set(['sessions', 'platform', 'onboarding', 'setup', 'organizations']);

function matches(pattern: string, segments: readonly string[]): boolean {
  const parts = pattern.split('/').filter(Boolean);
  if (parts.length > segments.length) return false;
  return parts.every((p, i) => p === ':id' || p === segments[i]);
}

/** The help article slug for an app pathname, or `undefined` when the screen has none. */
export function helpSlugForPath(pathname: string | null | undefined): string | undefined {
  if (typeof pathname !== 'string') return undefined;
  const all = pathname.split(/[?#]/)[0]!.split('/').filter(Boolean);
  if (all[0] === 'sessions') return 'sessions-and-devices';
  if (all.length === 0 || NOT_A_WORKSPACE.has(all[0]!)) return undefined;
  const segments = all.slice(1);
  let best: { slug: string; length: number } | undefined;
  for (const [pattern, slug] of CONTEXT) {
    const length = pattern.split('/').filter(Boolean).length;
    if (matches(pattern, segments) && (!best || length > best.length)) best = { slug, length };
  }
  return best?.slug;
}
