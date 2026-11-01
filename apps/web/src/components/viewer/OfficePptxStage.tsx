'use client';

import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { InlineAlert } from '@tmanage/ui';
import type { PreviewOffice } from '../../lib/api/file-preview';
import type { ReviewThread } from '../../lib/api/review';
import { useT } from '../../lib/i18n/use-t';
import { readDeck, releaseDeck } from '../../lib/office/pptx-read';
import type { Deck, Slide, SlideShape } from '../../lib/office/pptx-read';
import { fetchOriginal, openCountByPage, useParsedOriginal } from './format-stage-helpers';
import type { OriginalFetcher } from './format-stage-helpers';
import { OfficeLoadState } from './OfficeLoadState';
import './format-stages.css';

/**
 * V-25 PowerPoint (`468:28154` EN, `468:29179` AR; phone `468:28787` / `468:29812`): one slide on
 * the stage with its pins, the slide strip below, "Slide 4 of 12" on the stage. The slides are
 * drawn in the browser by a simple renderer (text boxes, pictures, filled shapes) — the banner says
 * the layout is approximate. The slide box has the file's own slide size, so pins stored as
 * fractions of it (`pageNo` = slide number) stay put whatever renders the slide.
 *
 * The slide itself never mirrors in Arabic (it is the client's file); the chrome around it does.
 */

const EMU_PER_POINT = 12_700;
const DEFAULT_POINTS = 18;
/** PowerPoint's own defaults when the file names no colour: the slide is the file, not our theme. */
const DEFAULT_SLIDE = '#FFFFFF';
const DEFAULT_TEXT = '#000000';

export interface OfficePptxStageProps {
  readonly src: string | null;
  readonly office: PreviewOffice | null;
  /** Threads on this version; their `pageNo` is the slide number. */
  readonly threads: readonly ReviewThread[];
  readonly selectedThreadId: string | null;
  /** The slide on screen changed (the shell filters its pins and drafts by it). */
  readonly onSlideChange?: (slideNo: number) => void;
  /**
   * The shell's pin layer (PinLayer + DrawLayer) for a slide, laid over the slide box. Its
   * coordinates are fractions of the slide.
   */
  readonly renderSlideOverlay?: (slideNo: number) => ReactNode;
  /** The shell's tool pill (Select · Pin · Box · Draw), top-start on the stage. */
  readonly toolbar?: ReactNode;
  readonly onDownload?: () => void;
  readonly fetcher?: OriginalFetcher;
}

