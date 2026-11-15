'use client';

import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/** Movement (px) before a press counts as a drag rather than a click. */
const PAN_SLOP = 3;

/** What a press must not start a pan on: pins, popovers, buttons, links and fields. */
const INTERACTIVE = '.tm-viewer-pin, .tm-viewer-popover, button, a, input, textarea, select';

function overflows(box: HTMLElement): boolean {
  return box.scrollWidth > box.clientWidth || box.scrollHeight > box.clientHeight;
}

export interface DragPan {
  readonly panning: boolean;
  readonly handlers: {
    readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    readonly onPointerCancel: () => void;
  };
}

/**
 * FIX6 item 5 (live check B12): dragging a zoomed picture moves it, as in any image viewer. The
 * scroll box's own scroll position moves, so the scrollbars, the keyboard and the wheel keep
 * working as before. Only with the pointer tool (`enabled`), only with the main button, never
 * from a pin or a control, and only when the picture is larger than the box.
 */
export function useDragPan(enabled: boolean): DragPan {
  const start = useRef<{
    readonly x: number;
    readonly y: number;
    readonly left: number;
    readonly top: number;
    readonly id: number;
  } | null>(null);
  const [panning, setPanning] = useState(false);

  const stop = () => {
    start.current = null;
    setPanning(false);
  };

  return {
    panning,
    handlers: {
      onPointerDown: (event) => {
        if (!enabled || event.button !== 0 || event.pointerType === 'touch') return;
        const box = event.currentTarget;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest(INTERACTIVE)) return;
        if (!overflows(box)) return;
        start.current = {
          x: event.clientX,
          y: event.clientY,
          left: box.scrollLeft,
          top: box.scrollTop,
          id: event.pointerId,
        };
      },
      onPointerMove: (event) => {
        const began = start.current;
        if (!began) {
          // The grab cursor shows only where a drag would move something.
          const box = event.currentTarget;
          const can = enabled && overflows(box);
          if ((box.dataset['pan'] === 'true') !== can) box.dataset['pan'] = can ? 'true' : '';
          return;
        }
        if (began.id !== event.pointerId) return;
        const dx = event.clientX - began.x;
        const dy = event.clientY - began.y;
        if (!panning) {
          if (Math.hypot(dx, dy) < PAN_SLOP) return;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setPanning(true);
        }
        event.currentTarget.scrollLeft = began.left - dx;
        event.currentTarget.scrollTop = began.top - dy;
      },
      onPointerUp: stop,
      onPointerCancel: stop,
    },
  };
}
