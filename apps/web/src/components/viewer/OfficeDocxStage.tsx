'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { InlineAlert } from '@tmanage/ui';
import type { PreviewOffice } from '../../lib/api/file-preview';
import type { ReviewThread } from '../../lib/api/review';
import { useT } from '../../lib/i18n/use-t';
import { FormatIcon } from './format-icons';
import { fetchOriginal, openCountByPage, useParsedOriginal } from './format-stage-helpers';
import type { OriginalFetcher } from './format-stage-helpers';
import { OfficeLoadState } from './OfficeLoadState';
import { fitZoom, stepZoom } from './viewer-geometry';
import { ZoomControls } from './ZoomControls';
import './format-stages.css';

/**
 * V-25 Word (`468:27915` EN, `468:28944` AR): the document drawn in the browser by docx-preview
 * (Apache-2.0), one page on the stage, the page strip on the start side, "Page 3 of 8" at the
 * bottom. Pins are stored on the page (`pageNo`, fractions of the page box). docx-preview splits
 * pages at the document's own page and section breaks, not where Word's layout would flow, so
 * the page count can differ from Word's — the banner says the layout is approximate and the rail
 * hint says pins are tied to the page.
 *
 * Safety: the rendered document is plain DOM built by the library from the file's XML. After it
 * renders, links lose their targets and any event-handler attribute or active element is removed,
 * so nothing in a document can run or navigate.
 */

/** The class docx-preview prefixes its styles with (keeps them off the rest of the page). */
const DOCX_CLASS = 'tm-docx';

export interface OfficeDocxStageProps {
  readonly src: string | null;
  readonly office: PreviewOffice | null;
  /** Threads on this version; `pageNo` is the rendered page. */
  readonly threads: readonly ReviewThread[];
  readonly selectedThreadId: string | null;
  readonly onPageChange?: (pageNo: number) => void;
  /** The shell's pin layer for a page, laid over that page. */
  readonly renderPageOverlay?: (pageNo: number) => ReactNode;
  /** The shell's tool pill, at the stage's start edge. */
  readonly toolbar?: ReactNode;
  readonly onDownload?: () => void;
  readonly fetcher?: OriginalFetcher;
}

/** Strips anything active from a rendered document: scripts, frames, handlers, link targets. */
export function neutralizeDocument(root: HTMLElement): void {
  root
    .querySelectorAll(
      'script, iframe, object, embed, form, input, button, textarea, select, link, meta, base',
    )
    .forEach((node) => node.remove());
  root.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith('on')) element.removeAttribute(attribute.name);
      else if ((name === 'href' || name === 'xlink:href') && !value.startsWith('#')) {
        element.removeAttribute(attribute.name);
      } else if (
        name === 'src' &&
        !(value.startsWith('blob:') || value.startsWith('data:image/'))
      ) {
        element.removeAttribute(attribute.name);
      } else if (name === 'srcset' || name === 'formaction' || name === 'target') {
        element.removeAttribute(attribute.name);
      }
    }
  });
}

async function keepBytes(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  return bytes;
}

