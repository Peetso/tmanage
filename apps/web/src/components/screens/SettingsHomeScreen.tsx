'use client';

import { useId } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { SettingsShell } from '../admin/SettingsShell';
import { GettingStartedCard } from '../onboarding/GettingStartedCard';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import {
  HEALTH_FIX_HREF,
  getSetupHealth,
  type SetupHealthCheck,
} from '../../lib/api/getting-started';
import { useTOr } from '../../lib/i18n/use-t-or';

export interface SettingsHomeScreenProps {
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly client?: ApiClient;
}

type Entry = readonly [href: string, key: string, english: string];

/** The grouped settings cards: every link is an existing settings or admin screen. */
export const SETTINGS_GROUPS: readonly {
  readonly id: string;
  readonly title: readonly [string, string];
  readonly entries: readonly Entry[];
}[] = [
  {
    id: 'you',
    title: ['SettingsHome.group.you', 'You'],
    entries: [
      ['/settings/display', 'SettingsHome.link.display', 'Display and language'],
      ['/settings/accessibility', 'SettingsHome.link.accessibility', 'Accessibility'],
      ['/settings/quiet-hours', 'SettingsHome.link.quietHours', 'Quiet hours'],
      ['/settings/digest', 'SettingsHome.link.digest', 'Email digest'],
      ['/settings/my-data', 'SettingsHome.link.myData', 'My data'],
    ],
  },
  {
    id: 'security',
    title: ['SettingsHome.group.security', 'Sign-in and security'],
    entries: [
      ['/settings/sign-in-security', 'SettingsHome.link.signInSecurity', 'Sign-in security'],
      ['/settings/two-step', 'SettingsHome.link.twoStep', 'Two-step sign-in'],
      ['/settings/security', 'SettingsHome.link.accessTokens', 'Access tokens'],
    ],
  },
  {
    id: 'connections',
    title: ['SettingsHome.group.connections', 'Connections'],
    entries: [
      ['/settings/connected-apps', 'SettingsHome.link.connectedApps', 'Connected apps'],
      [
        '/settings/calendar-connections',
        'SettingsHome.link.calendarConnections',
        'Calendar connections',
      ],
      ['/settings/ai-assistant', 'SettingsHome.link.aiAssistant', 'AI assistant'],
      ['/settings/inbound-mail', 'SettingsHome.link.inboundMail', 'Mail-in address'],
    ],
  },
  {
    id: 'company',
    title: ['SettingsHome.group.company', 'Company'],
    entries: [
      ['/settings/organization', 'SettingsHome.link.organization', 'Organization policy'],
      ['/admin/working-calendar', 'SettingsHome.link.workingHours', 'Working hours'],
      ['/admin/storage', 'SettingsHome.link.storage', 'Storage'],
      ['/billing/settings', 'SettingsHome.link.billing', 'Billing'],
    ],
  },
];

const HEALTH_TEXT: Readonly<
  Record<
    SetupHealthCheck,
    {
      readonly name: readonly [string, string];
      readonly ok: readonly [string, string];
      readonly todo: readonly [string, string];
      readonly fix: readonly [string, string];
    }
  >
> = {
  storage: {
    name: ['SettingsHome.health.storage', 'Storage connected'],
    ok: ['SettingsHome.health.storageOk', 'Company storage is connected'],
    todo: ['SettingsHome.health.storageTodo', 'Files are not on your Drive or OneDrive yet'],
    fix: ['SettingsHome.health.storageFix', 'Connect storage'],
  },
  sign_in_security: {
    name: ['SettingsHome.health.signIn', 'Sign-in security'],
    ok: ['SettingsHome.health.signInOk', 'Two-step sign-in is required'],
    todo: ['SettingsHome.health.signInTodo', 'Two-step sign-in is not required yet'],
    fix: ['SettingsHome.health.signInFix', 'Require two-step'],
  },
  backups: {
    name: ['SettingsHome.health.backups', 'Backups and export'],
    ok: ['SettingsHome.health.backupsOk', 'An export finished in the last 90 days'],
    todo: ['SettingsHome.health.backupsTodo', 'No export in the last 90 days'],
    fix: ['SettingsHome.health.backupsFix', 'Export now'],
  },
  domain_mail: {
    name: ['SettingsHome.health.domainMail', 'Domain mail'],
    ok: ['SettingsHome.health.domainMailOk', 'Mail-in address is active'],
    todo: ['SettingsHome.health.domainMailTodo', 'No mail-in address yet'],
    fix: ['SettingsHome.health.domainMailFix', 'Set up mail'],
  },
};

/**
 * **55-22 — Settings home** (Figma R49 L1 section, Product page 18:180).
 *
 * Grouped cards that link to every settings screen, the getting-started checklist (55-11) while
 * it is still open, and — for an owner only — the Setup health panel: storage, sign-in security,
 * backups and domain mail, each with a fix link. A member's Setup health read is refused (403),
 * so the panel simply does not render for them. Logical properties mirror it for Arabic.
 */
