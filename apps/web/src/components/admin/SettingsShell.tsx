'use client';

import type { ReactNode } from 'react';
import type { AppShellProps } from '../shell/AppShell';
import type { ApiClient } from '../../lib/api/client';
import { ControlCenterShell, type ControlCenterSection } from './ControlCenterShell';

export interface SettingsShellProps extends Omit<AppShellProps, 'title'> {
  /** The menu entry this page is (marked in the menu, named in the breadcrumb). */
  readonly section: ControlCenterSection;
  readonly title: string;
  /** The breadcrumb after "Control center"; the title when absent. */
  readonly crumbs?: readonly string[];
  readonly client?: ApiClient;
}

/**
 * FIX2 item 4 — the one settings frame. Every settings, preferences, billing and integrations page
 * is drawn in the Control Center frame (OPS-1: top bar with breadcrumb, the grouped side menu, the
 * page header, the same spacing), whatever shell it was written against. A screen that had its own
 * section rail (Preferences' anchors) keeps it, drawn under the menu groups; a lens or header aside
 * stays in the page.
 */
export function SettingsShell({
  organizationSlug,
  organizationName,
  section,
  title,
  crumbs,
  titleMeta,
  description,
  actions,
  contextRail,
  headerAside,
  topBar,
  lens,
  client,
  children,
}: SettingsShellProps) {
  const page: ReactNode = (
    <>
      {topBar ? <div className="tm-settings-topbar">{topBar}</div> : null}
      {headerAside ? <div className="tm-settings-aside">{headerAside}</div> : null}
      {lens ? (
        <div className="tm-settings-split">
          <div className="tm-settings-split__main">{children}</div>
          <aside className="tm-settings-split__lens">{lens}</aside>
        </div>
      ) : (
        children
      )}
    </>
  );
  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section={section}
      crumbs={crumbs ?? [title]}
      title={title}
      {...(titleMeta === undefined ? {} : { titleMeta })}
      {...(description === undefined ? {} : { description })}
      {...(actions === undefined ? {} : { actions })}
      rail={contextRail ?? 'sections'}
      {...(client ? { client } : {})}
    >
      {page}
    </ControlCenterShell>
  );
}
