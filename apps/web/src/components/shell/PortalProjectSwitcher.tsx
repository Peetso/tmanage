'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import type { PortalProject } from '../../lib/api/portal';
import { useTOr } from '../../lib/i18n/use-t-or';

/** The query parameter the portal screens read the chosen project from. */
export const PORTAL_PROJECT_PARAM = 'project';

/** The current `?project=`, or `null` for "All projects" (and outside a Next router). */
export function useSelectedPortalProjectId(): string | null {
  return useSearchParams()?.get(PORTAL_PROJECT_PARAM) ?? null;
}

/**
 * `href` with `?project=` set to `projectId`, or removed for `null`, every other parameter kept.
 * Exported so the portal menu's own links carry the same choice.
 */
export function withPortalProject(
  href: string,
  projectId: string | null,
  current?: URLSearchParams | null,
): string {
  const parameters = new URLSearchParams(current ? current.toString() : '');
  if (projectId) parameters.set(PORTAL_PROJECT_PARAM, projectId);
  else parameters.delete(PORTAL_PROJECT_PARAM);
  const query = parameters.toString();
  return query ? `${href}?${query}` : href;
}

export interface PortalProjectSwitcherProps {
  organizationSlug: string;
  /** The client organization, shown over "Your projects" (fq9). */
  clientName: string;
  /** The projects shared with this client, from `GET …/portal/projects`. */
  projects: readonly PortalProject[];
  /** The project a screen is scoped to when the URL names none (the shell's `projectName`). */
  fallbackProjectName?: string;
  /** `menu` is the PROJECT block of the phone menu; `header` the capsule in the desktop header. */
  variant: 'menu' | 'header';
  /** Called after a choice, so the phone menu can close itself. */
  onChoose?: () => void;
}

/**
 * The portal project switcher (Figma fq9-portal-project-switcher): a card with the client's name
 * over "Your projects", one row per shared project with the current one tinted lime, a rule and
 * "All projects".
 *
 * Every row is a real link to the same page with `?project=` changed, so the choice lives in the
 * URL — shareable, reload-proof and read by the portal screens that scope to a project — and no
 * client state can drift from what the address bar says.
 */
export function PortalProjectSwitcher({
  organizationSlug,
  clientName,
  projects,
  fallbackProjectName,
  variant,
  onChoose,
}: PortalProjectSwitcherProps) {
  const tOr = useTOr();
  const pathname = usePathname() ?? `/${organizationSlug}/portal`;
  const search = useSearchParams();
  const selectedId = search?.get(PORTAL_PROJECT_PARAM) ?? null;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const selected =
    projects.find((project) => project.id === selectedId) ??
    (selectedId ? undefined : projects.find((project) => project.name === fallbackProjectName));
  const allProjects = tOr('PortalProjectSwitcher.allProjects', 'All projects');
  const currentName = selected?.name ?? allProjects;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Capture phase, so an Escape inside the phone menu closes this list and not the menu too.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  const choose = () => {
    setOpen(false);
    onChoose?.();
  };

  const row = (id: string | null, name: string, current: boolean) => (
    <li key={id ?? 'all'}>
      <Link
        href={withPortalProject(pathname, id, search)}
        className="tm-portal-switcher__option"
        {...(current ? { 'aria-current': 'true' as const } : {})}
        onClick={choose}
      >
        {name}
      </Link>
    </li>
  );

  return (
    <div ref={rootRef} className="tm-portal-switcher" data-variant={variant}>
      <button
        ref={triggerRef}
        type="button"
        className="tm-portal-switcher__trigger"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {variant === 'menu' ? (
          <span className="tm-portal-switcher__eyebrow">
            {tOr('PortalMenu.project', 'Project')}
          </span>
        ) : null}
        <span className="tm-portal-switcher__current">{currentName}</span>
        <span className="tm-portal-switcher__glyph" aria-hidden="true">
          ⇅
        </span>
        <span className="tm-visually-hidden">
          {tOr('PortalProjectSwitcher.switch', 'Switch project')}
        </span>
      </button>
      {open ? (
        <div id={listId} className="tm-portal-switcher__card">
          <p className="tm-portal-switcher__client">{clientName}</p>
          <p className="tm-portal-switcher__heading">
            {tOr('PortalProjectSwitcher.yourProjects', 'Your projects')}
          </p>
          <ul className="tm-portal-switcher__list">
            {projects.map((project) => row(project.id, project.name, project.id === selected?.id))}
          </ul>
          <hr className="tm-portal-switcher__rule" />
          <ul className="tm-portal-switcher__list">{row(null, allProjects, !selected)}</ul>
        </div>
      ) : null}
    </div>
  );
}
