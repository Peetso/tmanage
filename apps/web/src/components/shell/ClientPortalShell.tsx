import { useContext } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { QueryClientContext } from '@tanstack/react-query';
import { Badge, LiveAnnouncer, SkipLink, StatusDot } from '@tmanage/ui';
import { Wordmark } from '../brand/Wordmark';
import { CLIENT_NAVIGATION } from './navigation';
import { usePortalPreview } from '../../lib/portal-preview';
import type { MessageKey } from '../../lib/i18n/t';
import { usePortalNames } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';
import { WorkspaceSuspendedGate } from '../platform/WorkspaceSuspendedGate';
import { AccountMenu } from './AccountMenu';
import { PortalMenu, usePortalShellProjects } from './PortalMenu';
import { PortalProjectSwitcher } from './PortalProjectSwitcher';
// ---- platform-admin v2 · PA-05 ----
import { ShellBanners } from './ShellBanners';
import { SupportSessionEndedGate } from '../platform/support/SupportSessionEndedGate';

/**
 * fq9's switcher in the desktop portal header. Mounted only with a `QueryClient` in the tree, and
 * drawn only once the client has more than nothing to choose between.
 */
function HeaderProjectSwitcher({
  organizationSlug,
  clientName,
  projectName,
}: {
  organizationSlug: string;
  clientName: string;
  projectName: string | undefined;
}) {
  const projects = usePortalShellProjects(organizationSlug, undefined);
  if (projects.length === 0) return null;
  return (
    <PortalProjectSwitcher
      organizationSlug={organizationSlug}
      clientName={clientName}
      projects={projects}
      variant="header"
      {...(projectName ? { fallbackProjectName: projectName } : {})}
    />
  );
}

export interface ClientPortalShellProps {
  /**
   * The organization whose portal this is, as it appears in a URL.
   *
   * Every portal destination lives under it — `CLIENT_NAVIGATION` carries the suffix and this
   * supplies the prefix — because the portal is tenant-scoped exactly as every other screen
   * is: the slug in the path is the claim the API's `TenantContextGuard` resolves against a
   * membership row before any handler runs.
   */
  organizationSlug: string;
  /** The client organization whose portal this is. Their name leads, not the vendor's. */
  clientName: string;
  /** The delivery team's name, shown as the smaller "delivered by" line. */
  providerName: string;
  /** The project, when the portal is scoped to one. `22` §1: "project selector if authorized". */
  projectName?: string;
  activeNavigationId?: string;
  title: string;
  /** The mono eyebrow over the title, e.g. "Your project · on track for the committed launch". */
  eyebrow?: ReactNode;
  description?: ReactNode;
  /** The header's trailing block — CL-01's "days to launch" / "action waiting for you" metrics. */
  headerAside?: ReactNode;
  children: ReactNode;
  /**
   * Renders the internal-facing preview chrome around the portal — the `ClientPreviewBar`
   * of the design inventory. When omitted it follows the session (2026-10-31 live-test fix,
   * Figma 446:37676): on for staff of this organization, never for a client.
   */
  preview?: boolean;
  /** The signed-in client's initials, name and email for the account menu (Figma t2-a). */
  accountInitials?: string;
  accountName?: string;
  accountEmail?: string;
}

/**
 * The client portal shell — the second of the two shells `22-SCREEN-BY-SCREEN` §1 defines.
 *
 * It is a separate component rather than `AppShell` with a flag, and that is a tenancy
 * decision rather than a styling one. `12-PERMISSION-MATRIX` and the audience rules in
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC` mean a client sees a different space, not a
 * reduced one. If the portal were the internal shell with items hidden, then every future
 * internal destination would be one forgotten filter away from appearing in it. Here there
 * is no filter to forget: `CLIENT_NAVIGATION` is the only list this component can render.
 *
 * The client's own name leads the header, with the delivery team named beneath it. That is
 * `22` §3's rule for `ID-03` — "Client invitation prominently states 'client portal access,'
 * not team membership" — carried through to the portal itself, so a client always knows
 * whose space they are in and who is delivering to them.
 */
