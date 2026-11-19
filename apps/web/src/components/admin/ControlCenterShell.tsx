'use client';

import Link from 'next/link';
import { useContext, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query';
import { LiveAnnouncer, SkipLink } from '@tmanage/ui';
import type { Capability } from '@tmanage/domain';
import { Wordmark } from '../brand/Wordmark';
import { NavIcon, type PhoneIconName } from '../icons/phone';
import { BetaTag } from '../shell/BetaTag';
import { MaintenanceBanner } from '../screens/MaintenanceBanner';
import { CommandPalette } from '../screens/CommandPalette';
import { MembershipGoneGate } from '../shell/MembershipGoneGate';
import { WorkspaceSuspendedGate } from '../platform/WorkspaceSuspendedGate';
import { browserApiClient } from '../../lib/api/browser-client';
import { getConnectedApps } from '../../lib/api/connected-apps';
import { getStorageStatus } from '../../lib/api/google-drive';
import type { ApiClient } from '../../lib/api/client';
import { useOrganizationName, useOrganizationRole } from '../../lib/use-organization-names';
import { roleMayUse } from '../../lib/role-capability';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { HelpTip } from '../help/HelpTip';
import { FeatureOn } from '../shell/FeatureOn';
import type { OptionalModuleFlag } from '../../lib/api/admin-feature-flags';
import { PendingAiActionsBadge } from '../ai-actions/pending-ai-actions';
import '../../styles/screens/admin.css';
import './control-center.css';
import { ThemeSync } from '../shell/ThemeSync';
import { BrandLogo } from '../brand/BrandLogo';

/** The Control Center destinations a screen can say it is. */
export type ControlCenterSection =
  | 'overview'
  | 'members'
  | 'roles'
  | 'client-organizations'
  | 'invitations'
  // 57-08 REFERRAL: the owner's invite link for other companies (People, under Invitations).
  | 'invite-agencies'
  // 62-A1c (B12): the owner's alert rules (Plan 62 signals), owner only, behind `business_briefing`.
  | 'alerts'
  | 'offboarding'
  | 'templates'
  | 'fields'
  // 53-02: the company working calendar (working days, hours, holidays).
  | 'working-calendar'
  | 'automations'
  | 'integrations'
  | 'connected-apps'
  | 'storage'
  | 'modules'
  | 'security'
  // A17: incidents that touch this workspace, owner-only.
  | 'incidents'
  | 'sessions'
  | 'ip-allowlist'
  | 'policies'
  | 'policy-simulation'
  | 'audit'
  // 56-07p: every public link the workspace issued, owner and admin.
  | 'public-links'
  | 'data'
  // D5 (Figma F5): data export and deletion requests, owner-only.
  | 'privacy'
  | 'organization'
  | 'billing'
  // A10b: the finance home, after Billing in the last group.
  | 'finance'
  // FIX2 item 4: the personal settings, so every settings page has the same menu.
  | 'settings-home'
  | 'preferences'
  | 'notifications'
  | 'display'
  | 'accessibility'
  | 'quiet-hours'
  | 'digest'
  | 'startup'
  | 'my-data'
  | 'sign-in-security'
  | 'two-step'
  | 'access-tokens'
  | 'calendar-connections'
  | 'ai-assistant'
  // 55-15p: the actions an AI assistant asked for, waiting for the member's approval.
  | 'ai-actions'
  | 'inbound-mail';

/**
 * The P11 keys, written to the wave's i18n fragment (`i18n-P11.*.json`) and merged into the
 * catalogs by the integrator. `ccKey` keeps every call site typed against this list.
 */
export type ControlCenterKey =
  | 'ControlCenter.breadcrumbLabel'
  | 'ControlCenter.menuLabel'
  | 'ControlCenter.clientOrganizations'
  | 'ControlCenter.invitations'
  | 'ControlCenter.templatesAndWorkflows'
  | 'ControlCenter.fieldsAndStatuses'
  | 'ControlCenter.dataAndRetention'
  | 'ControlCenter.viewOwner'
  | 'ControlCenter.viewAdmin'
  | 'ControlCenter.viewMember';

export function ccKey(key: ControlCenterKey | `ControlCenter.${string}`): MessageKey {
  return key as string as MessageKey;
}

interface SectionLink {
  readonly id: ControlCenterSection;
  readonly labelKey: MessageKey;
  /** None: the destination has no screen yet; the entry is drawn as in the frame but not linked. */
  readonly href?: string;
  /**
   * What the page's API asks for (CQ-06). An entry the caller's role cannot use is not drawn, so
   * the menu never offers a page that answers "You do not have permission". None: open to everyone.
   */
  readonly capability?: Capability;
  /** English for a label whose key reaches the catalogs through an i18n fragment (`useTOr`). */
  readonly fallback?: string;
  /** Drawn for the workspace owner only (the page's API refuses every other role). */
  readonly ownerOnly?: boolean;
  /** Drawn only while this rollout flag resolves on (the page's API answers 404 while it is off). */
  readonly feature?: OptionalModuleFlag;
}

interface SectionGroup {
  readonly labelKey: MessageKey;
  readonly items: readonly SectionLink[];
}

/**
 * OPS-1's menu (Figma 370:1411, the same menu as S0-2 Connected apps): People · Work setup ·
 * Trust, with Organization and Billing closing the Trust list. Order and labels are the frame's.
 */
const GROUPS: readonly SectionGroup[] = [
  /*
   * FIX2 item 4 (Peter, 2026-11-09: "some settings pages have a side menu and some do not").
   * Every settings page — the person's own and the company's — is drawn in this one frame, so the
   * menu opens with the person's own settings (open to every member), then the company groups.
   */
  {
    labelKey: 'SettingsHome.group.you' as MessageKey,
    items: [
      { id: 'settings-home', labelKey: 'RouteTitle.settings' as MessageKey, href: '/settings' },
      { id: 'preferences', labelKey: 'RouteTitle.preferences' as MessageKey, href: '/preferences' },
      {
        id: 'notifications',
        labelKey: 'RouteTitle.inboxNotificationPreferences' as MessageKey,
        href: '/inbox/notification-preferences',
      },
      {
        id: 'display',
        labelKey: 'SettingsHome.link.display' as MessageKey,
        href: '/settings/display',
      },
      {
        id: 'accessibility',
        labelKey: 'SettingsHome.link.accessibility' as MessageKey,
        href: '/settings/accessibility',
      },
      {
        id: 'quiet-hours',
        labelKey: 'RouteTitle.settingsQuietHours' as MessageKey,
        href: '/settings/quiet-hours',
      },
      {
        id: 'digest',
        labelKey: 'SettingsHome.link.digest' as MessageKey,
        href: '/settings/digest',
      },
      {
        id: 'startup',
        labelKey: 'RouteTitle.settingsStartup' as MessageKey,
        href: '/settings/startup',
      },
      {
        id: 'my-data',
        labelKey: 'SettingsHome.link.myData' as MessageKey,
        href: '/settings/my-data',
      },
    ],
  },
  {
    labelKey: 'SettingsHome.group.security' as MessageKey,
    items: [
      {
        id: 'sign-in-security',
        labelKey: 'RouteTitle.settingsSignInSecurity' as MessageKey,
        href: '/settings/sign-in-security',
      },
      {
        id: 'two-step',
        labelKey: 'RouteTitle.settingsTwoStep' as MessageKey,
        href: '/settings/two-step',
      },
      {
        id: 'access-tokens',
        labelKey: 'SettingsHome.link.accessTokens' as MessageKey,
        href: '/settings/security',
      },
    ],
  },
  {
    labelKey: 'SettingsHome.group.connections' as MessageKey,
    items: [
      {
        id: 'calendar-connections',
        labelKey: 'SettingsHome.link.calendarConnections' as MessageKey,
        href: '/settings/calendar-connections',
      },
      {
        id: 'ai-assistant',
        labelKey: 'SettingsHome.link.aiAssistant' as MessageKey,
        href: '/settings/ai-assistant',
      },
      // 55-15p (Figma 715:39681): under AI assistant, with the amber "2 waiting" capsule.
      {
        id: 'ai-actions',
        labelKey: 'AiAssistantScreen.navAiActions' as MessageKey,
        fallback: 'AI actions',
        href: '/settings/ai-actions',
        capability: 'ai.use',
      },
      {
        id: 'inbound-mail',
        labelKey: 'SettingsHome.link.inboundMail' as MessageKey,
        href: '/settings/inbound-mail',
      },
    ],
  },
  {
    labelKey: 'ControlCenterShell.groupPeople',
    items: [
      {
        id: 'overview',
        labelKey: 'ControlCenterShell.overview',
        href: '/admin',
        capability: 'org.manage',
      },
      { id: 'members', labelKey: 'ControlCenterShell.membersAndRoles', href: '/people' },
      {
        id: 'roles',
        labelKey: 'ControlCenterShell.roles',
        href: '/admin/roles',
        capability: 'org.manage',
      },
      {
        id: 'client-organizations',
        labelKey: ccKey('ControlCenter.clientOrganizations'),
        capability: 'org.manage',
      },
      {
        id: 'invitations',
        labelKey: ccKey('ControlCenter.invitations'),
        href: '/people',
        capability: 'org.manage',
      },
      // 57-08 REFERRAL (Figma 724:39837; review B point 7): directly under Invitations, owner only.
      {
        id: 'invite-agencies',
        labelKey: 'InviteAgencies.navLabel' as MessageKey,
        fallback: 'Invite companies',
        href: '/admin/invite-agencies',
        capability: 'org.manage',
        ownerOnly: true,
      },
      // 62-A1c (B12; FIGMA-D fix 29): the alert rules, owner only, while the briefing is on.
      {
        id: 'alerts',
        labelKey: ccKey('ControlCenter.alerts'),
        fallback: 'Alerts',
        href: '/settings/alerts',
        capability: 'org.manage',
        ownerOnly: true,
        feature: 'business_briefing',
      },
    ],
  },
  {
    labelKey: 'ControlCenterShell.groupWorkSetup',
    items: [
      {
        id: 'templates',
        labelKey: ccKey('ControlCenter.templatesAndWorkflows'),
        href: '/projects/templates',
        capability: 'org.manage',
      },
      {
        id: 'fields',
        labelKey: ccKey('ControlCenter.fieldsAndStatuses'),
        capability: 'org.manage',
      },
      {
        id: 'working-calendar',
        labelKey: ccKey('ControlCenter.workingCalendar'),
        href: '/admin/working-calendar',
        capability: 'org.manage',
      },
      // AUT-04: the rule library, not Webhooks. Webhooks sit under Integrations, as in the design.
      {
        id: 'automations',
        labelKey: 'ControlCenterShell.automations',
        href: '/automations',
        capability: 'org.manage',
      },
      {
        id: 'integrations',
        labelKey: 'ControlCenterShell.integrations',
        href: '/automations/apps',
        capability: 'org.manage',
      },
      // S11 (Figma S0-2): every internal member manages the AI apps they connected.
      {
        id: 'connected-apps',
        labelKey: 'ControlCenterShell.connectedApps',
        href: '/settings/connected-apps',
        capability: 'work.read',
      },
    ],
  },
  {
    labelKey: 'ControlCenterShell.groupTrust',
    items: [
      {
        id: 'security',
        labelKey: 'ControlCenterShell.security',
        href: '/admin/security',
        capability: 'org.manage',
      },
      {
        id: 'incidents',
        labelKey: 'Incidents.title',
        href: '/admin/incidents',
        capability: 'org.manage',
      },
      {
        id: 'audit',
        labelKey: 'ControlCenterShell.auditLog',
        href: '/admin/audit',
        capability: 'audit.read',
      },
      // 56-07p (Figma 619:35204): after Audit log, as in the frame.
      {
        id: 'public-links',
        labelKey: ccKey('ControlCenter.publicLinks'),
        href: '/admin/public-links',
        capability: 'org.security.manage',
      },
      {
        id: 'data',
        labelKey: ccKey('ControlCenter.dataAndRetention'),
        href: '/admin/audit/export',
        capability: 'audit.export',
      },
      // Google Drive storage: the Drive attach error sends people to "Storage in Control".
      // `org.manage` is what the storage API asks to change the connection.
      {
        id: 'storage',
        labelKey: 'ControlCenterShell.storage',
        href: '/admin/storage',
        capability: 'org.manage',
      },
      // D5 (Figma F5): between "Data and retention" and "Organization", as in the frame.
      {
        id: 'privacy',
        labelKey: ccKey('ControlCenter.privacy'),
        href: '/admin/privacy',
        capability: 'org.manage',
      },
      {
        id: 'organization',
        labelKey: 'ControlCenterShell.organization',
        href: '/settings/organization',
        capability: 'org.manage',
      },
      {
        id: 'billing',
        labelKey: 'ControlCenterShell.billing',
        href: '/billing',
        capability: 'org.manage',
      },
      {
        id: 'finance',
        labelKey: ccKey('ControlCenter.finance'),
        href: '/finance',
        capability: 'finance.view',
      },
    ],
  },
];

/**
 * R38 G3 (Figma "R38 G3-icons"): each menu entry leads with the line icon that means its page, so
 * Security reads as a shield and Billing as a card. Keyed by entry id; an entry without one is
 * drawn with its word alone.
 */
export const SECTION_ICONS: Partial<Record<ControlCenterSection, PhoneIconName>> = {
  overview: 'layoutDashboard',
  members: 'users',
  roles: 'key',
  'client-organizations': 'handshake',
  invitations: 'userPlus',
  templates: 'layoutTemplate',
  fields: 'tag',
  automations: 'zap',
  integrations: 'puzzle',
  'connected-apps': 'plug',
  security: 'shield',
  incidents: 'alert',
  audit: 'listChecks',
  'public-links': 'lock',
  'invite-agencies': 'mail',
  alerts: 'bell',
  data: 'database',
  storage: 'cloud',
  privacy: 'lock',
  organization: 'building',
  billing: 'creditCard',
  finance: 'receipt',
  'settings-home': 'settings',
  preferences: 'sliders',
  notifications: 'bell',
  display: 'sun',
  accessibility: 'eye',
  'quiet-hours': 'clock',
  digest: 'mail',
  startup: 'home',
  'my-data': 'database',
  'sign-in-security': 'shield',
  'two-step': 'key',
  'access-tokens': 'key',
  'calendar-connections': 'calendar',
  'ai-assistant': 'zap',
  'ai-actions': 'listChecks',
  'inbound-mail': 'inbox',
};

function SectionIcon({ id }: { id: ControlCenterSection }) {
  const icon = SECTION_ICONS[id];
  return icon ? <NavIcon name={icon} size={16} className="tm-cc-sections__icon" /> : null;
}

/**
 * Sub-pages the frame's menu does not list are reached from their parent page; the parent stays
 * marked while one is open, so the menu always says where the person is.
 */
const MENU_ENTRY_FOR: Partial<Record<ControlCenterSection, ControlCenterSection>> = {
  offboarding: 'members',
  sessions: 'security',
  'ip-allowlist': 'security',
  policies: 'security',
  'policy-simulation': 'security',
  modules: 'organization',
};

export function menuEntryFor(section: ControlCenterSection): ControlCenterSection {
  return MENU_ENTRY_FOR[section] ?? section;
}

/**
 * May a person with this role use the entry? Pure, so it is provable without a render. `null` is
 * "the role cannot be read here" (no query client — a story), where every entry is drawn. A
 * custom role (H1) is judged by its loaded `capabilities`, not skipped.
 */
export function mayOpenSection(
  role: string | undefined | null,
  item: SectionLink,
  capabilities?: readonly string[],
): boolean {
  if (item.ownerOnly === true && role !== null && role !== undefined && role !== 'owner') {
    return false;
  }
  if (item.capability === undefined || role === null) return true;
  return roleMayUse(role, capabilities, item.capability);
}

/** The menu's groups minus the entries this role would be refused. `foot` is kept empty. */
export function controlCenterSectionsFor(
  role: string | undefined | null,
  capabilities?: readonly string[],
): {
  readonly groups: readonly SectionGroup[];
  readonly foot: readonly SectionLink[];
} {
  return {
    groups: GROUPS.map((group) => ({
      labelKey: group.labelKey,
      items: group.items.filter((item) => mayOpenSection(role, item, capabilities)),
    })).filter((group) => group.items.length > 0),
    foot: [],
  };
}

function SectionItem({
  organizationSlug,
  item,
  current,
}: {
  organizationSlug: string;
  item: SectionLink;
  current: boolean;
}) {
  const t = useT();
  const tOr = useTOr();
  const label = item.fallback === undefined ? t(item.labelKey) : tOr(item.labelKey, item.fallback);
  if (item.href === undefined) {
    return (
      <li>
        <span className="tm-cc-sections__item tm-cc-sections__item--static">
          <SectionIcon id={item.id} />
          {label}
        </span>
      </li>
    );
  }
  const tip = tOr(`ControlCenterHelp.${item.id}`, '');
  const link = (
    <Link
      href={`/${organizationSlug}${item.href}`}
      className="tm-cc-sections__item"
      // 2026-10-31 live test: viewport prefetch of all ~20 Control center links at once drew
      // HTTP 503s from the shared host (13 of 19 RSC prefetches). Fetch a section on click.
      prefetch={false}
      {...(current ? { 'aria-current': 'page' as const } : {})}
    >
      <SectionIcon id={item.id} />
      {label}
      {item.id === 'storage' ? <StorageProviderBadge organizationSlug={organizationSlug} /> : null}
      {item.id === 'ai-actions' ? (
        <PendingAiActionsBadge organizationSlug={organizationSlug} />
      ) : null}
    </Link>
  );
  return (
    <li>
      {tip === '' ? (
        link
      ) : (
        <HelpTip tip={tip} placement="end" block>
          {link}
        </HelpTip>
      )}
    </li>
  );
}

/** The company storage's provider by name, for the menu badge; null for TManage storage. */
export function storageProviderLabel(mode: string | undefined): string | null {
  if (mode === 'google_drive') return 'Google Drive';
  if (mode === 'onedrive') return 'OneDrive';
  return null;
}

/**
 * 0236 (Figma 395:5683 / 395:6304): the Storage entry names the active provider. The entry is
 * drawn only for `org.manage`, the storage read is open to `work.read`; under the Storage screen's
 * own query key, so the two share one request.
 */
function StorageProviderBadge({ organizationSlug }: { organizationSlug: string }) {
  const queryClient = useContext(QueryClientContext);
  const status = useQuery(
    {
      queryKey: ['storage-status', organizationSlug],
      queryFn: () => getStorageStatus(browserApiClient(), organizationSlug),
      staleTime: 60_000,
      retry: false,
      enabled: queryClient !== undefined,
    },
    queryClient ?? IDLE_QUERY_CLIENT,
  );
  const mode = status.data?.storageMode;
  const label = storageProviderLabel(mode);
  return label ? (
    <span className="tm-cc-sections__badge">
      <BrandLogo
        brand={mode === 'onedrive' ? 'onedrive' : 'google-drive'}
        size={20}
        className="tm-brand-logo--inline"
      />
      {label}
    </span>
  ) : null;
}

/**
 * Scrolls `menu` (and only the menu, never the page) so `entry` sits in its middle, when the entry
 * is outside the menu's visible box. A menu that does not scroll is left as it is.
 */
export function revealInMenu(entry: HTMLElement, menu: HTMLElement): void {
  const item = entry.getBoundingClientRect();
  const box = menu.getBoundingClientRect();
  if (item.top >= box.top && item.bottom <= box.bottom) return;
  menu.scrollTop += item.top - box.top - (box.height - item.height) / 2;
}

/**
 * The OPS-1 menu. Exported so a screen outside `ControlCenterShell` can draw it too; `children`
 * (a screen's own list, such as ADM-03's roles) sits under the groups.
 */
export function ControlCenterSections({
  organizationSlug,
  section,
  children,
}: {
  organizationSlug: string;
  section: ControlCenterSection;
  children?: ReactNode;
}) {
  // While the role is being read nothing gated is drawn, so a refused entry never flashes up.
  const t = useT();
  const { role, capabilities, known, unavailable } = useOrganizationRole(organizationSlug);
  const { groups } = controlCenterSectionsFor(
    unavailable ? null : known ? role : undefined,
    capabilities,
  );
  const marked = menuEntryFor(section);
  const sectionsRef = useRef<HTMLDivElement>(null);
  const drawnEntries = groups.reduce((count, group) => count + group.items.length, 0);
  // The menu scrolls on its own and is longer than a laptop screen, so an entry low in it (Billing,
  // Automations) was marked but out of sight: bring the marked entry into the menu's view.
  useEffect(() => {
    const current = sectionsRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    const menu = current?.closest<HTMLElement>('.tm-cc-menu');
    if (current && menu) revealInMenu(current, menu);
  }, [marked, drawnEntries]);
  return (
    <div className="tm-cc-sections" ref={sectionsRef}>
      {groups.map((group) => (
        <div key={group.labelKey}>
          <p className="tm-cc-sections__label">{t(group.labelKey)}</p>
          <ul className="tm-cc-sections__group">
            {group.items.map((item) => {
              const entry = (
                <SectionItem
                  key={item.id}
                  organizationSlug={organizationSlug}
                  item={item}
                  current={item.id === marked}
                />
              );
              return item.feature === undefined ? (
                entry
              ) : (
                <FeatureOn key={item.id} organizationSlug={organizationSlug} flag={item.feature}>
                  {entry}
                </FeatureOn>
              );
            })}
          </ul>
        </div>
      ))}
      {children}
    </div>
  );
}

/** "Maya Hassan" → "MH". */
export function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

/** OPS-1's eyebrow role: "Owner view", "Admin view", "Member view". */
function viewKeyFor(role: string | undefined): MessageKey | null {
  if (role === undefined) return null;
  if (role === 'owner') return ccKey('ControlCenter.viewOwner');
  if (role === 'org_admin' || role === 'admin') return ccKey('ControlCenter.viewAdmin');
  return ccKey('ControlCenter.viewMember');
}

/**
 * The signed-in person's name. No identity read exists for the web yet; the Connected apps read
 * (open to every internal member) carries `viewerName`, under the screen's own query key so the
 * two share one request. Absent a query client or on a refusal there is simply no name.
 */
/** Stands in when no `QueryClientProvider` is mounted, so the hook never throws; never fetches. */
const IDLE_QUERY_CLIENT = new QueryClient();

function useViewerName(organizationSlug: string, client: ApiClient | undefined): string | null {
  const queryClient = useContext(QueryClientContext);
  const viewer = useQuery(
    {
      queryKey: ['connected-apps', organizationSlug],
      queryFn: () => getConnectedApps(client ?? browserApiClient(), organizationSlug),
      staleTime: 60_000,
      retry: false,
      enabled: queryClient !== undefined,
    },
    queryClient ?? IDLE_QUERY_CLIENT,
  );
  return viewer.data?.viewerName || null;
}

export interface ControlCenterShellProps {
  organizationSlug: string;
  organizationName: string;
  /** The destination this screen is, for the menu and the breadcrumb. */
  section: ControlCenterSection;
  /** The breadcrumb after "Control center" — e.g. `['Roles', 'Project manager']`. */
  crumbs: readonly string[];
  title: string;
  titleMeta?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /**
   * The menu is always drawn. A node (ADM-03's role list) is drawn inside it, under the groups;
   * `'sections'` is the menu alone.
   */
  rail?: 'sections' | ReactNode;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
  children: ReactNode;
}

/**
 * The Control Center frame (OPS-1, Figma 370:1411 / 370:1699): a white top bar with the brand orb,
 * the mono breadcrumb (CONTROL CENTER / section), the workspace pill and the person's avatar; the
 * grouped menu on the paper column; and the page — role eyebrow, headline, description — on the
 * canvas. Logical properties throughout, so Arabic mirrors it (menu on the right).
 */
export function ControlCenterShell({
  organizationSlug,
  organizationName,
  section,
  crumbs,
  title,
  titleMeta,
  description,
  actions,
  rail,
  client,
  children,
}: ControlCenterShellProps) {
  const t = useT();
  const queryClient = useContext(QueryClientContext);
  const workspace = useOrganizationName(organizationSlug, organizationName);
  const { role, known } = useOrganizationRole(organizationSlug);
  const viewerName = useViewerName(organizationSlug, client);
  const viewKey = viewKeyFor(known ? role : undefined);
  const eyebrow = [viewKey ? t(viewKey) : null, viewerName].filter(Boolean).join(' · ');
  const trail = [t('ControlCenterShell.controlCenter'), ...crumbs];

  const shell = (
    <LiveAnnouncer label={t('Shell.liveAnnouncements')}>
      <div className="tm-app tm-cc-app">
        <SkipLink targetId="tm-main">{t('Shell.skipLink')}</SkipLink>
        <MaintenanceBanner />
        {queryClient ? <CommandPalette organizationSlug={organizationSlug} /> : null}
        {/* PREF-02: the member's saved theme here too (the app shell has its own). */}
        {queryClient ? <ThemeSync organizationSlug={organizationSlug} /> : null}

        <header className="tm-cc-topbar">
          <Link href={`/${organizationSlug}/home`} className="tm-cc-topbar__brand">
            <Wordmark variant="icon" label={t('shell.brand.home')} />
          </Link>
          <BetaTag placement="topbar" />
          <nav
            aria-label={t(ccKey('ControlCenter.breadcrumbLabel'))}
            className="tm-cc-topbar__trail"
          >
            <ol className="tm-cc-crumbs">
              {trail.map((crumb, index) => (
                <li
                  key={`${index}-${crumb}`}
                  {...(index === trail.length - 1 ? { 'aria-current': 'page' as const } : {})}
                >
                  {crumb}
                </li>
              ))}
            </ol>
          </nav>
          <div className="tm-cc-topbar__end">
            {workspace ? <span className="tm-cc-workspace">{workspace}</span> : null}
            <Link
              href={`/${organizationSlug}/preferences`}
              className="tm-cc-avatar"
              aria-label={t('shell.account.preferences')}
            >
              <span aria-hidden="true">{viewerName ? initialsOf(viewerName) : ''}</span>
            </Link>
          </div>
        </header>

        <div className="tm-cc-frame">
          <nav className="tm-cc-menu" aria-label={t(ccKey('ControlCenter.menuLabel'))}>
            <ControlCenterSections organizationSlug={organizationSlug} section={section}>
              {rail === 'sections' ? null : rail}
            </ControlCenterSections>
          </nav>

          <main id="tm-main" className="tm-canvas tm-cc-main" tabIndex={-1}>
            <header className="tm-canvas-header" data-title-variant="page" data-actions="end">
              <div className="tm-canvas-header__titles">
                {eyebrow ? <p className="tm-canvas-header__context">{eyebrow}</p> : null}
                <div className="tm-canvas-header__title-row">
                  <h1 className="tm-canvas-header__title">{title}</h1>
                  {titleMeta ? <span className="tm-canvas-header__meta">{titleMeta}</span> : null}
                  {actions ? <div className="tm-canvas-header__actions">{actions}</div> : null}
                </div>
                {description ? (
                  <p className="tm-canvas-header__description">{description}</p>
                ) : null}
              </div>
            </header>
            {children}
          </main>
        </div>
      </div>
    </LiveAnnouncer>
  );
  return queryClient ? (
    <MembershipGoneGate organizationSlug={organizationSlug}>
      <WorkspaceSuspendedGate organizationSlug={organizationSlug}>{shell}</WorkspaceSuspendedGate>
    </MembershipGoneGate>
  ) : (
    shell
  );
}
