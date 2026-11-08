'use client';

import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { QueryClientContext, useQuery } from '@tanstack/react-query';
import { Badge } from '@tmanage/ui';
import { NavIcon, type PhoneIconName } from '../icons/phone';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { listPortalProjects, listPortalWorkItems, type PortalProject } from '../../lib/api/portal';
import { signOut } from '../../lib/api/session';
import { authBoundary } from '../../lib/auth-boundary';
import { activeLocale } from '../../lib/i18n/locale-store';
import {
  OFFERED_LOCALES,
  isBetaLocale,
  localeLangAttribute,
  localeNativeName,
} from '../../lib/i18n/catalog-status';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import {
  PortalProjectSwitcher,
  PORTAL_PROJECT_PARAM,
  withPortalProject,
} from './PortalProjectSwitcher';

/** The query key the shell's own project read uses — apart from the screens' keys on purpose. */
export const portalShellProjectsKey = (organizationSlug: string) =>
  ['shell', 'portal-projects', organizationSlug] as const;

/** The projects shared with this client, for the shell's switcher (menu and desktop header). */
export function usePortalShellProjects(
  organizationSlug: string,
  client: ApiClient | undefined,
): readonly PortalProject[] {
  const projects = useQuery({
    queryKey: portalShellProjectsKey(organizationSlug),
    queryFn: () => listPortalProjects(client ?? browserApiClient(), organizationSlug),
    staleTime: 5 * 60_000,
  });
  return projects.data ?? [];
}

interface PortalMenuEntry {
  readonly id: string;
  readonly key: string;
  readonly english: string;
  readonly href: string;
  /** The line icon that means the destination (R38 G3). */
  readonly icon: PhoneIconName;
  /** The `CLIENT_NAVIGATION` ids this entry is current for. */
  readonly current: readonly string[];
}

/** ph-portal's destinations, in the frame's order. */
export const PORTAL_MENU_ENTRIES: readonly PortalMenuEntry[] = [
  {
    id: 'home',
    key: 'PortalMenu.home',
    english: 'Home',
    href: '/portal',
    icon: 'home',
    current: ['overview'],
  },
  {
    id: 'approvals',
    key: 'PortalMenu.approvals',
    english: 'Approvals',
    href: '/portal/actions',
    icon: 'badgeCheck',
    current: ['actions', 'deliverables'],
  },
  {
    id: 'requests',
    key: 'PortalMenu.requests',
    english: 'Requests',
    href: '/portal/requests',
    icon: 'clipboardList',
    current: ['requests'],
  },
  {
    id: 'files',
    key: 'PortalMenu.files',
    english: 'Files',
    href: '/portal/files',
    icon: 'files',
    current: ['files'],
  },
  {
    id: 'messages',
    key: 'PortalMenu.messages',
    english: 'Messages',
    href: '/portal/inbox',
    icon: 'mail',
    current: ['inbox', 'updates'],
  },
  {
    // R7 slice 3: the client's group chats.
    id: 'chat',
    key: 'PortalMenu.chat',
    english: 'Chat',
    href: '/portal/chat',
    icon: 'messages',
    current: ['chat'],
  },
];

export interface PortalMenuProps {
  organizationSlug: string;
  clientName: string;
  /** The project the screen is scoped to when the URL names none. */
  projectName?: string;
  activeNavigationId?: string;
  /** Test seam; the browser client otherwise. */
  client?: ApiClient;
}

/**
 * The compact portal menu (Figma ph-portal, 378:18411 / 379:3834): the black "Menu ▴" capsule in
 * the phone portal header opens a white card — the PROJECT block with its ⇅ switcher, Home,
 * Approvals (with the count of what waits on the client), Requests, Files, Messages, a rule, the
 * language switch and Sign out.
 *
 * A disclosure, not an ARIA menu: the card holds a nested switcher and plain links, which a
 * `role="menu"` would hide from the reading order. Escape and a tap outside close it.
 */
export function PortalMenu(props: PortalMenuProps) {
  const tOr = useTOr();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cardId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  return (
    <div ref={rootRef} className="tm-portal-menu">
      <button
        ref={triggerRef}
        type="button"
        className="tm-portal-menu__trigger"
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {tOr('PortalMenu.menu', 'Menu')}
        <span className="tm-portal-menu__caret" aria-hidden="true">
          ▴
        </span>
      </button>
      {open ? <PortalMenuCard id={cardId} {...props} onClose={close} /> : null}
    </div>
  );
}

function ApprovalsCount({
  organizationSlug,
  projectId,
  client,
}: {
  organizationSlug: string;
  projectId: string | null;
  client: ApiClient | undefined;
}) {
  const items = useQuery({
    queryKey: ['shell', 'portal-approvals', organizationSlug, projectId],
    queryFn: () =>
      listPortalWorkItems(client ?? browserApiClient(), organizationSlug, projectId ?? undefined),
    staleTime: 60_000,
  });
  const count = items.data?.filter((item) => item.progress === 'waiting_on_you').length ?? 0;
  if (count === 0) return null;
  return <span className="tm-portal-menu__count">{count}</span>;
}

