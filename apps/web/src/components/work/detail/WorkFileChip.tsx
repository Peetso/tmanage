'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useDismiss } from '../use-dismiss';
import { ChevronDownIcon, FileIcon } from '../work-icons';

export interface WorkFileChipProps {
  /** The file's name, drawn as written (`<bdi>`, so an English name sits right in Arabic). */
  readonly name: string;
  /** Where the chip opens the file: the viewer (inside TManage) or the provider's page. */
  readonly href?: string | undefined;
  /** The provider's own page (Drive, OneDrive) opens in a new tab. */
  readonly external?: boolean;
  /** The open link's accessible name ("hero-v3.fig · Review"). */
  readonly openLabel?: string;
  /** The ⌄ button's accessible name ("More for hero-v3.fig"); needed with `children`. */
  readonly moreLabel?: string;
  /** Still being checked for viruses: drawn quiet until the scan is done. */
  readonly scanning?: boolean;
  /** What the ⌄ panel holds (actions and the version history); no panel when absent. */
  readonly children?: ReactNode;
}

/**
 * One file of a work as a chip (Figma `WV2-02` Files row: file icon and name in a capsule). The
 * chip opens the file; the ⌄ at its end is a disclosure (WAI-ARIA APG "Disclosure") holding what
 * the old file row showed: Review, Download, Upload new version and the version history. Escape
 * and a press outside close it ({@link useDismiss}); Escape gives focus back to the ⌄.
 */
export function WorkFileChip({
  name,
  href,
  external = false,
  openLabel,
  moreLabel,
  scanning = false,
  children,
}: WorkFileChipProps) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLLIElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useDismiss(open, box, (reason) => {
    setOpen(false);
    if (reason === 'escape') more.current?.focus();
  });

  const face = (
    <>
      <FileIcon />
      <bdi className="tm-wk-chip__name">{name}</bdi>
    </>
  );
  return (
    <li ref={box} className="tm-wk-chip" data-scanning={scanning || undefined}>
      {href === undefined ? (
        <span className="tm-wk-chip__open">{face}</span>
      ) : external ? (
        <a
          className="tm-wk-chip__open"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={openLabel}
        >
          {face}
        </a>
      ) : (
        <Link className="tm-wk-chip__open" href={href} aria-label={openLabel}>
          {face}
        </Link>
      )}
      {children === undefined ? null : (
        <>
          <button
            ref={more}
            type="button"
            className="tm-wk-chip__more"
            aria-label={moreLabel}
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            onClick={() => setOpen(!open)}
          >
            <ChevronDownIcon />
          </button>
          {open ? (
            <div id={panelId} className="tm-wk-chip__panel" role="group" aria-label={moreLabel}>
              {children}
            </div>
          ) : null}
        </>
      )}
    </li>
  );
}
