'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Avatar, Button, InlineAlert, StatusDot } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import {
  disablePlatformPerson,
  enablePlatformPerson,
  fetchPlatformPerson,
  sendPlatformPersonPasswordReset,
} from '../../../lib/api/platform-people';
import type { PlatformPersonDetailView } from '../../../lib/api/platform-people';
import type { MessageKey } from '../../../lib/i18n/t';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useT } from '../../../lib/i18n/use-t';
import { PlatformGate } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { ReasonDialog } from '../shared/ReasonDialog';
import { missingPlatformPermission } from '../shared/usePlatformPermissions';
import { dayAndTime, firstNameOf, shortId } from './people-format';
import { PeopleReasonDialog } from './PeopleReasonDialog';

type T = ReturnType<typeof useT>;

export type PersonTab = 'profile' | 'security' | 'organizations' | 'activity';

export function personKey(userId: string) {
  return ['platform', 'people', 'person', userId] as const;
}

const ROLE_KEYS: Readonly<Record<string, MessageKey>> = {
  owner: 'PlatformPeople.role.owner',
  org_admin: 'PlatformPeople.role.org_admin',
  workspace_admin: 'PlatformPeople.role.workspace_admin',
  manager: 'PlatformPeople.role.manager',
  moderator: 'PlatformPeople.role.moderator',
  member: 'PlatformPeople.role.member',
  guest: 'PlatformPeople.role.guest',
  admin: 'PlatformPeople.role.org_admin',
  client_admin: 'PlatformPeople.role.client_admin',
  client_reviewer: 'PlatformPeople.role.client_reviewer',
  client_member: 'PlatformPeople.role.client_member',
  client_viewer: 'PlatformPeople.role.client_viewer',
};

/** "Owner", "Org admin", "Reviewer · custom role". */
export function roleName(t: T, role: string, custom: string | null): string {
  if (custom !== null) return `${custom} · ${t('PlatformPeople.customRole')}`;
  const key = ROLE_KEYS[role];
  return key ? t(key) : role;
}

export interface PersonScreenContext {
  readonly api: ApiClient;
  readonly me: PlatformMeView;
  readonly person: PlatformPersonDetailView;
  readonly refresh: () => Promise<unknown>;
}

type Pending = 'reset' | 'disable' | 'enable' | null;

/**
 * The frame every person page shares (B2 434:16180 · B3 435:15658 · B4 435:18389): the crumb with
 * the short user id, avatar, name, email, status and organization count, the two header actions
 * (Send password reset; Disable or Enable account), the four tabs, and the disabled banner.
 */
export function PersonFrame({
  api,
  userId,
  tab,
  children,
}: {
  api: ApiClient;
  userId: string;
  tab: PersonTab;
  children: (context: PersonScreenContext) => ReactNode;
}) {
  const t = useT();
  const person = useQuery({
    queryKey: personKey(userId),
    queryFn: () => fetchPlatformPerson(api, userId),
    retry: false,
  });
  const name = person.data?.displayName ?? t('PlatformPeople.title');
  return (
    <PlatformGate
      api={api}
      section="people"
      crumbs={[t('PlatformPeople.crumb'), `${t('PlatformPeople.user')} ${shortId(userId)}`]}
      title={name}
    >
      {(me) => {
        if (person.isPending) {
          return (
            <PlatformPageState state="loading" loadingLabel={t('PlatformPeople.loadingPerson')} />
          );
        }
        if (person.isError) {
          const missing = missingPlatformPermission(person.error);
          return missing !== null ? (
            <PlatformPageState state="forbidden" permission={missing} preset={me.preset} />
          ) : (
            <PlatformPageState
              state="error"
              error={person.error}
              onRetry={() => void person.refetch()}
            />
          );
        }
        return (
          <PersonBody api={api} me={me} person={person.data} tab={tab} refresh={person.refetch}>
            {children}
          </PersonBody>
        );
      }}
    </PlatformGate>
  );
}

