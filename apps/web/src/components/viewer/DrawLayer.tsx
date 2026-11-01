'use client';

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { ReviewThread } from '../../lib/api/review';
import {
  appendPenPoint,
  arrowHeadPath,
  canAddStroke,
  denormalisePoint,
  isMeaningfulStroke,
  normalisePoint,
  penOutlinePath,
  readDrawAnchor,
  rectFromCorners,
  type DrawStroke,
  type DrawTool,
  type PixelSize,
} from '../../lib/review-anchors';

export interface DrawSettings {
  readonly tool: DrawTool;
  readonly color: string;
  readonly width: number;
}

export interface DrawLayerProps {
  /** The artwork box in pixels at the current zoom. */
  readonly size: PixelSize;
  /** Drawing threads anchored on what the stage shows (this version, this page). */
  readonly threads: readonly ReviewThread[];
  readonly selectedThreadId: string | null;
  /** The strokes drawn so far and not posted yet. */
  readonly strokes: readonly DrawStroke[];
  /** Pointer input is taken only while drawing; otherwise the layer is a picture. */
  readonly active: boolean;
  readonly settings: DrawSettings;
  readonly onStroke: (stroke: DrawStroke) => void;
  /** The drawing is as large as one comment can hold. */
  readonly onLimit: () => void;
}

/** One stroke as SVG in pixels: a pen outline, an arrow with its head, or a rectangle. */
export function StrokeShape({
  stroke,
  size,
}: {
  readonly stroke: DrawStroke;
  readonly size: PixelSize;
}) {
  const first = stroke.points[0];
  const last = stroke.points[stroke.points.length - 1];
  if (!first || !last) return null;
  if (stroke.tool === 'pen') {
    return (
      <path
        className="tm-viewer-draw__pen"
        d={penOutlinePath(stroke.points, stroke.width * 0.8, size)}
        fill={stroke.color}
      />
    );
  }
  const a = denormalisePoint(first, size);
  const b = denormalisePoint(last, size);
  if (stroke.tool === 'rect') {
    const rect = rectFromCorners(a, b);
    return (
      <rect
        x={rect.x}
        y={rect.y}
        width={rect.width}
        height={rect.height}
        rx={4}
        fill="none"
        stroke={stroke.color}
        strokeWidth={stroke.width * 0.75}
      />
    );
  }
  return (
    <g
      fill="none"
      stroke={stroke.color}
      strokeWidth={stroke.width * 0.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />
      <path d={arrowHeadPath(a, b, stroke.width)} />
    </g>
  );
}

/**
 * V-12 — the drawings over the artwork: saved drawing threads (muted when resolved), the strokes
 * of the drawing in progress, and, while the Draw tool is on, the pointer handling that makes new
 * strokes. Pen strokes are smoothed with perfect-freehand.
 *
 * Mouse, pen and one finger draw (pointer events); a second finger cancels the stroke so a pinch
 * stays a zoom. The SVG is laid out in the artwork's own pixels and never mirrored in Arabic.
 */
export function DrawLayer({
  size,
  threads,
  selectedThreadId,
  strokes,
  active,
  settings,
  onStroke,
  onLimit,
}: DrawLayerProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const pointerId = useRef<number | null>(null);
  const [live, setLive] = useState<DrawStroke | null>(null);

  function pointOf(event: ReactPointerEvent) {
    const rect = svgRef.current?.getBoundingClientRect();
    return rect ? normalisePoint(event.clientX, event.clientY, rect) : null;
  }

  function cancel() {
    pointerId.current = null;
    setLive(null);
  }

  const saved = threads
    .filter((thread) => thread.anchorKind === 'draw')
    .map((thread) => ({ thread, drawing: readDrawAnchor(thread.anchor) }));

  return (
    <svg
      ref={svgRef}
      className="tm-viewer-draw"
      data-active={active ? 'true' : undefined}
      data-testid="viewer-draw-layer"
      width={size.width}
      height={size.height}
      viewBox={`0 0 ${size.width} ${size.height}`}
      aria-hidden="true"
      focusable="false"
      onPointerDown={(event) => {
        if (!active) return;
        if (pointerId.current !== null) {
          // A second finger: this is a pinch, not a stroke.
          cancel();
          return;
        }
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        if (!canAddStroke(strokes)) {
          onLimit();
          return;
        }
        const point = pointOf(event);
        if (!point) return;
        event.preventDefault();
        pointerId.current = event.pointerId;
        (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
        setLive({ ...settings, points: settings.tool === 'pen' ? [point] : [point, point] });
      }}
      onPointerMove={(event) => {
        if (!live || pointerId.current !== event.pointerId) return;
        const point = pointOf(event);
        if (!point) return;
        setLive(
          live.tool === 'pen'
            ? { ...live, points: appendPenPoint(live.points, point) }
            : { ...live, points: [live.points[0]!, point] },
        );
      }}
      onPointerUp={(event) => {
        if (!live || pointerId.current !== event.pointerId) return;
        const point = pointOf(event);
        const done =
          point && live.tool !== 'pen' ? { ...live, points: [live.points[0]!, point] } : live;
        cancel();
        if (isMeaningfulStroke(done) && canAddStroke(strokes, done.points.length)) onStroke(done);
      }}
      onPointerCancel={cancel}
    >
      {saved.map(({ thread, drawing }) =>
        drawing ? (
          <g
            key={thread.id}
            className="tm-viewer-draw__thread"
            data-state={
              thread.id === selectedThreadId
                ? 'selected'
                : thread.status === 'resolved'
                  ? 'resolved'
                  : 'open'
            }
          >
            {drawing.strokes.map((stroke, index) => (
              <StrokeShape key={index} stroke={stroke} size={size} />
            ))}
          </g>
        ) : null,
      )}
      <g className="tm-viewer-draw__draft">
        {strokes.map((stroke, index) => (
          <StrokeShape key={index} stroke={stroke} size={size} />
        ))}
        {live ? <StrokeShape stroke={live} size={size} /> : null}
      </g>
    </svg>
  );
}
