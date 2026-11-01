'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { DocumentSharing } from '../../lib/api/documents';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { rtlLine } from './doc-markdown';
import './doc-share-dialog.css';

export interface DocShareDialogProps {
  readonly organizationSlug: string;
  readonly documentId: string;
  readonly documentTitle: string;
  /** The document's project — "Everyone in <project> can open and edit this doc". */
  readonly projectName: string;
  readonly sharing: DocumentSharing | undefined;
  readonly onClose: () => void;
}

/**
 * **Docs · Share dialog** (Figma 446:35464, "2026-10-31 live-test fix").
 *
 * Says who can see the document — the project's team (can edit) and the client people (can read
 * once it is published) — and copies its link. Publishing itself stays on the Publish button the
 * design keeps in the top bar. Esc, the scrim and Done close it; focus returns to the opener.
 */
export function DocShareDialog({
  organizationSlug,
  documentId,
  documentTitle,
  projectName,
  sharing,
  onClose,
}: DocShareDialogProps) {
  const tOr = useTOr();
  const locale = useActiveLocale();
  const titleId = useId();
  const bodyId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);
  // The latest onClose, so the open/close effect runs once (focus moves in once, back once).
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.querySelector<HTMLElement>('button')?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      } else if (event.key === 'Tab') {
        // Keep Tab inside the dialog.
        const items = Array.from(
          panelRef.current?.querySelectorAll<HTMLElement>('button, a[href]') ?? [],
        );
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus();
    };
  }, []);

  async function copyLink() {
    const href =
      typeof window === 'undefined'
        ? ''
        : `${window.location.origin}/${organizationSlug}/docs/${documentId}`;
    try {
      await navigator.clipboard?.writeText(href);
    } catch {
      // Clipboard refused (an insecure context); the link is still the page's own address.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const published = sharing?.audience === 'client';
  const count = sharing?.clientAudienceCount ?? 0;
  const quote = (text: string) => (locale.startsWith('ar') ? `«${text}»` : `“${text}”`);
  const team =
    projectName !== ''
      ? tOr('DocShareDialog.teamRowProject', 'Your team · {project} members — can edit').replace(
          '{project}',
          projectName,
        )
      : tOr('DocShareDialog.teamRow', 'Your team — can edit');
  const clients = (
    published
      ? tOr('DocShareDialog.clientRowPublished', 'Client people · {count} — can read it now')
      : tOr('DocShareDialog.clientRowDraft', 'Client people · {count} — can read after you publish')
  ).replace('{count}', String(count));
  const intro = (
    projectName !== ''
      ? tOr('DocShareDialog.introProject', 'Everyone in {project} can open and edit this doc.')
      : tOr('DocShareDialog.intro', 'Everyone in this project can open and edit this doc.')
  ).replace('{project}', projectName);
  const clientLine = published
    ? tOr('DocShareDialog.clientsNow', 'Client people can read it now.')
    : tOr('DocShareDialog.clientsLater', 'Client people can read it only after you publish it.');

  return (
    <div className="tm-docshare">
      <div className="tm-docshare__scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        className="tm-docshare__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
      >
        <h2 id={titleId} className="tm-docshare__title">
          {rtlLine(
            tOr('DocShareDialog.title', 'Share {title}').replace('{title}', quote(documentTitle)),
            locale,
          )}
        </h2>
        <p id={bodyId} className="tm-docshare__body">
          {rtlLine(`${intro} ${clientLine}`, locale)}
        </p>
        <p className="tm-docshare__label">{tOr('DocShareDialog.whoCanSee', 'Who can see it')}</p>
        <ul className="tm-docshare__rows">
          <li className="tm-docshare__row">
            <span aria-hidden="true">■</span>
            {rtlLine(team, locale)}
          </li>
          <li className="tm-docshare__row" data-audience={published ? 'client' : 'internal'}>
            <span aria-hidden="true">◎</span>
            {rtlLine(clients, locale)}
          </li>
        </ul>
        <p className="tm-docshare__note">
          {rtlLine(
            tOr(
              'DocShareDialog.note',
              'Comments stay internal. Publishing shares the document body only.',
            ),
            locale,
          )}
        </p>
        <div className="tm-docshare__actions">
          <button
            type="button"
            className="tm-docshare__btn"
            aria-live="polite"
            onClick={() => void copyLink()}
          >
            {copied
              ? tOr('DocumentEditorScreen.linkCopied', 'Link copied')
              : tOr('DocShareDialog.copyLink', 'Copy link')}
          </button>
          <button type="button" className="tm-docshare__btn" data-tone="ink" onClick={onClose}>
            {tOr('DocShareDialog.done', 'Done')}
          </button>
        </div>
      </div>
    </div>
  );
}
