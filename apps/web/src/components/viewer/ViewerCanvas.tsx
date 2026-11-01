'use client';

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { ReviewThread } from '../../lib/api/review';
import { useT } from '../../lib/i18n/use-t';
import { PinLayer, type ViewerDraft } from './PinLayer';
import {
  boxBetween,
  popoverPlacement,
  toNormalizedPoint,
  type NormalizedBox,
  type NormalizedPoint,
} from './viewer-geometry';

export type ViewerTool = 'select' | 'pin' | 'box';

export interface ViewerCanvasProps {
  /** The artwork's size at 100 % (CSS pixels); `null` while it is still loading. */
  readonly natural: { readonly width: number; readonly height: number } | null;
  readonly zoom: number;
  readonly tool: ViewerTool;
  /** Threads anchored on what is shown now. */
  readonly threads: readonly ReviewThread[];
  readonly selectedThreadId: string | null;
  readonly draft: ViewerDraft | null;
  readonly draftNumber: number;
  /** The page the stage shows (PDF), `null` for a single image. */
  readonly pageNo: number | null;
  readonly onDraft: (draft: ViewerDraft) => void;
  readonly onSelect: (threadId: string) => void;
  readonly onMove: (thread: ReviewThread, point: NormalizedPoint) => void;
  /** The space the stage has, so the screen can fit the artwork into it. */
  readonly onAvailableSize: (size: { readonly width: number; readonly height: number }) => void;
  readonly onZoomStep: (direction: 1 | -1) => void;
  /** The new-comment popover, placed beside the draft. */
  readonly popover: ReactNode;
  /** The artwork itself (an `<img>` or the PDF page canvas), filling the artwork box. */
  readonly children: ReactNode;
  /** A chip over the stage (page number on a PDF). */
  readonly overlay?: ReactNode;
}

/** A pointer that travels further than this (CSS px) is a drag, not a click. */
const CLICK_SLOP = 4;

/**
 * The sunken stage (V-01 `Stage`, radius 24) with the artwork box at the current zoom, the pin
 * layer over it and the pointer handling for the Pin and Box tools.
 *
 * The stage is laid out left-to-right in every language (`dir="ltr"`): it holds the client's
 * artwork, which an Arabic screen shows exactly as an English one. Ctrl / ⌘ + wheel zooms.
 */
export function ViewerCanvas({
  natural,
  zoom,
  tool,
  threads,
  selectedThreadId,
  draft,
  draftNumber,
  pageNo,
  onDraft,
  onSelect,
  onMove,
  onAvailableSize,
  onZoomStep,
  popover,
  children,
  overlay,
}: ViewerCanvasProps) {
  const t = useT();
  const stageRef = useRef<HTMLDivElement>(null);
  const artRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number; point: NormalizedPoint } | null>(null);
  const [sketch, setSketch] = useState<NormalizedBox | null>(null);

  const reportSize = useRef(onAvailableSize);
  reportSize.current = onAvailableSize;
  const zoomStep = useRef(onZoomStep);
  zoomStep.current = onZoomStep;

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const report = () => {
      // 48 px of breathing room around the artwork, as drawn (24 px each side).
      reportSize.current({
        width: Math.max(0, stage.clientWidth - 48),
        height: Math.max(0, stage.clientHeight - 48),
      });
    };
    report();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(report);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomStep.current(event.deltaY < 0 ? 1 : -1);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, []);

  function pointOf(event: ReactPointerEvent): NormalizedPoint | null {
    const rect = artRef.current?.getBoundingClientRect();
    return rect ? toNormalizedPoint(event.clientX, event.clientY, rect) : null;
  }

  function onPinTarget(event: ReactPointerEvent): boolean {
    const target = event.target as Element | null;
    return Boolean(target?.closest?.('.tm-viewer-pin, .tm-viewer-popover'));
  }

  const placing = tool === 'pin' || tool === 'box';
  const width = natural ? Math.round(natural.width * zoom) : 0;
  const height = natural ? Math.round(natural.height * zoom) : 0;

  const draftPoint: NormalizedPoint | null = draft
    ? draft.kind === 'box'
      ? { x: draft.box.x + draft.box.w, y: draft.box.y }
      : draft.point
    : null;
  const placement = draftPoint ? popoverPlacement(draftPoint) : null;

  return (
    <div
      ref={stageRef}
      className="tm-viewer-stage"
      dir="ltr"
      data-tool={tool}
      role="region"
      aria-label={t('Viewer.stage.label')}
    >
      {overlay}
      <div className="tm-viewer-stage__scroll">
        <div
          ref={artRef}
          className="tm-viewer-art"
          data-placing={placing ? 'true' : undefined}
          style={natural ? { width, height } : undefined}
          onPointerDown={(event) => {
            if (!placing || event.button !== 0 || onPinTarget(event)) return;
            const point = pointOf(event);
            if (!point) return;
            start.current = { x: event.clientX, y: event.clientY, point };
            (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (tool !== 'box' || !start.current) return;
            const point = pointOf(event);
            if (point) setSketch(boxBetween(start.current.point, point));
          }}
          onPointerUp={(event) => {
            const began = start.current;
            start.current = null;
            setSketch(null);
            if (!began) return;
            const point = pointOf(event) ?? began.point;
            const travelled = Math.hypot(event.clientX - began.x, event.clientY - began.y);
            if (tool === 'box' && travelled > CLICK_SLOP) {
              const box = boxBetween(began.point, point);
              if (box) {
                onDraft({ kind: 'box', box, pageNo });
                return;
              }
            }
            if (travelled <= CLICK_SLOP || tool === 'box') {
              onDraft({ kind: 'pin', point: began.point, pageNo });
            }
          }}
          onPointerCancel={() => {
            start.current = null;
            setSketch(null);
          }}
        >
          {children}
          {natural ? (
            <PinLayer
              threads={threads}
              selectedThreadId={selectedThreadId}
              draft={draft}
              draftNumber={draftNumber}
              sketchBox={sketch}
              allowMove={tool === 'select'}
              onSelect={onSelect}
              onMove={onMove}
            />
          ) : null}
          {draftPoint && placement && popover ? (
            <div
              className="tm-viewer-popover-anchor"
              data-side={placement.side}
              data-vertical={placement.vertical}
              style={{ left: `${draftPoint.x * 100}%`, top: `${draftPoint.y * 100}%` }}
            >
              {popover}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
