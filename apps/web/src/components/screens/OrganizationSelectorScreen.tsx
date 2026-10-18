'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, SearchField, Skeleton } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listOrganizations, type OrganizationSummary } from '../../lib/api/organizations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/identity.css';

export interface OrganizationSelectorScreenProps {
  client?: ApiClient;
}

/**
 * **ID-04 Organization selector.**
 *
 * `22-SCREEN-BY-SCREEN` §3: "Searchable organizations with internal/client badge and last
 * opened. **No cross-organization aggregated content in MVP.**"
 *
 * The list is real as of TEN-001's second half. The second sentence is the one with teeth,
 * and it is kept in two places rather than one: the API's `OrganizationDirectoryRepository`
 * cannot produce a cross-tenant aggregate — `work_items` is not in its declared table list,
 * so the guard would refuse the read — and this screen renders nothing that spans rows. Every
 * value on a row belongs to that row's organization.
 *
 * ## Filtering happens here, and that is the right place
 *
 * Not a shortcut around a search endpoint. A person's organizations are a handful of rows the
 * server has already sent, and typing here therefore sends nothing anywhere — which matters,
 * because the list of organizations someone belongs to is exactly the sort of thing that
 * should not be streamed to a server keystroke by keystroke.
 *
 * ## Two states that are not errors
 *
 * **Empty** is what every person sees between signing up and creating their first
 * organization. It gets its own copy and a link to `ON-01`, not an error.
 *
 * **One** organization still renders the list rather than redirecting into it. Skipping the
 * screen would be convenient and would also mean a person with one organization never sees
 * that they can create another — and would make the "last opened" affordance the
 * specification asks for unreachable.
 */
export function OrganizationSelectorScreen({ client }: OrganizationSelectorScreenProps) {
  const api = client ?? browserApiClient();
  const [query, setQuery] = useState('');

  const organizations = useQuery({
    queryKey: ['organizations'],
    queryFn: () => listOrganizations(api),
  });

  const matches = useMemo(() => {
    const rows = organizations.data ?? [];
    const needle = query.trim().toLocaleLowerCase();
    if (needle === '') return rows;
    return rows.filter((organization) => organization.name.toLocaleLowerCase().includes(needle));
  }, [organizations.data, query]);

  return (
    <IdentityShell screenId="ID-04" eyebrow="Choose where you are working">
      <div className="tm-id-bare tm-id-orgs tm-stack">
        <h1 className="tm-identity__title">{heading(organizations.data)}</h1>

        {organizations.isPending ? (
          <LoadingRegion label="Loading your organizations." className="tm-stack tm-stack--tight">
            <Skeleton height="88px" />
            <Skeleton height="88px" />
          </LoadingRegion>
        ) : null}

        {organizations.isError ? (
          <InlineAlert tone="danger" title="Could not load your organizations" live>
            {describe(organizations.error)}
          </InlineAlert>
        ) : null}

        {organizations.isSuccess && organizations.data.length === 0 ? (
          <div className="tm-id-card">
            <InlineAlert tone="neutral" title="You are not in an organization yet">
              An organization is the space your team works in. Create one and you become its owner.
            </InlineAlert>
            <div className="tm-row">
              <Link
                className="tm-button tm-button--ink tm-button--accessible"
                href="/onboarding/organization"
              >
                Create an organization
              </Link>
            </div>
          </div>
        ) : null}

        {organizations.isSuccess && organizations.data.length > 0 ? (
          <>
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
              <ul className="tm-id-org-list">
                {matches.map((organization) => {
                  const isClient = organization.audience === 'client';
                  const name =
                    isClient && organization.clientOrganizationName
                      ? organization.clientOrganizationName
                      : organization.name;
                  return (
                    <li key={`${organization.id}-${organization.audience}`}>
                      <Link
                        className={isClient ? 'tm-id-org tm-id-org--client' : 'tm-id-org'}
                        href={
                          isClient ? `/${organization.slug}/portal` : `/${organization.slug}/home`
                        }
                      >
                        <span className="tm-id-org__orb" aria-hidden="true">
                          {initials(name)}
                        </span>
                        <span className="tm-id-org__text">
                          <span className="tm-id-org__name">{name}</span>
                          <span className="tm-id-org__meta">
                            <span>{isClient ? 'Client portal' : 'Internal member'}</span>
                            {' · '}
                            <span>{humanise(organization.role)}</span>
                            {isClient ? (
                              <>
                                {' · '}
                                <span>Delivered by {organization.name}</span>
                              </>
                            ) : null}
                          </span>
                        </span>
                        {isClient ? <span className="tm-id-org__chip">portal mode</span> : null}
                        <span className="tm-id-org__go" aria-hidden="true">
                          →
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        ) : null}

        <InlineAlert className="tm-id-footnote" tone="neutral">
          Each organization is a separate space. Nothing is shared between them — not search, not
          files, not notifications.
        </InlineAlert>
      </div>
    </IdentityShell>
  );
}

/** Two letters for the orb: the first letters of the first two words, or the first two letters. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length >= 2 ? `${words[0]!.charAt(0)}${words[1]!.charAt(0)}` : name.trim().slice(0, 2);
  return letters.toLocaleUpperCase();
}

function heading(organizations: readonly OrganizationSummary[] | undefined): string {
  if (!organizations) return 'Choose where you are working';
  if (organizations.length === 0) return 'Nowhere to go yet';
  if (organizations.length === 1) return 'One organization uses your email';
  return `${organizations.length} organizations use your email`;
}

/** `client_reviewer` reads as "Client reviewer". The stored value never changes. */
function humanise(role: string): string {
  const spaced = role.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
