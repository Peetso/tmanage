'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { apiBaseUrl } from '../../lib/api/browser-client';
import { useTOr } from '../../lib/i18n/use-t-or';
import '../docs/doc-print.css';

export interface DocumentExportButtonProps {
  organizationSlug: string;
  documentId: string;
  /**
   * The API origin the download links point at. Defaults to the browser client's
   * {@link apiBaseUrl}; a test passes a fixed value so the rendered hrefs are deterministic and no
   * `NEXT_PUBLIC_*` needs to be set.
   */
  apiOrigin?: string;
}

type Format = 'md' | 'html' | 'docx' | 'pdf';

const ENTRIES: readonly {
  readonly format: Format;
  readonly label: readonly [string, string];
  readonly hint: readonly [string, string];
}[] = [
  {
    format: 'md',
    label: ['DocExport.markdown', 'Markdown'],
    hint: ['DocExport.markdownHint', '.md — keeps headings, lists and tables'],
  },
  {
    format: 'html',
    label: ['DocExport.html', 'HTML'],
    hint: ['DocExport.htmlHint', '.html — the page as you see it'],
  },
  {
    format: 'docx',
    label: ['DocExport.word', 'Word'],
    hint: ['DocExport.wordHint', '.docx — opens in Word or Google Docs'],
  },
  {
    format: 'pdf',
    label: ['DocExport.pdf', 'PDF'],
    hint: ['DocExport.pdfHint', 'Print view — save as PDF from the print dialog'],
  },
];

/**
 * **DOC export (x131, R5 frame 10).** An "Export" menu: Markdown · HTML · Word · PDF.
 *
 * The first three are plain links to the API's `export.md` / `export.html` / `export.docx`
 * routes: each answers with `Content-Disposition: attachment`, so a top-level GET downloads rather
 * than navigates; the session cookie rides the navigation (SameSite=Lax covers a top-level GET) and
 * the API authorizes it behind `doc.read` like every read. Nothing is parsed on the client and the
 * JSON `ApiClient` (which would read the bytes as JSON) is deliberately not involved.
 *
 * PDF is free: it opens the document's print route (A4 print CSS) in a new tab, which calls the
 * browser's print dialog — "Save as PDF" there. No paid converter, no server process.
 */
export function DocumentExportButton({
  organizationSlug,
  documentId,
  apiOrigin,
}: DocumentExportButtonProps) {
  const tOr = useTOr();
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const origin = apiOrigin ?? apiBaseUrl();
  const org = encodeURIComponent(organizationSlug);
  const id = encodeURIComponent(documentId);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    root.current?.querySelector<HTMLAnchorElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

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

  function hrefOf(format: Format): string {
    return format === 'pdf'
      ? `/${org}/docs/${id}/print`
      : `${origin}/v1/organizations/${org}/documents/${id}/export.${format}`;
  }

  return (
    <div ref={root} className="tm-doc-export">
      <button
        ref={trigger}
        type="button"
        className="tm-button tm-button--outline"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {tOr('DocExport.trigger', 'Export')}
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          tabIndex={-1}
          className="tm-doc-export__menu"
          onKeyDown={onMenuKey}
        >
          {ENTRIES.map((entry) => (
            <a
              key={entry.format}
              role="menuitem"
              className="tm-doc-export__item"
              href={hrefOf(entry.format)}
              target={entry.format === 'pdf' ? '_blank' : undefined}
              rel={entry.format === 'pdf' ? 'noopener noreferrer' : undefined}
              download={entry.format === 'pdf' ? undefined : `${documentId}.${entry.format}`}
              onClick={() => setOpen(false)}
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
    </div>
  );
}
