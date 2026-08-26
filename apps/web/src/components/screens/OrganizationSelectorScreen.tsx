'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Badge, InlineAlert, SearchField, StatusDot } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { BackendPending } from './BackendPending';

export interface OrganizationChoice {
  readonly slug: string;
  readonly name: string;
  readonly audience: 'internal' | 'client';
  /** The person's role in this organization, as the membership resolver reports it. */
  readonly roleName: string;
  readonly projectCount: number;
  readonly lastUsed?: boolean;
}

export interface OrganizationSelectorScreenProps {
  organizations: readonly OrganizationChoice[];
}

/**
 * **ID-04 Organization selector.**
 *
 * `22-SCREEN-BY-SCREEN` §3: "Searchable organizations with internal/client badge and last
 * opened. No cross-organization aggregated content in MVP."
 *
 * The second sentence is the one with teeth, and this screen is where it is either kept or
 * lost. Nothing here sums, counts across, or ranks by anything that spans two organizations:
 * the project count belongs to one organization and is rendered inside that organization's
 * row. A "12 open items across your organizations" line would be a cross-tenant aggregate,
 * and `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC` has no scope that could produce it safely.
 *
 * Filtering happens in the browser over the list the server already returned. That is not a
 * shortcut around a search endpoint — it is the correct behaviour for a list this size, and
 * it means typing here sends nothing anywhere. A person's organization memberships are
 * exactly the sort of thing that should not be streamed to a server keystroke by keystroke.
 *
 * There is no endpoint yet. `MembershipResolver` resolves a slug the caller already knows;
 * "list the organizations this person belongs to" is TEN-001's unbuilt half, so the list is
 * passed in and the screen says where it came from.
 */
export function OrganizationSelectorScreen({ organizations }: OrganizationSelectorScreenProps) {
  const [query, setQuery] = useState('');

  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (needle === '') return organizations;
    return organizations.filter((organization) =>
      organization.name.toLocaleLowerCase().includes(needle),
    );
  }, [organizations, query]);

  return (
    <IdentityShell screenId="ID-04" eyebrow="Choose where you are working">
      <div className="tm-stack tm-stack--tight">
        <h1 className="tm-identity__title">
          {organizations.length === 1
            ? 'One organization uses your email'
            : `${organizations.length} organizations use your email`}
        </h1>
      </div>

      <BackendPending ticket="TEN-001">
        There is no endpoint that lists a person&rsquo;s organizations yet. This list is passed in
        by the page.
      </BackendPending>

      <SearchField
        label="Search organizations"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search organizations"
      />

      {matches.length === 0 ? (
        <InlineAlert tone="neutral" live>
          No organization matches “{query}”.
        </InlineAlert>
      ) : (
        <ul className="tm-stack tm-list">
          {matches.map((organization) => (
            <li key={organization.slug}>
              <Link className="tm-panel tm-choice-row" href={`/${organization.slug}/home`}>
                <span className="tm-choice-row__name">{organization.name}</span>
                <span className="tm-choice-row__meta">
                  <Badge tone={organization.audience === 'client' ? 'client' : 'neutral'}>
                    {organization.audience === 'client' ? 'Client organization' : 'Internal member'}
                  </Badge>
                  <span className="tm-prose">
                    {organization.roleName} ·{' '}
                    {organization.projectCount === 1
                      ? '1 project'
                      : `${organization.projectCount} projects`}
                  </span>
                  {organization.lastUsed === true ? (
                    <StatusDot tone="live">Last used</StatusDot>
                  ) : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <InlineAlert tone="neutral">
        Each organization is a separate space. Nothing is shared between them — not search, not
        files, not notifications.
      </InlineAlert>
    </IdentityShell>
  );
}
