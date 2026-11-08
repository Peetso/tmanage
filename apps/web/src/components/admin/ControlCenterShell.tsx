'use client';

import Link from 'next/link';
import { useContext } from 'react';
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
import '../../styles/screens/admin.css';
import './control-center.css';
import { ThemeSync } from '../shell/ThemeSync';

/** The Control Center destinations a screen can say it is. */
export type ControlCenterSection =
  | 'overview'
  | 'members'
  | 'roles'
  | 'client-organizations'
  | 'invitations'
  | 'offboarding'
  | 'templates'
  | 'fields'
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
  | 'data'
  // D5 (Figma F5): data export and deletion requests, owner-only.
  | 'privacy'
  | 'organization'
  | 'billing'
  // A10b: the finance home, after Billing in the last group.
  | 'finance';

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
        href: '/settings',
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
  data: 'database',
  storage: 'cloud',
  privacy: 'lock',
  organization: 'building',
  billing: 'creditCard',
  finance: 'receipt',
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
  if (item.href === undefined) {
    return (
      <li>
        <span className="tm-cc-sections__item tm-cc-sections__item--static">
          <SectionIcon id={item.id} />
          {t(item.labelKey)}
        </span>
      </li>
    );
  }
  return (
    <li>
      <Link
        href={`/${organizationSlug}${item.href}`}
        className="tm-cc-sections__item"
        // 2026-10-31 live test: viewport prefetch of all ~20 Control center links at once drew
        // HTTP 503s from the shared host (13 of 19 RSC prefetches). Fetch a section on click.
        prefetch={false}
        {...(current ? { 'aria-current': 'page' as const } : {})}
      >
        <SectionIcon id={item.id} />
        {t(item.labelKey)}
        {item.id === 'storage' ? (
          <StorageProviderBadge organizationSlug={organizationSlug} />
        ) : null}
      </Link>
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
  const label = storageProviderLabel(status.data?.storageMode);
  return label ? <span className="tm-cc-sections__badge">{label}</span> : null;
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
  return (
    <div className="tm-cc-sections">
      {groups.map((group) => (
        <div key={group.labelKey}>
          <p className="tm-cc-sections__label">{t(group.labelKey)}</p>
          <ul className="tm-cc-sections__group">
            {group.items.map((item) => (
              <SectionItem
                key={item.id}
                organizationSlug={organizationSlug}
                item={item}
                current={item.id === marked}
              />
            ))}
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
