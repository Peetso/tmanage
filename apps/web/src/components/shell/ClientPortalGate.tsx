'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useOrganizationAudience } from '../../lib/use-organization-names';

/** The portal home of a workspace: where a client member of it belongs. */
export function portalHomePath(organizationSlug: string): string {
  return `/${encodeURIComponent(organizationSlug)}/portal`;
}

/**
 * T5 F7: a client (portal member) who opens a staff address — a copied `/projects/{id}`, a typed
 * `/home` — got the staff shell: the project tab row, "Post update", a "try again" that never
 * worked, or skeletons that never finished. The API already refuses every staff read (403/404),
 * so nothing leaked, but the shell itself is staff UI.
 *
 * Every staff screen draws `AppShell`, and the shell mounts this one gate, so no page checks for
 * itself. It reads the caller's side from the session's own organization list (the read the
 * other shell gates share, one request); once that says `client`, nothing of the shell renders
 * and the browser goes to the portal home. The portal has no per-project twin, so every staff
 * address lands there. Until the list is read the app renders as before, like the other gates.
 */
export function ClientPortalGate({
  organizationSlug,
  children,
}: {
  organizationSlug: string;
  children: ReactNode;
}) {
  const audience = useOrganizationAudience(organizationSlug);
  if (audience === 'client') return <PortalRedirect href={portalHomePath(organizationSlug)} />;
  return <>{children}</>;
}

/** Separate so `useRouter` runs only on a redirect, never on a pass-through (bare renders). */
function PortalRedirect({ href }: { href: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(href);
  }, [router, href]);
  return null;
}
