'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert } from '@tmanage/ui';
import type { ProjectExportFormat } from '@tmanage/domain';
import { apiBaseUrl } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { readOrganizationMe } from '../../lib/api/permission-matrix';
import { downloadProjectExport, projectExportPath } from '../../lib/api/projects';
import { useTOr } from '../../lib/i18n/use-t-or';
import '../docs/doc-print.css';

export interface ProjectExportButtonProps {
  readonly organizationSlug: string;
  readonly project: { readonly id: string; readonly name: string } | undefined;
  readonly client: ApiClient;
  /** A fixed API origin in tests; the browser client's {@link apiBaseUrl} otherwise. */
  readonly apiOrigin?: string;
  readonly fetchImpl?: typeof globalThis.fetch;
}

const ENTRIES: readonly {
  readonly format: ProjectExportFormat;
  readonly label: readonly [string, string];
  readonly hint: readonly [string, string];
}[] = [
  {
    format: 'csv',
    label: ['ProjectExport.csv', 'CSV'],
    hint: ['ProjectExport.csvHint', '.csv — opens in Excel; imports back as ClickUp CSV'],
  },
  {
    format: 'json',
    label: ['ProjectExport.json', 'JSON'],
    hint: ['ProjectExport.jsonHint', '.json — every field, for scripts and backups'],
  },
];

/**
 * 54-29 — the project's "Export" menu (CSV · JSON) on the project overview, the same menu and items
 * as the document Export menu (`DocumentExportButton`), so no new visual pattern.
 *
 * Shown only when the caller's `…/me` lists `work.export`; the API decides again for this project
 * (404 / 403 / 413 / 429). Each item is a real download link — it works without script — and, with
 * script, is fetched so the trigger can show "Exporting…" and a refusal can be said in words.
 */
export function ProjectExportButton({
  organizationSlug,
  project,
  client,
  apiOrigin,
  fetchImpl,
}: ProjectExportButtonProps) {
  const tOr = useTOr();
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const me = useQuery({
    queryKey: ['organization-me', organizationSlug],
    queryFn: () => readOrganizationMe(client, organizationSlug),
  });
  const origin = apiOrigin ?? apiBaseUrl();

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: globalThis.MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    root.current?.querySelector<HTMLAnchorElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  const mayExport =
    Array.isArray(me.data?.capabilities) && me.data.capabilities.includes('work.export');
  if (!project || !mayExport) return null;

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    const items = [
      ...(root.current?.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]') ?? []),
    ];
    const at = items.indexOf(document.activeElement as HTMLAnchorElement);
    if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(at + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(at - 1 + items.length) % items.length]?.focus();
    }
  }

  async function exportAs(event: MouseEvent<HTMLAnchorElement>, format: ProjectExportFormat) {
    event.preventDefault();
    if (!project) return;
    setOpen(false);
    setBusy(true);
    setFailed(false);
    const ok = await downloadProjectExport(origin, organizationSlug, project, format, fetchImpl);
    setBusy(false);
    setFailed(!ok);
    trigger.current?.focus();
  }

  return (
    <div ref={root} className="tm-doc-export">
      <button
        ref={trigger}
        type="button"
        className="tm-button tm-button--outline tm-button--accessible"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-busy={busy || undefined}
        disabled={busy}
        onClick={() => setOpen((current) => !current)}
      >
        {busy ? tOr('ProjectExport.busy', 'Exporting…') : tOr('ProjectExport.trigger', 'Export')}
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          tabIndex={-1}
          aria-label={tOr('ProjectExport.menuLabel', 'Export this project')}
          className="tm-doc-export__menu"
          onKeyDown={onMenuKey}
        >
          {ENTRIES.map((entry) => (
            <a
              key={entry.format}
              role="menuitem"
              className="tm-doc-export__item"
              href={`${origin}${projectExportPath(organizationSlug, project.id, entry.format)}`}
              download
              onClick={(event) => void exportAs(event, entry.format)}
            >
              <span className="tm-doc-export__icon" aria-hidden="true">
                ⤓
              </span>
              <span className="tm-doc-export__text">
                <span className="tm-doc-export__label">{tOr(...entry.label)}</span>
                <span className="tm-doc-export__hint">{tOr(...entry.hint)}</span>
              </span>
            </a>
          ))}
        </div>
      ) : null}
      {failed ? (
        <InlineAlert tone="danger" live>
          {tOr(
            'ProjectExport.failed',
            'The export did not download. Try again in a few minutes, or ask an admin for export rights.',
          )}
        </InlineAlert>
      ) : null}
    </div>
  );
}
