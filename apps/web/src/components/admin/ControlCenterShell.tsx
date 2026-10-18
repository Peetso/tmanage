'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/admin.css';

/** The Control Center destinations the section map can mark as current. */
export type ControlCenterSection =
  | 'overview'
  | 'members'
  | 'roles'
  | 'offboarding'
  | 'automations'
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
      { id: 'overview', label: 'Overview', href: '/admin' },
      { id: 'members', label: 'Members and roles', href: '/people' },
      { id: 'roles', label: 'Roles', href: '/admin/roles' },
      { id: 'offboarding', label: 'Offboarding', href: '/people/offboarding' },
    ],
  },
  {
    label: 'Work setup',
    items: [
      { id: 'automations', label: 'Automations', href: '/admin/automations/webhooks' },
      { id: 'modules', label: 'Modules', href: '/admin/feature-flags' },
    ],
  },
  {
    label: 'Trust',
    items: [
      { id: 'security', label: 'Security', href: '/admin/security' },
      { id: 'sessions', label: 'Sessions', href: '/admin/sessions' },
      { id: 'ip-allowlist', label: 'IP ranges', href: '/admin/ip-allowlist' },
      { id: 'policies', label: 'Access policy', href: '/policies' },
      { id: 'policy-simulation', label: 'Policy simulation', href: '/policies/simulate' },
      { id: 'audit', label: 'Audit log', href: '/admin/audit' },
      { id: 'data', label: 'Data and export', href: '/admin/audit/export' },
    ],
  },
];

const FOOT: readonly SectionLink[] = [
  { id: 'organization', label: 'Organization', href: '/settings' },
  { id: 'billing', label: 'Billing', href: '/billing' },
];

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

/** The ADM-01 section map. Exported so a screen can compose it with its own rail content. */
export function ControlCenterSections({
  organizationSlug,
  section,
}: {
  organizationSlug: string;
  section: ControlCenterSection;
}) {
  return (
    <div className="tm-cc-sections">
      {GROUPS.map((group) => (
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
      <ul className="tm-cc-sections__group tm-cc-sections__group--foot">
        {FOOT.map((item) => (
          <SectionItem
            key={item.id}
            organizationSlug={organizationSlug}
            item={item}
            current={item.id === section}
          />
        ))}
      </ul>
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
   * The left column. `sections` draws ADM-01's section map; a node replaces it (ADM-03's role
   * list); omitted, the canvas runs full width as ADM-08 … ADM-14 draw it.
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
  const contextRail =
    rail === 'sections' ? (
      <ControlCenterSections organizationSlug={organizationSlug} section={section} />
    ) : (
      rail
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
      {...(contextRail ? { contextRail } : {})}
    >
      {children}
    </AppShell>
  );
}
