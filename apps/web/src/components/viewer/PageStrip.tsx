'use client';

import type { ReactNode } from 'react';
import { useT } from '../../lib/i18n/use-t';
import { ViewerIcon } from './viewer-icons';

export interface PageStripProps {
  readonly pageCount: number;
  readonly pageNo: number;
  readonly onPage: (pageNo: number) => void;
  /** Open comments per page (1-based), for the lime count dot. */
  readonly openByPage: ReadonlyMap<number, number>;
  readonly renderThumb: (pageNo: number) => ReactNode;
}

/** How many page pictures the strip shows at once (V-04 draws six). */
export const STRIP_WINDOW = 6;

/** The pages the strip shows: a window of six around the current page. */
export function stripWindow(pageCount: number, pageNo: number): readonly number[] {
  if (pageCount <= 0) return [];
  const size = Math.min(STRIP_WINDOW, pageCount);
  const first = Math.min(Math.max(1, pageNo - Math.floor(size / 2)), pageCount - size + 1);
  return Array.from({ length: size }, (_, index) => first + index);
}

/**
 * V-04 page strip: "‹ Page 3 of 12 ›" stepper, six page pictures with a lime count dot on pages
 * that have open comments, the current page ringed, and "+6 pages" for the rest. On a phone only
 * the stepper shows (CSS).
 */
export function PageStrip({ pageCount, pageNo, onPage, openByPage, renderThumb }: PageStripProps) {
  const t = useT();
  const pages = stripWindow(pageCount, pageNo);
  const hidden = pageCount - pages.length;
  const pageOf = t('Viewer.page.of')
    .replace('{page}', String(pageNo))
    .replace('{count}', String(pageCount));

  return (
    <nav className="tm-viewer-strip" aria-label={t('Viewer.page.strip')}>
      <div className="tm-viewer-strip__stepper">
        <button
          type="button"
          className="tm-viewer-round"
          onClick={() => onPage(pageNo - 1)}
          disabled={pageNo <= 1}
          aria-label={t('Viewer.page.previous')}
        >
          <ViewerIcon name="back" className="tm-viewer-icon--flip" />
        </button>
        <span className="tm-viewer-strip__label" aria-live="polite">
          {pageOf}
        </span>
        <button
          type="button"
          className="tm-viewer-round"
          onClick={() => onPage(pageNo + 1)}
          disabled={pageNo >= pageCount}
          aria-label={t('Viewer.page.next')}
        >
          <ViewerIcon name="chevron" className="tm-viewer-icon--flip" />
        </button>
      </div>
      <ol className="tm-viewer-strip__pages">
        {pages.map((page) => {
          const open = openByPage.get(page) ?? 0;
          return (
            <li key={page}>
              <button
                type="button"
                className="tm-viewer-strip__page"
                aria-current={page === pageNo ? 'page' : undefined}
                aria-label={
                  t('Viewer.page.go').replace('{page}', String(page)) +
                  (open > 0
                    ? ` · ${t('Viewer.page.openCount').replace('{count}', String(open))}`
                    : '')
                }
                onClick={() => onPage(page)}
              >
                <span className="tm-viewer-strip__thumb">{renderThumb(page)}</span>
                {open > 0 ? (
                  <span className="tm-viewer-strip__dot" aria-hidden="true">
                    {open}
                  </span>
                ) : null}
                <span className="tm-viewer-strip__no" aria-hidden="true">
                  {page}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {hidden > 0 ? (
        <span className="tm-viewer-strip__more">
          {t('Viewer.page.more').replace('{count}', String(hidden))}
        </span>
      ) : null}
    </nav>
  );
}
