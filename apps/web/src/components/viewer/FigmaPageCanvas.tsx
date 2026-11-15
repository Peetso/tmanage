'use client';

import { useEffect, useRef, useState } from 'react';
import type { FigmaFrame } from '../../lib/api/figma';
import { useT } from '../../lib/i18n/use-t';
import { ZoomControls } from './ZoomControls';

/** Where each frame of a page sits on its canvas, in Figma's own coordinates. */
export interface PageLayout {
  readonly minX: number;
  readonly minY: number;
  readonly width: number;
  readonly height: number;
  readonly frames: readonly FigmaFrame[];
}

/** The page's frames that have a position and a size, and the box around all of them. */
export function pageLayout(frames: readonly FigmaFrame[]): PageLayout | null {
  const placed = frames.filter(
    (frame) => frame.x !== null && frame.y !== null && frame.width > 0 && frame.height > 0,
  );
  if (placed.length === 0) return null;
  const minX = Math.min(...placed.map((frame) => frame.x!));
  const minY = Math.min(...placed.map((frame) => frame.y!));
  const maxX = Math.max(...placed.map((frame) => frame.x! + frame.width));
  const maxY = Math.max(...placed.map((frame) => frame.y! + frame.height));
  return { minX, minY, width: maxX - minX, height: maxY - minY, frames: placed };
}

/** A page is far larger than one frame: zoom steps by half again, from 1 % to 200 %. */
export function pageZoomStep(zoom: number, direction: 1 | -1): number {
  const next = direction === 1 ? zoom * 1.5 : zoom / 1.5;
  return Math.min(2, Math.max(0.01, next));
}

/** The zoom that fits the whole page in the space available (never above 1). */
export function pageFitZoom(
  layout: Pick<PageLayout, 'width' | 'height'>,
  available: { readonly width: number; readonly height: number },
): number {
  if (layout.width <= 0 || layout.height <= 0) return 1;
  return Math.min(1, available.width / layout.width, available.height / layout.height);
}

export interface FigmaPageCanvasProps {
  readonly frames: readonly FigmaFrame[];
  /** The address of a frame's small picture, or null when it has none yet. */
  readonly thumbUrl: (frame: FigmaFrame) => string | null;
  readonly selectedFrameId: string | null;
  readonly onOpen: (frameId: string) => void;
  /** The accessible name of a frame whose picture is still being prepared. */
  readonly preparingLabel?: (name: string) => string;
}

/**
 * Peter, 2026-11-10 — "see the actual pages in the frame". The page as it is laid out in Figma:
 * every frame where it sits on the canvas, as a small picture, with pan (scroll) and zoom. A
 * click opens the frame on its own, sharp.
 */
export function FigmaPageCanvas({
  frames,
  thumbUrl,
  selectedFrameId,
  onOpen,
  preparingLabel,
}: FigmaPageCanvasProps) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<{ width: number; height: number } | null>(null);
  const [zoomChoice, setZoomChoice] = useState<number | 'fit'>('fit');
  const layout = pageLayout(frames);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        setAvailable({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  if (!layout) {
    return (
      <div className="tm-figma-state" role="status">
        <p className="tm-figma-state__body">{t('Figma.viewer.pageEmpty')}</p>
      </div>
    );
  }
  const fitted = available ? pageFitZoom(layout, available) : 0.1;
  const zoom = zoomChoice === 'fit' ? fitted : zoomChoice;
  return (
    <div className="tm-figma-page">
      <div className="tm-figma-page__tools">
        <ZoomControls
          zoom={zoom}
          fitted={zoomChoice === 'fit'}
          fitMode="contain"
          onStep={(step) => setZoomChoice(pageZoomStep(zoom, step))}
          onFit={() => setZoomChoice('fit')}
        />
      </div>
      <div
        ref={boxRef}
        className="tm-figma-page__viewport"
        role="group"
        aria-label={t('Figma.viewer.pageCanvas')}
        // A scrollable region must take focus so the page can be panned with the arrow keys
        // (axe scrollable-region-focusable; the page is larger than the screen).
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
      >
        <div
          className="tm-figma-page__canvas"
          dir="ltr"
          style={{ width: layout.width * zoom, height: layout.height * zoom }}
        >
          {layout.frames.map((frame) => {
            const thumb = thumbUrl(frame);
            // 2026-11-15 live test: frames without a picture were empty white boxes. Until its
            // picture exists a frame is a named placeholder that says it is being prepared.
            const label =
              thumb || !preparingLabel
                ? t('Figma.viewer.pageOpenHint').replace('{name}', frame.name)
                : preparingLabel(frame.name);
            return (
              <button
                key={frame.id}
                type="button"
                className="tm-figma-page__frame"
                data-state={thumb ? 'ready' : 'preparing'}
                aria-pressed={frame.id === selectedFrameId}
                aria-label={label}
                title={label}
                style={{
                  left: (frame.x! - layout.minX) * zoom,
                  top: (frame.y! - layout.minY) * zoom,
                  width: frame.width * zoom,
                  height: frame.height * zoom,
                }}
                onClick={() => onOpen(frame.id)}
              >
                {thumb ? (
                  <img
                    className="tm-figma-page__thumb"
                    src={thumb}
                    alt=""
                    crossOrigin="use-credentials"
                    draggable={false}
                    loading="lazy"
                    decoding="async"
                  />
                ) : (
                  <span className="tm-figma-page__placeholder" aria-hidden="true">
                    <span className="tm-figma-page__placeholder-name" dir="auto">
                      {frame.name}
                    </span>
                  </span>
                )}
                <span className="tm-figma-page__name" dir="auto" aria-hidden="true">
                  {frame.name}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