function ShapeView({ shape, deck }: { readonly shape: SlideShape; readonly deck: Deck }) {
  const box: CSSProperties = {
    left: `${shape.x * 100}%`,
    top: `${shape.y * 100}%`,
    width: `${shape.w * 100}%`,
    height: `${shape.h * 100}%`,
    background: shape.fill ?? undefined,
  };
  if (shape.kind === 'picture') {
    const url = shape.media ? deck.media.get(shape.media) : undefined;
    return url ? (
      <img className="tm-slide__picture" style={box} src={url} alt="" draggable={false} />
    ) : (
      <span className="tm-slide__picture tm-slide__picture--missing" style={box} />
    );
  }
  return (
    <div className="tm-slide__shape" style={box}>
      {shape.paragraphs.map((paragraph, index) => (
        <p
          key={index}
          className="tm-slide__paragraph"
          data-bullet={paragraph.bullet ? 'true' : undefined}
          style={{
            textAlign:
              paragraph.align === 'end'
                ? 'right'
                : paragraph.align === 'start'
                  ? 'left'
                  : paragraph.align,
          }}
        >
          {paragraph.runs.map((run, runIndex) => (
            <span
              key={runIndex}
              style={{
                fontSize: `${(((run.sizePt ?? DEFAULT_POINTS) * EMU_PER_POINT) / deck.width) * 100}cqw`,
                fontWeight: run.bold ? 600 : undefined,
                fontStyle: run.italic ? 'italic' : undefined,
                color: run.color ?? undefined,
              }}
            >
              {run.text}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}

/** One slide, drawn to fill its box (the box keeps the deck's aspect ratio). */
export function SlideView({
  deck,
  slide,
  children,
}: {
  readonly deck: Deck;
  readonly slide: Slide;
  readonly children?: ReactNode;
}) {
  return (
    <div
      className="tm-slide"
      dir="ltr"
      style={{
        aspectRatio: `${deck.width} / ${deck.height}`,
        background: slide.background ?? DEFAULT_SLIDE,
        color: DEFAULT_TEXT,
      }}
    >
      <div className="tm-slide__content" aria-hidden="true">
        {slide.shapes.map((shape, index) => (
          <ShapeView key={index} shape={shape} deck={deck} />
        ))}
      </div>
      {children ? <div className="tm-slide__overlay">{children}</div> : null}
    </div>
  );
}

export function OfficePptxStage({
  src,
  office,
  threads,
  selectedThreadId,
  onSlideChange,
  renderSlideOverlay,
  toolbar,
  onDownload,
  fetcher = fetchOriginal,
}: OfficePptxStageProps) {
  const t = useT();
  const loaded = useParsedOriginal(src, readDeck, fetcher, releaseDeck);
  const deck = loaded.state === 'ready' ? loaded.value : null;
  const [slideNo, setSlideNo] = useState(1);
  const count = deck?.slides.length ?? office?.pages ?? 0;
  const openCounts = openCountByPage(threads);

  const go = (next: number) => {
    const clamped = Math.min(Math.max(1, next), Math.max(1, count));
    setSlideNo(clamped);
    onSlideChange?.(clamped);
  };

  // A thread chosen in the rail brings its slide onto the stage.
  const selectedPage = threads.find((thread) => thread.id === selectedThreadId)?.pageNo ?? null;
  useEffect(() => {
    if (selectedPage !== null && selectedPage >= 1) {
      setSlideNo(selectedPage);
      onSlideChange?.(selectedPage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPage, selectedThreadId]);

  const slide = deck?.slides[slideNo - 1] ?? null;
  const counter = t('ViewerFormats.pptx.counter')
    .replace('{slide}', String(slideNo))
    .replace('{count}', String(count));

  return (
    <div className="tm-office-stage tm-office-stage--pptx">
      <InlineAlert tone="warning" className="tm-format-notice">
        {t('ViewerFormats.office.approximate')}
      </InlineAlert>
      {!deck || !slide ? (
        <OfficeLoadState
          state={loaded.state === 'loading' ? 'loading' : 'failed'}
          onDownload={onDownload}
        />
      ) : (
        <>
          <div className="tm-office-canvas">
            {toolbar ? <div className="tm-office-canvas__toolbar">{toolbar}</div> : null}
            <span
              className="tm-format-chip tm-format-chip--mono tm-office-canvas__chip"
              aria-live="polite"
            >
              {counter}
            </span>
            <div className="tm-office-canvas__slide">
              <SlideView deck={deck} slide={slide}>
                {renderSlideOverlay?.(slideNo)}
              </SlideView>
            </div>
          </div>
          <nav className="tm-slide-strip" aria-label={t('ViewerFormats.pptx.strip')}>
            {deck.slides.map((thumb, index) => {
              const number = index + 1;
              const open = openCounts.get(number) ?? 0;
              return (
                <button
                  key={number}
                  type="button"
                  className="tm-slide-strip__item"
                  aria-current={number === slideNo ? 'true' : undefined}
                  aria-label={
                    t('ViewerFormats.pptx.slide').replace('{slide}', String(number)) +
                    (open > 0
                      ? `, ${t('ViewerFormats.openCount').replace('{count}', String(open))}`
                      : '')
                  }
                  onClick={() => go(number)}
                >
                  <SlideView deck={deck} slide={thumb} />
                  <span className="tm-slide-strip__number" aria-hidden="true">
                    {number}
                  </span>
                  {open > 0 ? (
                    <span className="tm-slide-strip__count" aria-hidden="true">
                      {open}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>
        </>
      )}
    </div>
  );
}