export function SettingsHomeScreen({
  organizationSlug,
  organizationName,
  client,
}: SettingsHomeScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const t = ([key, english]: readonly [string, string]) => tOr(key, english);
  const healthTitleId = useId();
  const health = useQuery({
    queryKey: ['setup-health', organizationSlug],
    queryFn: () => getSetupHealth(api, organizationSlug),
    retry: false,
  });

  return (
    <SettingsShell
      section="settings-home"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="settings"
      title={tOr('SettingsHome.title', 'Settings')}
    >
      <style href="tm-settings-home" precedence="default">
        {SETTINGS_HOME_CSS}
      </style>
      <div className="tm-sh">
        <div className="tm-sh__groups">
          {SETTINGS_GROUPS.map((group) => (
            <section key={group.id} className="tm-sh__card" aria-label={t(group.title)}>
              <h2 className="tm-sh__card-title">{t(group.title)}</h2>
              <ul className="tm-sh__links">
                {group.entries.map(([href, key, english]) => (
                  <li key={href}>
                    <Link className="tm-sh__link" href={`/${organizationSlug}${href}`}>
                      {tOr(key, english)}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="tm-sh__side">
          <GettingStartedCard organizationSlug={organizationSlug} client={api} />
          {health.data ? (
            <section className="tm-sh__card" aria-labelledby={healthTitleId}>
              <h2 id={healthTitleId} className="tm-sh__panel-title">
                {tOr('SettingsHome.health.title', 'Setup health')}
              </h2>
              <p className="tm-sh__sub">
                {tOr('SettingsHome.health.subtitle', 'What your company still needs')}
              </p>
              <ul className="tm-sh__checks">
                {health.data.checks.map(({ check, ok }) => {
                  const text = HEALTH_TEXT[check];
                  return (
                    <li key={check} className="tm-sh__check" data-ok={ok ? 'true' : 'false'}>
                      <span className="tm-sh__dot" aria-hidden="true">
                        {ok ? '✓' : ''}
                      </span>
                      <span className="tm-sh__check-text">
                        <strong>{t(text.name)}</strong>
                        <span>{t(ok ? text.ok : text.todo)}</span>
                      </span>
                      {ok ? (
                        <span className="tm-sh__done">
                          {tOr('SettingsHome.health.done', 'Done')}
                        </span>
                      ) : (
                        <Link
                          className="tm-button tm-button--outline tm-button--compact"
                          href={`/${organizationSlug}${HEALTH_FIX_HREF[check]}`}
                        >
                          {t(text.fix)}
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </SettingsShell>
  );
}

const SETTINGS_HOME_CSS = `
.tm-sh { display: flex; align-items: flex-start; gap: 32px; }
.tm-sh__groups { flex: 1 1 auto; min-inline-size: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 24px; align-items: start; }
.tm-sh__side { flex: 0 0 440px; display: flex; flex-direction: column; gap: 24px; }
.tm-sh__card { display: flex; flex-direction: column; gap: 12px; padding: 20px; background: var(--paper-0); border: var(--b-quiet) solid var(--line-300); border-radius: var(--r-card); }
.tm-sh__card-title { margin: 0; font-size: 15px; line-height: 22px; font-weight: 700; }
.tm-sh__panel-title { margin: 0; font-size: 18px; line-height: 24px; font-weight: 700; }
.tm-sh__sub { margin: 0; font-size: var(--t-caption); line-height: var(--t-caption-line); color: var(--ink-650); }
.tm-sh__links, .tm-sh__checks { display: flex; flex-direction: column; gap: 12px; margin: 0; padding: 0; list-style: none; }
.tm-sh__link { font-size: var(--t-ui-md); color: var(--ink-950); text-decoration: none; }
.tm-sh__link:hover { text-decoration: underline; }
.tm-sh__check { display: flex; align-items: center; gap: 12px; }
.tm-sh__dot { flex-shrink: 0; display: grid; place-items: center; inline-size: 20px; block-size: 20px; border: 2px solid var(--line-300); border-radius: var(--r-capsule); font-size: 12px; font-weight: 700; }
.tm-sh__check[data-ok='true'] .tm-sh__dot { border-color: transparent; }
.tm-sh__check-text { flex: 1 1 auto; display: flex; flex-direction: column; gap: 2px; font-size: var(--t-caption); color: var(--ink-650); }
.tm-sh__check-text strong { font-size: var(--t-ui-md); color: var(--ink-950); }
.tm-sh__done { font-size: var(--t-caption); font-weight: 700; color: var(--ink-650); }
@media (max-width: 1100px) {
  .tm-sh { flex-direction: column; }
  .tm-sh__side { flex-basis: auto; inline-size: 100%; }
}
`;