function LiveSwitcher({
  organizationSlug,
  clientName,
  projectName,
  client,
  onChoose,
}: {
  organizationSlug: string;
  clientName: string;
  projectName: string | undefined;
  client: ApiClient | undefined;
  onChoose: () => void;
}) {
  const projects = usePortalShellProjects(organizationSlug, client);
  return (
    <PortalProjectSwitcher
      organizationSlug={organizationSlug}
      clientName={clientName}
      projects={projects}
      variant="menu"
      onChoose={onChoose}
      {...(projectName ? { fallbackProjectName: projectName } : {})}
    />
  );
}

/** The open card. Separate so `useRouter` runs only once it is open (bare shells in tests). */
function PortalMenuCard({
  id,
  organizationSlug,
  clientName,
  projectName,
  activeNavigationId,
  client,
  onClose,
}: PortalMenuProps & { id: string; onClose: (returnFocus: boolean) => void }) {
  const tOr = useTOr();
  const router = useRouter();
  const locale = useActiveLocale();
  const search = useSearchParams();
  const queryClient = useContext(QueryClientContext);
  const [signingOut, setSigningOut] = useState(false);
  const [failed, setFailed] = useState(false);
  const projectId = search?.get(PORTAL_PROJECT_PARAM) ?? null;
  const base = `/${organizationSlug}`;
  // R12 R2: "Language" opens the offered list in place (Figma "Languages (R2)" 501:29283).
  const [languagesOpen, setLanguagesOpen] = useState(false);

  const endSession = async () => {
    setSigningOut(true);
    setFailed(false);
    try {
      await signOut(client ?? browserApiClient());
      authBoundary.announce('signed-out');
      router.push('/sign-in');
    } catch {
      setFailed(true);
      setSigningOut(false);
    }
  };

  return (
    <div id={id} className="tm-portal-menu__card">
      {queryClient ? (
        <LiveSwitcher
          organizationSlug={organizationSlug}
          clientName={clientName}
          projectName={projectName}
          client={client}
          onChoose={() => onClose(false)}
        />
      ) : null}
      <ul className="tm-portal-menu__list">
        {PORTAL_MENU_ENTRIES.map((entry) => {
          const current = activeNavigationId ? entry.current.includes(activeNavigationId) : false;
          return (
            <li key={entry.id}>
              <Link
                href={withPortalProject(`${base}${entry.href}`, projectId)}
                className="tm-portal-menu__item"
                {...(current ? { 'aria-current': 'page' as const } : {})}
                onClick={() => onClose(false)}
              >
                <span className="tm-portal-menu__glyph" aria-hidden="true">
                  <NavIcon name={entry.icon} size={16} />
                </span>
                <span className="tm-portal-menu__label">{tOr(entry.key, entry.english)}</span>
                {entry.id === 'approvals' && queryClient ? (
                  <ApprovalsCount
                    organizationSlug={organizationSlug}
                    projectId={projectId}
                    client={client}
                  />
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
      <hr className="tm-portal-menu__rule" />
      <ul className="tm-portal-menu__list">
        <li>
          <button
            type="button"
            className="tm-portal-menu__item"
            aria-expanded={languagesOpen}
            onClick={() => setLanguagesOpen((value) => !value)}
          >
            <span className="tm-portal-menu__glyph" aria-hidden="true">
              <NavIcon name="languages" size={16} />
            </span>
            <span className="tm-portal-menu__label">{tOr('LanguagePicker.label', 'Language')}</span>
          </button>
        </li>
        {languagesOpen
          ? OFFERED_LOCALES.map((value) => (
              <li key={value}>
                {/* Each language is named in itself, as the frame draws it. */}
                <button
                  type="button"
                  className="tm-portal-menu__item"
                  aria-pressed={value === locale}
                  lang={localeLangAttribute(value)}
                  onClick={() => {
                    activeLocale.set(value);
                    onClose(false);
                  }}
                >
                  <span className="tm-portal-menu__glyph" aria-hidden="true">
                    {value === locale ? <NavIcon name="check" size={16} /> : null}
                  </span>
                  <span className="tm-portal-menu__label">{localeNativeName(value)}</span>
                  {isBetaLocale(value) ? <Badge>{tOr('LanguagePicker.beta', 'Beta')}</Badge> : null}
                </button>
              </li>
            ))
          : null}
        <li>
          <button
            type="button"
            className="tm-portal-menu__item"
            aria-disabled={signingOut || undefined}
            onClick={() => {
              if (!signingOut) void endSession();
            }}
          >
            <span className="tm-portal-menu__glyph" aria-hidden="true">
              <NavIcon name="logOut" size={16} />
            </span>
            <span className="tm-portal-menu__label">
              {signingOut
                ? tOr('PortalMenu.signingOut', 'Signing out')
                : tOr('PortalMenu.signOut', 'Sign out')}
            </span>
          </button>
        </li>
      </ul>
      {failed ? (
        <p className="tm-portal-menu__error" role="alert">
          {tOr('PortalMenu.signOutFailed', 'Could not sign out. Try again in a moment.')}
        </p>
      ) : null}
    </div>
  );
}
