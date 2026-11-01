'use client';

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { ReviewThread } from '../../lib/api/review';
import { useT } from '../../lib/i18n/use-t';
import {
  readBox,
  readPoint,
  toNormalizedPoint,
  type NormalizedBox,
  type NormalizedPoint,
} from './viewer-geometry';

/** A comment being placed: a pin or a box the person has drawn but not posted yet. */
export type ViewerDraft =
  | { readonly kind: 'pin'; readonly point: NormalizedPoint; readonly pageNo: number | null }
  | { readonly kind: 'box'; readonly box: NormalizedBox; readonly pageNo: number | null };

export interface PinLayerProps {
  /** The threads anchored on what the stage shows now (this version, this page). */
  readonly threads: readonly ReviewThread[];
  readonly selectedThreadId: string | null;
  readonly draft: ViewerDraft | null;
  /** The number the draft will get, shown on its pin. */
  readonly draftNumber: number;
  /** A box being dragged right now (box tool), before it becomes a draft. */
  readonly sketchBox: NormalizedBox | null;
  /** Pins can be dragged (own pins, Select tool). */
  readonly allowMove: boolean;
  readonly onSelect: (threadId: string) => void;
  readonly onMove: (thread: ReviewThread, point: NormalizedPoint) => void;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(3)}%`;
}

/**
 * The numbered pins and dashed boxes over the artwork (V-03, Viewer/Pin `460:22105`).
 *
 * Positioned with physical `left`/`top` percentages of the artwork box, never logical insets: the
 * artwork is not mirrored in Arabic, so neither are the pins. A pin's tip (its bottom-left corner)
 * is the anchor point. Each pin is a real button in number order, so a keyboard reaches every
 * comment and Enter opens it in the panel.
 */
export function PinLayer({
  threads,
  selectedThreadId,
  draft,
  draftNumber,
  sketchBox,
  allowMove,
  onSelect,
  onMove,
}: PinLayerProps) {
  const t = useT();
  const layerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<{
    readonly threadId: string;
    readonly point: NormalizedPoint;
    readonly moved: boolean;
  } | null>(null);

  const ordered = threads.slice().sort((a, b) => a.number - b.number);

  function pointFor(event: ReactPointerEvent): NormalizedPoint | null {
    const rect = layerRef.current?.getBoundingClientRect();
    return rect ? toNormalizedPoint(event.clientX, event.clientY, rect) : null;
  }

  function label(thread: ReviewThread): string {
    const state = thread.status === 'resolved' ? t('Viewer.pin.resolved') : t('Viewer.pin.open');
    return t('Viewer.pin.label')
      .replace('{number}', String(thread.number))
      .replace('{state}', state);
  }

  return (
    <div ref={layerRef} className="tm-viewer-pins" data-testid="viewer-pin-layer">
      {ordered.map((thread) => {
        const box = thread.anchorKind === 'box' ? readBox(thread.anchor) : null;
        const stored = readPoint(thread.anchor);
        if (!stored) return null;
        const point =
          dragging && dragging.threadId === thread.id && dragging.moved ? dragging.point : stored;
        const selected = thread.id === selectedThreadId;
        const state = selected ? 'selected' : thread.status === 'resolved' ? 'resolved' : 'open';
        const movable = allowMove && thread.canMove && thread.anchorKind === 'pin';
        return (
          <div key={thread.id} className="tm-viewer-pins__item">
            {box ? (
              <div
                className="tm-viewer-box"
                data-state={state}
                style={{
                  left: pct(box.x),
                  top: pct(box.y),
                  width: pct(box.w),
                  height: pct(box.h),
                }}
                aria-hidden="true"
              />
            ) : null}
            <button
              type="button"
              className="tm-viewer-pin"
              data-state={state}
              data-movable={movable ? 'true' : undefined}
              style={{ left: pct(point.x), top: pct(point.y) }}
              aria-label={label(thread)}
              aria-pressed={selected}
              onClick={() => {
                if (dragging?.moved) return;
                onSelect(thread.id);
              }}
              onPointerDown={(event) => {
                if (!movable || event.button !== 0) return;
                event.stopPropagation();
                (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
                setDragging({ threadId: thread.id, point: stored, moved: false });
              }}
              onPointerMove={(event) => {
                if (!dragging || dragging.threadId !== thread.id) return;
                const next = pointFor(event);
                if (!next) return;
                const moved =
                  dragging.moved ||
                  Math.abs(next.x - stored.x) > 0.005 ||
                  Math.abs(next.y - stored.y) > 0.005;
                setDragging({ threadId: thread.id, point: next, moved });
              }}
              onPointerUp={() => {
                if (!dragging || dragging.threadId !== thread.id) return;
                if (dragging.moved) onMove(thread, dragging.point);
                // Let the click that follows this pointer-up see `moved` before clearing it.
                window.setTimeout(() => setDragging(null), 0);
              }}
              onPointerCancel={() => setDragging(null)}
            >
              <span aria-hidden="true">{thread.number}</span>
            </button>
          </div>
        );
      })}

      {sketchBox ? (
        <div
          className="tm-viewer-box"
          data-state="draft"
          style={{
            left: pct(sketchBox.x),
            top: pct(sketchBox.y),
            width: pct(sketchBox.w),
            height: pct(sketchBox.h),
          }}
          aria-hidden="true"
        />
      ) : null}

      {draft ? (
        <div className="tm-viewer-pins__item">
          {draft.kind === 'box' ? (
            <div
              className="tm-viewer-box"
              data-state="draft"
              style={{
                left: pct(draft.box.x),
                top: pct(draft.box.y),
                width: pct(draft.box.w),
                height: pct(draft.box.h),
              }}
              aria-hidden="true"
            />
          ) : null}
          <span
            className="tm-viewer-pin"
            data-state="draft"
            style={{
              left: pct(draft.kind === 'box' ? draft.box.x : draft.point.x),
              top: pct(draft.kind === 'box' ? draft.box.y : draft.point.y),
            }}
            aria-hidden="true"
          >
            {draftNumber}
          </span>
        </div>
      ) : null}
    </div>
  );
}
