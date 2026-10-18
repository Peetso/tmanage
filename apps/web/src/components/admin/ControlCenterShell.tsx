'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { hasCapability, isRole } from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';
import { AppShell } from '../shell/AppShell';
import { useOrganizationRole } from '../../lib/use-organization-names';
import '../../styles/screens/admin.css';

/** The Control Center destinations the section map can mark as current. */
export type ControlCenterSection =
  | 'overview'
  | 'members'
  | 'roles'
  | 'offboarding'
  | 'automations'
  | 'integrations'
  | 'modules'
  | 'security'
  | 'sessions'
  | 'ip-allowlist'
  | 'policies'
  | 'policy-simulation'
  | 'audit'
  | 'data'
  | 'organization'
  | 'billing';

interface SectionLink {
  readonly id: ControlCenterSection;
  readonly label: string;
  readonly href: string;
  /**
   * What the page's API asks for (CQ-06). An entry the caller's role cannot use is not drawn, so
   * the map never offers a page that answers "You do not have permission". None: open to everyone.
   */
  readonly capability?: Capability;
}

/**
 * ADM-01's section map, grouped as the frame groups it (People · Work setup · Trust, then
 * Organization and Billing at the foot). Every entry is a route that exists today; the frame's
 * "Client organizations", "Invitations", "Templates" and "Fields" have no Control Center route yet,
 * so they are not offered as links that would 404.
 */
const GROUPS: readonly { label: string; items: readonly SectionLink[] }[] = [
  {
    label: 'People',
    items: [
      { id: 'overview', label: 'Overview', href: '/admin', capability: 'org.manage' },
      { id: 'members', label: 'Members and roles', href: '/people' },
      { id: 'roles', label: 'Roles', href: '/admin/roles', capability: 'org.manage' },
      {
        id: 'offboarding',
        label: 'Offboarding',
        href: '/people/offboarding',
        capability: 'member.offboard',
      },
    ],
  },
  {
    label: 'Work setup',
    items: [
      // AUT-04: the rule library, not Webhooks. Webhooks sit under Integrations, as in the design.
      { id: 'automations', label: 'Automations', href: '/automations', capability: 'org.manage' },
      {
        id: 'integrations',
        label: 'Integrations',
        href: '/automations/apps',
        capability: 'org.manage',
      },
      { id: 'modules', label: 'Modules', href: '/admin/feature-flags', capability: 'org.manage' },
    ],
  },
  {
    label: 'Trust',
    items: [
      { id: 'security', label: 'Security', href: '/admin/security', capability: 'org.manage' },
      { id: 'sessions', label: 'Sessions', href: '/admin/sessions', capability: 'org.manage' },
      {
        id: 'ip-allowlist',
        label: 'IP ranges',
        href: '/admin/ip-allowlist',
        capability: 'org.security.manage',
      },
      { id: 'policies', label: 'Access policy', href: '/policies', capability: 'org.manage' },
      {
        id: 'policy-simulation',
        label: 'Policy simulation',
        href: '/policies/simulate',
        capability: 'org.manage',
      },
      { id: 'audit', label: 'Audit log', href: '/admin/audit', capability: 'audit.read' },
      {
        id: 'data',
        label: 'Data and export',
        href: '/admin/audit/export',
        capability: 'audit.export',
      },
    ],
  },
];

const FOOT: readonly SectionLink[] = [
  { id: 'organization', label: 'Organization', href: '/settings', capability: 'org.manage' },
  { id: 'billing', label: 'Billing', href: '/billing', capability: 'org.manage' },
];

/**
 * May a person with this role use the entry? Pure, so it is provable without a render. `null` is
 * "the role cannot be read here" (no query client — a story), where every entry is drawn.
 */
export function mayOpenSection(role: string | undefined | null, item: SectionLink): boolean {
  if (item.capability === undefined || role === null) return true;
  return role !== undefined && isRole(role) && hasCapability(role, item.capability);
}

/** The section map's groups and foot, minus the entries this role would be refused. */
export function controlCenterSectionsFor(role: string | undefined | null): {
  readonly groups: readonly { label: string; items: readonly SectionLink[] }[];
  readonly foot: readonly SectionLink[];
} {
  return {
    groups: GROUPS.map((group) => ({
      label: group.label,
      items: group.items.filter((item) => mayOpenSection(role, item)),
    })).filter((group) => group.items.length > 0),
    foot: FOOT.filter((item) => mayOpenSection(role, item)),
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
  return (
    <li>
      <Link
        href={`/${organizationSlug}${item.href}`}
        className="tm-cc-sections__item"
        {...(current ? { 'aria-current': 'page' as const } : {})}
      >
        {item.label}
      </Link>
    </li>
  );
}

/**
 * The ADM-01 section map. Exported so a screen outside `ControlCenterShell` can draw it too;
 * `children` (a screen's own rail group, such as ADM-03's role list) sits under the groups and
 * above the Organization / Billing foot.
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
  const { role, known, unavailable } = useOrganizationRole(organizationSlug);
  const { groups, foot } = controlCenterSectionsFor(unavailable ? null : known ? role : undefined);
  return (
    <div className="tm-cc-sections">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="tm-cc-sections__label">{group.label}</p>
          <ul className="tm-cc-sections__group">
            {group.items.map((item) => (
              <SectionItem
                key={item.id}
                organizationSlug={organizationSlug}
                item={item}
                current={item.id === section}
              />
            ))}
          </ul>
        </div>
      ))}
      {children}
      {foot.length > 0 ? (
        <ul className="tm-cc-sections__group tm-cc-sections__group--foot">
          {foot.map((item) => (
            <SectionItem
              key={item.id}
              organizationSlug={organizationSlug}
              item={item}
              current={item.id === section}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export interface ControlCenterShellProps {
  organizationSlug: string;
  organizationName: string;
  /** The destination this screen is, for the section map and the breadcrumb. */
  section: ControlCenterSection;
  /** The breadcrumb after "Control center" — e.g. `['Roles', 'Project manager']`. */
  crumbs: readonly string[];
  /** The display headline ("What needs a decision", "How people get in"). */
  title: string;
  titleMeta?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /**
   * The left column. ADM-01's section map is always drawn, so the Control Center keeps its own
   * navigation on every sub-page (it used to be drawn only on Overview and Roles, and clicking any
   * other item dropped it). A node (ADM-03's role list) is drawn inside it, under the groups.
   */
  rail?: 'sections' | ReactNode;
  children: ReactNode;
}

/**
 * The Control Center frame (ADM-01 … ADM-14) on top of the shared `AppShell`: the rail's Control
 * orb is current, the eyebrow is the frame's breadcrumb ("Control center / Security"), the
 * headline is the frame's, and the screen's own actions sit at the end of the title row.
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
  children,
}: ControlCenterShellProps) {
  const contextRail = (
    <ControlCenterSections organizationSlug={organizationSlug} section={section}>
      {rail === 'sections' ? null : rail}
    </ControlCenterSections>
  );
  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow={['Control center', ...crumbs].join(' / ')}
      title={title}
      {...(titleMeta ? { titleMeta } : {})}
      {...(description ? { description } : {})}
      {...(actions ? { actions } : {})}
      contextRail={contextRail}
    >
      {children}
    </AppShell>
  );
}
