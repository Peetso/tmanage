'use client';

import Link from 'next/link';
import { hasCapability, isInternalRole } from '@tmanage/domain';
import { useTOr } from '../../lib/i18n/use-t-or';
import { importPagePath } from '../../lib/import-link';
import type { ApiClient } from '../../lib/api/client';
import { useOrganizationSummary } from './NewProjectLink';

/**
 * IMPORTLINK (54-29) — the way into the in-app Import page, beside "New project" on the project
 * portfolio: where someone bringing work over from another tool looks for it.
 *
 * Shown only to a role whose ceiling holds `org.manage` — the capability every import route
 * requires — so it never offers a page whose every action the API would refuse.
 */
export function canImport(role: string | undefined): boolean {
  if (role === undefined || !isInternalRole(role)) return false;
  return hasCapability(role, 'org.manage');
}

export function ImportLink({
  organizationSlug,
  client,
}: {
  readonly organizationSlug: string;
  readonly client?: ApiClient;
}) {
  const tOr = useTOr();
  const allowed = canImport(useOrganizationSummary(organizationSlug, client)?.role);
  if (!allowed) return null;
  return (
    <Link
      href={importPagePath(organizationSlug)}
      className="tm-button tm-button--outline tm-button--compact"
    >
      {tOr('ImportLink.label', 'Import')}
    </Link>
  );
}