export function OfficeDocxStage({
  src,
  office,
  threads,
  selectedThreadId,
  onPageChange,
  renderPageOverlay,
  toolbar,
  onDownload,
  fetcher = fetchOriginal,
}: OfficeDocxStageProps) {
  const t = useT();
  const loaded = useParsedOriginal(src, keepBytes, fetcher);
  const hostRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<readonly HTMLElement[]>([]);
  const [renderState, setRenderState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [pageNo, setPageNo] = useState(1);
  const openCounts = openCountByPage(threads);
  // SMALLFIX item 3: a page is drawn at its own width (an A4 page is ~794 px), which ran past a
  // narrower pane. It now fits the pane's width by default, never enlarging, and − / + still zoom.
  const canvasRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  const [pageWidths, setPageWidths] = useState<readonly number[]>([]);
  const [zoomChoice, setZoomChoice] = useState<number | 'fit'>('fit');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailable(entry.contentRect.width);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (loaded.state === 'failed') setRenderState('failed');
    if (loaded.state !== 'ready' || !hostRef.current) return undefined;
    const host = hostRef.current;
    let live = true;
    setRenderState('loading');
    void import('docx-preview')
      .then(({ renderAsync }) =>
        renderAsync(loaded.value, host, host, {
          className: DOCX_CLASS,
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: false,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderComments: false,
          useBase64URL: false,
          experimental: false,
        }),
      )
      .then(() => {
        if (!live) return;
        neutralizeDocument(host);
        const sections = Array.from(host.querySelectorAll<HTMLElement>(`section.${DOCX_CLASS}`));
        setPages(sections);
        // Layout widths (unaffected by the host's zoom), measured once per render.
        setPageWidths(sections.map((section) => section.offsetWidth));
        setRenderState(sections.length > 0 ? 'ready' : 'failed');
      })
      .catch(() => {
        if (live) setRenderState('failed');
      });
    return () => {
      live = false;
      host.replaceChildren();
    };
  }, [loaded]);

  const count = pages.length;

  // Only the current page is shown; the others stay rendered but hidden.
  useLayoutEffect(() => {
    pages.forEach((page, index) => {
      page.dataset['tmCurrent'] = index + 1 === pageNo ? 'true' : 'false';
    });
  }, [pages, pageNo]);

  const go = (next: number) => {
    const clamped = Math.min(Math.max(1, next), Math.max(1, count));
    setPageNo(clamped);
    onPageChange?.(clamped);
  };

  const selectedPage = threads.find((thread) => thread.id === selectedThreadId)?.pageNo ?? null;
  useEffect(() => {
    if (selectedPage !== null && selectedPage >= 1 && selectedPage <= Math.max(count, 1)) {
      setPageNo(selectedPage);
      onPageChange?.(selectedPage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPage, selectedThreadId, count]);

  const current = pages[pageNo - 1] ?? null;
  const pageWidth = pageWidths[pageNo - 1] ?? 0;
  // Width only: the page scrolls down, as a PDF page does. Heights are not part of a width fit.
  const fitted = fitZoom(
    { width: pageWidth, height: 1 },
    { width: available, height: 1 },
    'width',
    1,
  );
  const zoom = zoomChoice === 'fit' ? fitted : zoomChoice;
  const stepper = t('ViewerFormats.docx.counter')
    .replace('{page}', String(pageNo))
    .replace('{count}', String(count || office?.pages || 1));

  return (
    <div className="tm-office-stage tm-office-stage--docx">
      <InlineAlert tone="warning" className="tm-format-notice">
        {t('ViewerFormats.office.approximate')}
      </InlineAlert>
      {renderState === 'failed' ? <OfficeLoadState state="failed" onDownload={onDownload} /> : null}
      <div className="tm-docx-layout" hidden={renderState === 'failed'}>
        {renderState === 'ready' ? (
          <nav className="tm-docx-strip" aria-label={t('ViewerFormats.docx.strip')}>
            {pages.map((_, index) => {
              const number = index + 1;
              const open = openCounts.get(number) ?? 0;
              return (
                <button
                  key={number}
                  type="button"
                  className="tm-docx-strip__item"
                  aria-current={number === pageNo ? 'true' : undefined}
                  aria-label={
                    t('ViewerFormats.docx.page').replace('{page}', String(number)) +
                    (open > 0
                      ? `, ${t('ViewerFormats.openCount').replace('{count}', String(open))}`
                      : '')
                  }
                  onClick={() => go(number)}
                >
                  <span className="tm-docx-strip__sheet" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                    <span />
                    <span />
                    {open > 0 ? <span className="tm-docx-strip__count">{open}</span> : null}
                  </span>
                  <span className="tm-docx-strip__number" aria-hidden="true">
                    {number}
                  </span>
                </button>
              );
            })}
          </nav>
        ) : null}
        <div className="tm-office-canvas tm-office-canvas--docx" ref={canvasRef}>
          {toolbar && renderState === 'ready' ? (
            <div className="tm-office-canvas__toolbar tm-office-canvas__toolbar--side">
              {toolbar}
            </div>
          ) : null}
          {renderState === 'ready' ? (
            <div className="tm-office-canvas__chip">
              <ZoomControls
                zoom={zoom}
                fitted={zoomChoice === 'fit'}
                fitMode="width"
                onStep={(direction) => setZoomChoice(stepZoom(zoom, direction))}
                onFit={() => setZoomChoice('fit')}
              />
            </div>
          ) : null}
          {renderState === 'loading' ? <OfficeLoadState state="loading" /> : null}
          <div
            className="tm-docx-host"
            dir="ltr"
            ref={hostRef}
            style={{ zoom }}
            role="document"
            aria-label={t('ViewerFormats.docx.label')}
          />
          {current && renderPageOverlay
            ? createPortal(
                <div className="tm-docx-overlay">{renderPageOverlay(pageNo)}</div>,
                current,
              )
            : null}
          {renderState === 'ready' ? (
            <div
              className="tm-format-stepper"
              role="group"
              aria-label={t('ViewerFormats.docx.pages')}
            >
              <button
                type="button"
                className="tm-format-stepper__button"
                aria-label={t('ViewerFormats.docx.previous')}
                disabled={pageNo <= 1}
                onClick={() => go(pageNo - 1)}
              >
                <FormatIcon name="prev" className="tm-format-icon--flip" />
              </button>
              <span aria-live="polite">{stepper}</span>
              <button
                type="button"
                className="tm-format-stepper__button"
                aria-label={t('ViewerFormats.docx.next')}
                disabled={pageNo >= count}
                onClick={() => go(pageNo + 1)}
              >
                <FormatIcon name="next" className="tm-format-icon--flip" />
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