export function ClientPortalShell({
  organizationSlug,
  clientName: passedClientName,
  providerName: passedProviderName,
  projectName,
  activeNavigationId,
  title,
  eyebrow,
  description,
  headerAside,
  children,
  preview: previewProp,
  accountInitials,
  accountName,
  accountEmail,
}: ClientPortalShellProps) {
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
  const queryClient = useContext(QueryClientContext);
  const sessionPreview = usePortalPreview(organizationSlug);
  const preview = previewProp ?? sessionPreview;
  const t = useT();
  const shell = (
    <LiveAnnouncer>
      <div className="tm-portal" data-preview={preview ? 'true' : undefined}>
        <SkipLink targetId="tm-main" />
        {/* Platform admin v2 (PA-05): Support mode banner and platform announcement. */}
        {queryClient ? (
          <ShellBanners organizationSlug={organizationSlug} organizationName={providerName} />
        ) : null}

        {preview ? (
          <div className="tm-portal__preview-bar">
            <StatusDot tone="client">{t('ClientPortalShell.previewLabel')}</StatusDot>
            <p className="tm-portal__preview-note">
              {sessionPreview && previewProp === undefined
                ? t('ClientPortalShell.previewNoteGeneric' as MessageKey)
                : t('ClientPortalShell.previewNote').replace('{client}', clientName)}
            </p>
          </div>
        ) : null}

        {/* CL-01: one light bar — the brand orb with the client and their delivery team, the
            portal's destinations as capsules, and the audience/project context at the end. */}
        <header className="tm-portal__header">
          <div className="tm-portal__identity">
            <span className="tm-portal__mark">
              <Wordmark variant="icon" label="TManage" />
            </span>
            <div>
              <p className="tm-portal__client">{clientName}</p>
              {/* Held back while the organization's name is still unknown, so the line never ends in
                  a dangling "Delivered by". */}
              {providerName ? (
                <p className="tm-portal__provider">
                  {t('ClientPortalShell.deliveredBy').replace('{provider}', providerName)}
                </p>
              ) : null}
            </div>
          </div>

          {/* Phone (ph-portal): the capsules give way to the black "Menu" card. */}
          <PortalMenu
            organizationSlug={organizationSlug}
            clientName={clientName}
            {...(projectName ? { projectName } : {})}
            {...(activeNavigationId ? { activeNavigationId } : {})}
          />

          <nav className="tm-portal__nav" aria-label={t('shell.rail.primary')}>
            <ul className="tm-portal__nav-list">
              {CLIENT_NAVIGATION.map((item) => {
                const current = item.id === activeNavigationId;
                return (
                  <li key={item.id}>
                    <Link
                      href={`/${organizationSlug}${item.href}`}
                      className="tm-portal__nav-item"
                      {...(current ? { 'aria-current': 'page' as const } : {})}
                    >
                      <span className="tm-portal__nav-glyph" aria-hidden="true">
                        {item.glyph}
                      </span>
                      {t(item.messageKey)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="tm-portal__context">
            {queryClient ? (
              <HeaderProjectSwitcher
                organizationSlug={organizationSlug}
                clientName={clientName}
                projectName={projectName}
              />
            ) : null}
            <Badge tone="client" mono>
              {t('ClientPortalShell.badge')}
            </Badge>
            <AccountMenu
              organizationSlug={organizationSlug}
              placement="header"
              {...(accountInitials ? { initials: accountInitials } : {})}
              {...(accountName ? { name: accountName } : {})}
              {...(accountEmail ? { email: accountEmail } : {})}
            />
          </div>
        </header>

        <main id="tm-main" className="tm-portal__canvas" tabIndex={-1}>
          <div className="tm-portal__page-head">
            <div className="tm-portal__titles">
              {eyebrow || projectName ? (
                <p className="tm-portal__eyebrow">{eyebrow ?? projectName}</p>
              ) : null}
              <h1 className="tm-portal__title">{title}</h1>
              {description ? <p className="tm-portal__description">{description}</p> : null}
            </div>
            {headerAside ? <div className="tm-portal__aside">{headerAside}</div> : null}
          </div>
          {children}
        </main>
      </div>
    </LiveAnnouncer>
  );
  // A suspended company's client portal shows the same "workspace suspended" page.
  return queryClient ? (
    <SupportSessionEndedGate organizationSlug={organizationSlug}>
      <WorkspaceSuspendedGate organizationSlug={organizationSlug}>{shell}</WorkspaceSuspendedGate>
    </SupportSessionEndedGate>
  ) : (
    shell
  );
}