function PersonBody({
  api,
  me,
  person,
  tab,
  refresh,
  children,
}: PersonScreenContext & {
  tab: PersonTab;
  children: (context: PersonScreenContext) => ReactNode;
}) {
  const t = useT();
  const locale = useActiveLocale();
  const [pending, setPending] = useState<Pending>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canSecure = me.permissions.includes('platform.people.security');
  const first = firstNameOf(person.displayName);
  const disabled = person.status === 'disabled';
  const base = `/platform/people/${person.id}`;
  const tabs: readonly { id: PersonTab; href: string; label: string }[] = [
    { id: 'profile', href: base, label: t('PlatformPeople.tabProfile') },
    { id: 'security', href: `${base}/security`, label: t('PlatformPeople.tabSecurity') },
    {
      id: 'organizations',
      href: `${base}/organizations`,
      label: t('PlatformPeople.tabOrganizations'),
    },
    {
      id: 'activity',
      href: `/platform/audit?actorUserId=${encodeURIComponent(person.id)}`,
      label: t('PlatformPeople.tabActivity'),
    },
  ];

  return (
    <div className="tm-stack">
      <section className="tm-cc-card tm-cc-hero" aria-label={t('PlatformPeople.personLabel')}>
        <div className="tm-cc-person">
          <Avatar name={person.displayName} size="feature" decorative />
          <div className="tm-stack tm-stack--tight">
            <h2 className="tm-cc-card__title">{person.displayName}</h2>
            <span className="tm-cc-card__actions">
              <bdi dir="ltr" className="tm-cc-cell-sub">
                {person.email}
              </bdi>
              {disabled ? (
                <StatusDot tone="danger">{t('PlatformPeople.statusDisabled')}</StatusDot>
              ) : (
                <StatusDot tone="success">{t('PlatformPeople.statusActive')}</StatusDot>
              )}
              <span className="tm-cc-pill tm-cc-cell-mono">
                {person.companies.length} {t('PlatformPeople.organizationsWord')}
              </span>
            </span>
          </div>
        </div>
        {canSecure ? (
          <div className="tm-cc-card__actions">
            <Button type="button" tone="outline" onClick={() => setPending('reset')}>
              {t('PlatformPeople.sendReset')}
            </Button>
            {disabled ? (
              <Button type="button" tone="ink" onClick={() => setPending('enable')}>
                {t('PlatformPeople.enableAccount')}
              </Button>
            ) : (
              <Button type="button" tone="destructive" onClick={() => setPending('disable')}>
                {t('PlatformPeople.disableAccount')}
              </Button>
            )}
          </div>
        ) : null}
      </section>

      <nav className="tm-cc-card__actions" aria-label={t('PlatformPeople.tabsLabel')}>
        {tabs.map((item) => (
          <Link
            key={item.id}
            href={item.href}
            className={`tm-cc-pill${item.id === tab ? ' tm-cc-pill--on' : ''}`}
            {...(item.id === tab ? { 'aria-current': 'page' as const } : {})}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      {disabled ? (
        <InlineAlert tone="danger" title={t('PlatformPeople.disabledBannerTitle')}>
          {`${t('PlatformPeople.disabledOnLong')} ${dayAndTime(person.disabledAt, locale)}`}
          {person.disabledByEmail ? ` ${t('PlatformPeople.by')} ${person.disabledByEmail}` : ''}
          {person.disabledReason
            ? ` · ${t('PlatformPeople.reasonLower')} “${person.disabledReason}”`
            : ''}
          {`. ${t('PlatformPeople.disabledBannerBody')}`}
        </InlineAlert>
      ) : null}
      {notice ? (
        <InlineAlert tone="success" live>
          {notice}
        </InlineAlert>
      ) : null}

      {children({ api, me, person, refresh })}

      {pending === 'reset' ? (
        <ReasonDialog
          title={`${t('PlatformPeople.resetTitle')} ${person.displayName}?`}
          body={t('PlatformPeople.resetBody')}
          reasonRequired
          confirmLabel={t('PlatformPeople.sendReset')}
          onConfirm={async (reason) => {
            await sendPlatformPersonPasswordReset(api, person.id, reason ?? '');
            setNotice(`${t('PlatformPeople.resetSent')} ${person.email}.`);
          }}
          onClose={() => setPending(null)}
        />
      ) : null}
      {pending === 'disable' ? (
        <DisableDialog
          person={person}
          first={first}
          onConfirm={async (reason) => {
            await disablePlatformPerson(api, person.id, reason);
            await refresh();
          }}
          onClose={() => setPending(null)}
        />
      ) : null}
      {pending === 'enable' ? (
        <ReasonDialog
          title={`${t('PlatformPeople.enableTitle')} ${person.displayName}?`}
          body={`${first} ${t('PlatformPeople.enableBody')}`}
          reasonRequired={false}
          confirmLabel={t('PlatformPeople.enableAccount')}
          onConfirm={async (reason) => {
            await enablePlatformPerson(api, person.id, reason);
            await refresh();
          }}
          onClose={() => setPending(null)}
        />
      ) : null}
    </div>
  );
}

/** B2 · Disable dialog (434:16652): the destructive eyebrow, what ends, what stays, the reason. */
export function DisableDialog({
  person,
  first,
  onConfirm,
  onClose,
}: {
  person: PlatformPersonDetailView;
  first: string;
  onConfirm: (reason: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <PeopleReasonDialog
      eyebrow={t('PlatformPeople.disableEyebrow')}
      title={`${t('PlatformPeople.disableTitle')} ${person.displayName}${t('PlatformPeople.disableTitleEnd')}`}
      body={
        <>
          <p className="tm-cc-note">{t('PlatformPeople.disableBody')}</p>
          <ul className="tm-cc-card tm-cc-card--quiet tm-stack tm-stack--tight">
            <li>
              {person.companies.length} {t('PlatformPeople.disableBulletOrgs')} {first}
            </li>
            <li>
              {person.liveSessions} {t('PlatformPeople.disableBulletSessions')} ·{' '}
              {person.facts.personalAccessTokens + person.facts.aiAppGrants}{' '}
              {t('PlatformPeople.disableBulletTokens')}
            </li>
            <li>{t('PlatformPeople.disableBulletAudit')}</li>
          </ul>
        </>
      }
      destructive
      confirmLabel={t('PlatformPeople.disableAccount')}
      note={t('PlatformPeople.reasonNote')}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
