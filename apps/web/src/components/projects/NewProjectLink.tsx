'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { hasCapability, isInternalRole } from '@tmanage/domain';
import { browserApiClient } from '../../lib/api/browser-client';
import { listOrganizations } from '../../lib/api/organizations';
import type { OrganizationSummary } from '../../lib/api/organizations';
import type { ApiClient } from '../../lib/api/client';

/**
 * **The way into "create a project" from inside the app.**
 *
 * Before this, the only screen that created a project was onboarding's ON-03, reachable once,
 * right after an organization was made. An owner who skipped it — or who wanted a second
 * project — met "No project to capture into" with nothing to press. Every surface that needs a
 * project now offers this link, which lands on `/[orgSlug]/projects/new`.
 *
 * The link shows only to a role whose ceiling holds `project.create` (owner, org admin,
 * workspace admin, manager). The API still decides (`@RequireCapability('project.create')`,
 * and organization policy may narrow a manager), so this hides an offer the API would refuse
 * rather than granting anything.
 */

/** The role ceiling check, pure so it is provable without a render. */
export function canCreateProjects(role: string | undefined): boolean {
  if (role === undefined || !isInternalRole(role)) return false;
  return hasCapability(role, 'project.create');
}

/** The caller's membership row for this organization, from the session's organization list. */
export function useOrganizationSummary(
  organizationSlug: string,
  client?: ApiClient,
): OrganizationSummary | undefined {
  const organizations = useQuery({
    queryKey: ['shell', 'organizations'],
    queryFn: () => listOrganizations(client ?? browserApiClient()),
    staleTime: 5 * 60_000,
  });
  return organizations.data?.find((org) => org.slug === organizationSlug);
}

export function useCanCreateProjects(organizationSlug: string, client?: ApiClient): boolean {
  return canCreateProjects(useOrganizationSummary(organizationSlug, client)?.role);
}

export interface NewProjectLinkProps {
  readonly organizationSlug: string;
  readonly client?: ApiClient;
  /** Defaults to "New project". */
  readonly label?: string;
  readonly tone?: 'ink' | 'lime' | 'outline';
  readonly size?: 'compact' | 'default';
  readonly className?: string;
}

/** A design-system button-styled link to the create-project screen; nothing if not allowed. */
export function NewProjectLink({
  organizationSlug,
  client,
  label = 'New project',
  tone = 'ink',
  size = 'compact',
  className,
}: NewProjectLinkProps) {
  const allowed = useCanCreateProjects(organizationSlug, client);
  if (!allowed) return null;
  const classes = ['tm-button', `tm-button--${tone}`, `tm-button--${size}`, className]
    .filter(Boolean)
    .join(' ');
  return (
    <Link href={`/${organizationSlug}/projects/new`} className={classes}>
      {label}
    </Link>
  );
}
