'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { MemberPasswordResetDialog } from '../people/MemberPasswordResetDialog';
import type { MessageKey } from '../../lib/i18n/t';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchPersonProfile } from '../../lib/api/person-profile';
import type { PersonProfileView } from '../../lib/api/person-profile';
import { useRoleDescription, useStatusLabel } from '../../lib/use-role-description';
import { pluralPhrase } from '../../lib/i18n/plural';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { withNumerals } from '../../lib/i18n/display-format';
import { useTOr } from '../../lib/i18n/use-t-or';
import type { ApiClient } from '../../lib/api/client';
import { describePeopleError, firstNameOf, initialsOf } from './peopleShared';
import { useT } from '../../lib/i18n/use-t';
import '../../styles/screens/people.css';
import { PersonAvatar } from '../people/PersonAvatar';

export interface PersonProfileScreenProps {
  organizationSlug: string;
  organizationName: string;
  membershipId: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Person profile** — x169, the per-member detail behind the People directory (module 14, audit #4),
 * drawn as PEO-02 "Profile · commitments and authority · no score".
 *
 * It reads `GET /v1/organizations/:orgSlug/people/:membershipId` (gated on the server by `work.read`)
 * and renders the member's non-sensitive profile: the header (breadcrumb, initials orb, role eyebrow,
 * name), the projects they belong to as the commitment list, what their role may and may not decide,
 * how much open work they own, and what a profile never shows.
 *
 * The decisions are the sibling internal screens':
 * 1. **Authorization is the API's.** A caller without `work.read`, or a cross-tenant/unknown id, gets
 *    the API's 403/404, which `describePeopleError()` turns into a sentence; the screen never guesses
 *    a capability of its own and never renders blank on a refusal.
 * 2. **No invented data.** Role, projects and the open-work count are the API's projection; the
 *    authority lines are the role's own description from `lib/roles`. The frame's decisions,
 *    response windows and two-week strip have no read behind them yet, so they are not drawn.
 * 3. **The header is the screen's own** (breadcrumb + 88px orb), so the shell's header is replaced
 *    rather than doubled; the shell still owns the document's title text.
 */
export function PersonProfileScreen({
  organizationSlug,
  organizationName,
  membershipId,
  client,
}: PersonProfileScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();

  const profile = useQuery({
    queryKey: ['person-profile', organizationSlug, membershipId],
    queryFn: () => fetchPersonProfile(api, organizationSlug, membershipId),
  });

  const name = profile.isSuccess
    ? profile.data.displayName
    : t('PersonProfileScreen.personFallback');

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      eyebrow={t('PersonProfileScreen.people')}
      title={name}
    >
      <div className="ppl-screen ppl-screen--own-header">
        <p className="ppl-crumbs">
          <Link href={`/${organizationSlug}/people`}>{t('PersonProfileScreen.people')}</Link>
          {' · '}
          {name}
        </p>

        {profile.isSuccess ? (
          <ProfileBody profile={profile.data} organizationSlug={organizationSlug} api={api} />
        ) : (
          <h1 className="ppl-hero__title">{t('PersonProfileScreen.personFallback')}</h1>
        )}
        {profile.isSuccess ? null : (
          <section className="ppl-card" aria-labelledby="tm-person-heading">
            <h2 id="tm-person-heading" className="ppl-mono">
              {t('PersonProfileScreen.profileHeading')}
            </h2>
            {profile.isPending ? (
              <LoadingRegion
                label={t('PersonProfileScreen.loading')}
                className="tm-stack tm-stack--tight"
              >
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}
            {profile.isError ? (
              <InlineAlert tone="danger" title={t('PersonProfileScreen.loadError')} live>
                {describePeopleError(profile.error)}
              </InlineAlert>
            ) : null}
          </section>
        )}
      </div>
    </AppShell>
  );
}

function ProfileBody({
  profile,
  organizationSlug,
  api,
}: {
  profile: PersonProfileView;
  organizationSlug: string;
  api: ApiClient;
}) {
  const t = useT();
  const [resetting, setResetting] = useState(false);
  const describeRole = useRoleDescription();
  const statusLabel = useStatusLabel();
  const tr = useTOr();
  const locale = useActiveLocale();
  const role = describeRole(profile.role);
  const first = firstNameOf(profile.displayName);
  const active = profile.projects.filter((project) => project.status === 'active').length;

  return (
    <>
      <div className="ppl-hero">
        <PersonAvatar
          organizationSlug={organizationSlug}
          userId={profile.userId}
          name={profile.displayName}
          className="ppl-avatar ppl-avatar--88"
          size="hero"
          decorative
          fallback={
            <span className="ppl-avatar ppl-avatar--88" aria-hidden="true">
              {initialsOf(profile.displayName)}
            </span>
          }
        />
        <div className="ppl-hero__titles">
          <p className="ppl-hero__eyebrow">
            {role.label} · {statusLabel(profile.status)}
          </p>
          <h1 className="ppl-hero__title">{profile.displayName}</h1>
          <p className="ppl-hero__lede">
            {profile.projects.length === 0
              ? `${first} ${t('PersonProfileScreen.notOnProjects')}`
              : pluralPhrase(
                  tr,
                  locale,
                  'PersonProfileScreen.onProjects',
                  profile.projects.length,
                  {
                    one: 'On {count} project in this organization, {active} of them active.',
                    other: 'On {count} projects in this organization, {active} of them active.',
                  },
                ).replace('{active}', active.toLocaleString(withNumerals(locale)))}
          </p>
        </div>
        {/* Q4 / t1-d. Shown to everyone; the API decides (`org.manage`) and the dialog says so. */}
        <div className="ppl-hero__actions">
          <Button type="button" tone="outline" onClick={() => setResetting(true)}>
            {t('ResetMemberPassword.open' as MessageKey)}
          </Button>
        </div>
      </div>
      {resetting ? (
        <MemberPasswordResetDialog
          api={api}
          organizationSlug={organizationSlug}
          membershipId={profile.membershipId}
          displayName={profile.displayName}
          firstName={first}
          onClose={() => setResetting(false)}
        />
      ) : null}

      <div className="ppl-body ppl-body--wide-gap">
        <div className="ppl-main">
          <section className="ppl-card" aria-labelledby="tm-person-projects">
            <div className="ppl-card__head">
              <h2 id="tm-person-projects" className="ppl-card__title ppl-card__title--lg">
                {t('PersonProfileScreen.whereCommittedPrefix')} {first}{' '}
                {t('PersonProfileScreen.whereCommittedSuffix')}
              </h2>
              <span className="ppl-mono ppl-mono--meta">
                {profile.projects.length}{' '}
                {profile.projects.length === 1
                  ? t('PersonProfileScreen.projectWord')
                  : t('PersonProfileScreen.projectsWord')}{' '}
                · {profile.openWorkCount} {t('PersonProfileScreen.openWord')}
              </span>
            </div>
            {profile.projects.length === 0 ? (
              <p className="ppl-note">{t('PersonProfileScreen.noProjectsNote')}</p>
            ) : (
              <ul
                className="ppl-commitments"
                aria-label={`${t('PersonProfileScreen.projectsAriaPrefix')} ${profile.displayName} ${t('PersonProfileScreen.projectsAriaSuffix')}`}
              >
                {profile.projects.map((project, index) => (
                  <li
                    key={project.projectId}
                    className={
                      project.status === 'active'
                        ? index === 0
                          ? 'ppl-commitment ppl-commitment--current'
                          : 'ppl-commitment'
                        : 'ppl-commitment ppl-commitment--warning'
                    }
                  >
                    <span className="ppl-commitment__text">
                      <Link
                        href={`/${organizationSlug}/projects/${project.projectId}`}
                        className="ppl-commitment__title"
                      >
                        {project.name}
                      </Link>
                      <span className="ppl-commitment__sub">
                        {describeRole(project.role).label} {t('PersonProfileScreen.onThisProject')}
                      </span>
                    </span>
                    <span
                      className={
                        project.status === 'active'
                          ? 'ppl-pill ppl-pill--lg ppl-pill--lime'
                          : 'ppl-pill ppl-pill--lg ppl-pill--warning'
                      }
                    >
                      {statusLabel(project.status)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="ppl-pair">
            <section className="ppl-card" aria-labelledby="tm-person-authority">
              <h2 id="tm-person-authority" className="ppl-card__title">
                {t('PersonProfileScreen.authority')}
              </h2>
              <ul className="ppl-authority">
                {role.grants.map((grant) => (
                  <li key={grant} data-kind="grant">
                    <span className="ppl-authority__mark" aria-hidden="true">
                      ✓
                    </span>
                    {grant}
                  </li>
                ))}
                <li aria-hidden="true" className="ppl-authority__rule" />
                <li data-kind="withhold">
                  <span className="ppl-authority__mark" aria-hidden="true">
                    ✕
                  </span>
                  {role.withholds}
                </li>
              </ul>
            </section>

            <section className="ppl-card" aria-labelledby="tm-person-open">
              <h2 id="tm-person-open" className="ppl-card__title">
                {t('PersonProfileScreen.openWork')}
              </h2>
              <div className="ppl-metric">
                <span className="ppl-metric__value">{profile.openWorkCount}</span>
                <span className="ppl-metric__label">
                  {profile.openWorkCount === 1
                    ? t('PersonProfileScreen.openItem')
                    : t('PersonProfileScreen.openItems')}{' '}
                  {first} {t('PersonProfileScreen.owns')}
                </span>
              </div>
              <p className="ppl-note">{t('PersonProfileScreen.openWorkNote')}</p>
            </section>
          </div>
        </div>

        <div className="ppl-aside ppl-aside--352">
          <section className="ppl-card" aria-labelledby="tm-person-glance">
            <h2 id="tm-person-glance" className="ppl-mono">
              {first} {t('PersonProfileScreen.atAGlance')}
            </h2>
            <ul className="ppl-soft-list">
              <li className="ppl-soft-row ppl-soft-row--roomy">
                {t('PersonProfileScreen.roleLabel')}
                <span className="ppl-soft-row__end ppl-soft-row__end--text">{role.label}</span>
              </li>
              <li className="ppl-soft-row ppl-soft-row--roomy">
                {t('PersonProfileScreen.statusLabel')}
                <span className="ppl-soft-row__end ppl-soft-row__end--text">
                  {statusLabel(profile.status)}
                </span>
              </li>
              <li className="ppl-soft-row ppl-soft-row--roomy">
                {t('PersonProfileScreen.projectsLabel')}
                <span className="ppl-soft-row__end ppl-soft-row__end--text">
                  {profile.projects.length}
                </span>
              </li>
            </ul>
            <p className="ppl-note">{t('PersonProfileScreen.rolesNote')}</p>
          </section>

          <section className="ppl-card ppl-card--ink" aria-labelledby="tm-person-never">
            <h2 id="tm-person-never" className="ppl-mono">
              {t('PersonProfileScreen.neverTitle')}
            </h2>
            <p className="ppl-note ppl-note--ink">{t('PersonProfileScreen.neverBody')}</p>
          </section>
        </div>
      </div>
    </>
  );
}
