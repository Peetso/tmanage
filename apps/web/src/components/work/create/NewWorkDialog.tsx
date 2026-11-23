'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ApiClient } from '../../../lib/api/client';
import type { WorkItemSummary } from '../../../lib/api/work-items';
import { browserApiClient } from '../../../lib/api/browser-client';
import { useA6T } from '../DueDatePicker';
import { PlusIcon } from '../work-icons';
import { NewWorkForm, type NewWorkMode } from './NewWorkForm';
import { useNewWork } from './use-new-work';
import type { CaptureDraft } from './new-work-model';

export interface NewWorkDialogProps {
  readonly organizationSlug: string;
  /** The project the caller is looking at; opens on it when it is one of the caller's. */
  readonly projectId?: string;
  readonly mode?: NewWorkMode;
  /** A name (and description) to start from: text the person already wrote elsewhere. */
  readonly draft?: CaptureDraft;
  readonly client?: ApiClient;
  readonly now?: Date;
  readonly onClose: () => void;
  /** After a create (not "add another"); the default opens the new work's page. */
  readonly onCreated?: (item: WorkItemSummary) => void;
}

/**
 * **New work as a dialog** (W-WEB-3). Quick first (Figma `WV2-03`: under the header's New work
 * on desktop, a bottom sheet on phone); "All fields" grows the same form, with what was typed,
 * into full create (`WV2-04`: a 560 px dialog on desktop, a whole page on phone).
 *
 * The frame is a modal dialog (WAI-ARIA APG "Dialog (Modal)"): focus moves to the name on open
 * and back to the opener on close; Escape closes it unless a popover or a picker inside it is
 * open, which closes first; a press on the backdrop closes it.
 */
export function NewWorkDialog({
  organizationSlug,
  projectId,
  mode: initialMode = 'quick',
  draft,
  client,
  now,
  onClose,
  onCreated,
}: NewWorkDialogProps) {
  const api = client ?? browserApiClient();
  const titleId = useId();
  const [mode, setMode] = useState<NewWorkMode>(initialMode);
  const work = useNewWork({
    api,
    organizationSlug,
    ...(draft ? { draft } : {}),
    ...(projectId ? { initialProjectId: projectId } : {}),
    ...(now === undefined ? {} : { now }),
    onCreated: (result, another) => {
      if (another) return;
      onClose();
      if (onCreated) onCreated(result.item);
      else
        window.location.assign(`/${organizationSlug}/work/${encodeURIComponent(result.item.id)}`);
    },
  });

  return (
    <ModalFrame labelledBy={titleId} mode={mode} onClose={onClose}>
      <NewWorkForm
        api={api}
        organizationSlug={organizationSlug}
        work={work}
        mode={mode}
        layout="dialog"
        titleId={titleId}
        onAllFields={() => setMode('full')}
        onClose={onClose}
        {...(now === undefined ? {} : { now })}
      />
    </ModalFrame>
  );
}

function ModalFrame({
  labelledBy,
  mode,
  onClose,
  children,
}: {
  labelledBy: string;
  mode: NewWorkMode;
  onClose: () => void;
  children: ReactNode;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const latest = useRef(onClose);
  useEffect(() => {
    latest.current = onClose;
  });
  useEffect(() => {
    const opener = document.activeElement;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !sheet.current) return;
      // A picker dialog opened from the form, or an open popover, takes the Escape first.
      const inner = (event.target as Element | null)?.closest?.('[role="dialog"]');
      if (inner && inner !== sheet.current) return;
      if (sheet.current.querySelector('.tm-nw-popover')) return;
      event.preventDefault();
      latest.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);
  return (
    <div
      className="tm-nw-scrim"
      data-mode={mode}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) latest.current();
      }}
    >
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className="tm-nw-sheet"
        data-mode={mode}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The header's "New work" (Figma `WV2-01`, lime, 32): opens quick create over the current screen.
 * For any screen that shows works; the `/capture` route stays the share target and the phone's
 * "+" (full create as a page).
 */
export function NewWorkButton({
  organizationSlug,
  projectId,
  client,
  icon = false,
  className,
  children,
}: {
  organizationSlug: string;
  projectId?: string;
  client?: ApiClient;
  /** Draw the plus before the words. */
  icon?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const t = useA6T();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className ?? 'tm-nw-open'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {icon ? <PlusIcon /> : null}
        {children ?? t('NewWork.title')}
      </button>
      {open ? (
        <NewWorkDialog
          organizationSlug={organizationSlug}
          {...(projectId ? { projectId } : {})}
          {...(client ? { client } : {})}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
