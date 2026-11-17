'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, SearchField, Skeleton } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listOrganizations, type OrganizationSummary } from '../../lib/api/organizations';
import type { ApiClient } from '../../lib/api/client';
import type { RoleDescription } from '../../lib/roles';
import { useRoleDescription } from '../../lib/use-role-description';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { pluralPhrase } from '../../lib/i18n/plural';
import type { MessageKey } from '../../lib/i18n/t';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { confirmEmailSettingPath, wantsConfirmEmailSetting } from '../../lib/sign-in-return';
import { importPagePath, importToolFromSearch } from '../../lib/import-link';
import type { ImportSourceId } from '../../lib/import-sources';
import '../../styles/screens/identity.css';

export interface OrganizationSelectorScreenProps {
  client?: ApiClient;
  /**
   * How to leave for a chosen organization. Injected in tests so the auto-enter below can be
   * asserted without a router; the default is a full navigation, which starts the destination
   * on a clean client cache.
   */
  navigate?: (href: string) => void;
}

/**
 * Where a membership opens: a client lands in the portal, everyone else in the app, or, after an
 * expired confirmation link (`?then=confirm-email`), on the "Confirm your e-mail" setting.
 */
function destinationFor(
  organization: OrganizationSummary,
  confirmEmail = false,
  importTool?: ImportSourceId,
): string {
  if (organization.audience === 'client') return `/${organization.slug}/portal`;
  if (confirmEmail) return confirmEmailSettingPath(organization.slug);
  // 54-29: arrived from a "switch from X" page — the Import page, with that tool chosen.
  return importTool ? importPagePath(organization.slug, importTool) : `/${organization.slug}/home`;
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
 * **Empty** is what a person sees between signing up and creating their first organization. It
 * gets its own copy and a link to `ON-01`, not an error — unless they arrived here with
 * `?removed` because an administrator removed their last membership, in which case it says so
 * (ACC-15) rather than inviting them to found something.
 *
 * **One** organization renders the list for an internal member — skipping it would mean they
 * never see that they can create another, and would make the "last opened" affordance
 * unreachable. A **client** with one organization is the exception: a client cannot create an
 * organization and has only their portal to go to, so they are taken straight in (ACC-12).
 */
export function OrganizationSelectorScreen({
  client,
  navigate = (href) => window.location.assign(href),
}: OrganizationSelectorScreenProps) {
  const describe = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();
  const tr = useTOr();
  const locale = useActiveLocale();
  const [query, setQuery] = useState('');
  const describeRole = useRoleDescription();

  /**
   * A removed member is sent here with `?removed`; the org list is then empty, and without this
   * flag the empty state would offer them "Create an organization" as though they had simply
   * never joined one (ACC-15). Read once — the value does not change while the screen is open.
   */
  const [accessRemoved] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      return new URLSearchParams(window.location.search).has('removed');
    } catch {
      return false;
    }
  });

  /** CONFIRMPOLISH 2: sent here after sign-in from an expired confirmation link. Read once. */
  const [confirmEmail] = useState(
    () => typeof window !== 'undefined' && wantsConfirmEmailSetting(window.location.search),
  );

  /** 54-29: the allow-listed `?import=<tool>` from a "switch from X" page. Read once. */
  const [importTool] = useState<ImportSourceId | undefined>(() =>
    typeof window === 'undefined' ? undefined : importToolFromSearch(window.location.search),
  );

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

  /**
   * A client has exactly one place to be — their portal — and no reason to pick it from a list
   * of one or to see "create an organization", which a client cannot do. So a client with a
   * single organization is taken straight in (ACC-12). Internal members still see the chooser,
   * because for them the list is also where a second organization is created and "last opened"
   * lives. Not run while access was removed.
   */
  const soleClientOrganization =
    organizations.isSuccess &&
    organizations.data.length === 1 &&
    organizations.data[0]!.audience === 'client' &&
    !accessRemoved
      ? organizations.data[0]!
      : undefined;

  /** With one workspace, the confirmation-mail setting opens straight away (no choice to make). */
  const soleConfirmEmailOrganization =
    confirmEmail &&
    organizations.isSuccess &&
    organizations.data.length === 1 &&
    organizations.data[0]!.audience !== 'client'
      ? organizations.data[0]!
      : undefined;

  useEffect(() => {
    if (soleClientOrganization) navigate(destinationFor(soleClientOrganization));
  }, [soleClientOrganization, navigate]);

  useEffect(() => {
    if (soleConfirmEmailOrganization) navigate(destinationFor(soleConfirmEmailOrganization, true));
  }, [soleConfirmEmailOrganization, navigate]);

  /** 54-29: with one workspace, a "switch from X" visitor goes straight to its Import page. */
  const soleImportOrganization =
    importTool !== undefined &&
    !confirmEmail &&
    organizations.isSuccess &&
    organizations.data.length === 1 &&
    organizations.data[0]!.audience !== 'client'
      ? organizations.data[0]!
      : undefined;

  useEffect(() => {
    if (soleImportOrganization) navigate(destinationFor(soleImportOrganization, false, importTool));
  }, [soleImportOrganization, importTool, navigate]);

  if (soleClientOrganization) {
    const name = soleClientOrganization.clientOrganizationName ?? soleClientOrganization.name;
    return (
      <IdentityShell eyebrow={t('OrganizationSelectorScreen.eyebrow')}>
        <div className="tm-id-bare tm-id-orgs tm-stack">
          <h1 className="tm-identity__title">{t('OrganizationSelectorScreen.openingPortal')}</h1>
          <LoadingRegion label={`${t('OrganizationSelectorScreen.takingYouTo')} ${name}.`}>
            <p className="tm-id-lede">
              {t('OrganizationSelectorScreen.takingYouTo')} {name}…
            </p>
          </LoadingRegion>
        </div>
      </IdentityShell>
    );
  }

  return (
    <IdentityShell eyebrow={t('OrganizationSelectorScreen.eyebrow')}>
      <div className="tm-id-bare tm-id-orgs tm-stack">
        <h1 className="tm-identity__title">
          {heading(organizations.data, accessRemoved, tr, locale)}
        </h1>

        {organizations.isPending ? (
          <LoadingRegion
            label={t('OrganizationSelectorScreen.loadingOrgs')}
            className="tm-stack tm-stack--tight"
          >
            <Skeleton height="88px" />
            <Skeleton height="88px" />
          </LoadingRegion>
        ) : null}

        {organizations.isError ? (
          <InlineAlert tone="danger" title={t('OrganizationSelectorScreen.loadError')} live>
            {describe(organizations.error)}
          </InlineAlert>
        ) : null}

        {organizations.isSuccess && organizations.data.length === 0 && accessRemoved ? (
          <div className="tm-id-card">
            <InlineAlert
              tone="warning"
              title={t('OrganizationSelectorScreen.accessRemovedTitle')}
              live
            >
              {t('OrganizationSelectorScreen.accessRemovedBody')}
            </InlineAlert>
            <div className="tm-row">
              <Link className="tm-button tm-button--ink tm-button--accessible" href="/sign-in">
                {t('OrganizationSelectorScreen.signInDifferent')}
              </Link>
            </div>
          </div>
        ) : null}

        {organizations.isSuccess && organizations.data.length === 0 && !accessRemoved ? (
          <div className="tm-id-card">
            <InlineAlert tone="neutral" title={t('OrganizationSelectorScreen.noOrgTitle')}>
              {t('OrganizationSelectorScreen.noOrgBody')}
            </InlineAlert>
            <div className="tm-row">
              <Link
                className="tm-button tm-button--ink tm-button--accessible"
                href="/onboarding/organization"
              >
                {t('OrganizationSelectorScreen.createOrg')}
              </Link>
            </div>
          </div>
        ) : null}

        {organizations.isSuccess && organizations.data.length > 0 ? (
          <>
            <SearchField
              label={t('OrganizationSelectorScreen.searchLabel')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('OrganizationSelectorScreen.searchLabel')}
            />

            {matches.length === 0 ? (
              <InlineAlert tone="neutral" live>
                {t('OrganizationSelectorScreen.noMatch')} “{query}”.
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
                        href={destinationFor(organization, confirmEmail, importTool)}
                      >
                        <span className="tm-id-org__orb" aria-hidden="true">
                          {initials(name)}
                        </span>
                        <span className="tm-id-org__text">
                          <span className="tm-id-org__name">{name}</span>
                          <span className="tm-id-org__meta">
                            <span>
                              {isClient
                                ? t('OrganizationSelectorScreen.clientPortal')
                                : t('OrganizationSelectorScreen.internalMember')}
                            </span>
                            {' · '}
                            <span>{roleLabel(organization.role, describeRole)}</span>
                            {isClient ? (
                              <>
                                {' · '}
                                <span>
                                  {t('OrganizationSelectorScreen.deliveredBy')} {organization.name}
                                </span>
                              </>
                            ) : null}
                          </span>
                        </span>
                        {/* The meta line already says "Client portal" in plain words; the old
                            "portal mode" chip was jargon on top of it (ACC-12), so it is gone. */}
                        <span className="tm-id-org__go" aria-hidden="true">
                          →
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Live test 2026-10-31: an owner with organizations had no way back to ON-01 short of
                typing its URL. Figma: "Workspace · Organization list with create (2026-10-31
                live-test fix)" 446:35916. Clients cannot create an organization, so the row is
                offered only to someone who is an internal member somewhere. */}
            {organizations.data.some((organization) => organization.audience !== 'client') ? (
              <Link className="tm-id-org tm-id-org--create" href="/onboarding/organization">
                <span className="tm-id-org__orb" aria-hidden="true">
                  +
                </span>
                <span className="tm-id-org__text">
                  <span className="tm-id-org__name">
                    {t('OrganizationSelectorScreen.createAnother' as MessageKey)}
                  </span>
                  <span className="tm-id-org__meta">
                    {t('OrganizationSelectorScreen.createAnotherMeta' as MessageKey)}
                  </span>
                </span>
                <span className="tm-id-org__go" aria-hidden="true">
                  →
                </span>
              </Link>
            ) : null}
          </>
        ) : null}

        <InlineAlert className="tm-id-footnote" tone="neutral">
          {t('OrganizationSelectorScreen.footnote')}
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

/** The page heading, in the active locale with its plural forms (R34 D2). */
function heading(
  organizations: readonly OrganizationSummary[] | undefined,
  accessRemoved: boolean,
  tr: (key: string, english: string) => string,
  locale: string,
): string {
  if (!organizations) {
    return tr('OrganizationSelectorScreen.headingChoose', 'Choose where you are working');
  }
  if (organizations.length === 0) {
    return accessRemoved
      ? tr('OrganizationSelectorScreen.headingNoAccess', 'No access')
      : tr('OrganizationSelectorScreen.headingNowhere', 'Nowhere to go yet');
  }
  return pluralPhrase(tr, locale, 'OrganizationSelectorScreen.orgCount', organizations.length, {
    one: 'One organization uses your email',
    other: '{count} organizations use your email',
  });
}

/**
 * The role in words, from `lib/roles` so `guest` reads "Freelancer or partner" and `client_reviewer`
 * "Client reviewer" here exactly as everywhere else. A value `lib/roles` does not know is spaced
 * and capitalised rather than shown raw. The stored value never changes.
 */
function roleLabel(role: string, describe: (role: string) => RoleDescription): string {
  const label = describe(role).label;
  if (label !== role) return label;
  const spaced = role.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
