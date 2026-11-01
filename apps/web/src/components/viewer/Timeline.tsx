'use client';

import { useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { useT } from '../../lib/i18n/use-t';
import { formatClock, fractionOf, msAtFraction } from './media-time';
import type { TimeMarker } from './media-time';

/** Arrow keys move the playhead this far; Page Up / Page Down ten times as far. */
const KEY_STEP_MS = 5000;

export interface TimelineMarkerButtonProps {
  readonly marker: TimeMarker;
  readonly selected: boolean;
  readonly onSelect: (threadId: string) => void;
}

/**
 * One numbered dot (Figma V-20 `462:23146`…`462:23152`): open = lime with an ink ring, selected =
 * ink with a lime number and larger, resolved = surface with a muted number. A button, so a
 * keyboard reaches every comment on the timeline; its name says which comment and when.
 */
export function TimelineMarkerButton({ marker, selected, onSelect }: TimelineMarkerButtonProps) {
  const t = useT();
  const label = t('ViewerMedia.marker')
    .replace('{number}', String(marker.number))
    .replace('{time}', formatClock(marker.timeMs));
  const state = selected ? 'selected' : marker.state;
  return (
    <button
      type="button"
      className={`tm-media-marker tm-media-marker--${state}`}
      aria-label={label}
      aria-pressed={selected}
      data-thread-id={marker.threadId}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(marker.threadId);
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span aria-hidden="true">{marker.number}</span>
    </button>
  );
}

export interface TimelineProps {
  readonly durationMs: number | null;
  readonly currentMs: number;
  readonly markers: readonly TimeMarker[];
  readonly selectedThreadId: string | null;
  readonly onSeek: (ms: number) => void;
  readonly onSelectMarker: (threadId: string) => void;
}

/**
 * V-20 timeline (`462:23143`, "LTR in both languages"): the played part in lime, the rest on the
 * strong border at 35 %, an ink playhead, the comment markers above, start and end times below.
 * The bar is a slider: click or drag to seek, arrow keys ±5 s, Home / End.
 */
export function Timeline({
  durationMs,
  currentMs,
  markers,
  selectedThreadId,
  onSeek,
  onSelectMarker,
}: TimelineProps) {
  const t = useT();
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const played = fractionOf(currentMs, durationMs);
  const known = durationMs !== null && durationMs > 0;

  const seekToPointer = (clientX: number) => {
    const track = trackRef.current;
    if (!track || !known) return;
    const box = track.getBoundingClientRect();
    if (box.width <= 0) return;
    onSeek(msAtFraction((clientX - box.left) / box.width, durationMs));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragging.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    seekToPointer(event.clientX);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) seekToPointer(event.clientX);
  };

  const endDrag = () => {
    dragging.current = false;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!known) return;
    const max = durationMs as number;
    const moves: Record<string, number> = {
      ArrowLeft: currentMs - KEY_STEP_MS,
      ArrowDown: currentMs - KEY_STEP_MS,
      ArrowRight: currentMs + KEY_STEP_MS,
      ArrowUp: currentMs + KEY_STEP_MS,
      PageDown: currentMs - KEY_STEP_MS * 10,
      PageUp: currentMs + KEY_STEP_MS * 10,
      Home: 0,
      End: max,
    };
    const target = moves[event.key];
    if (target === undefined) return;
    event.preventDefault();
    onSeek(Math.min(max, Math.max(0, target)));
  };

  const valueText = t('ViewerMedia.position')
    .replace('{time}', formatClock(currentMs))
    .replace('{duration}', formatClock(durationMs));

  return (
    <div className="tm-media-timeline" dir="ltr">
      <div className="tm-media-timeline__markers">
        {known
          ? markers.map((marker) => (
              <span
                key={marker.threadId}
                className="tm-media-timeline__marker-slot"
                style={{ left: `${fractionOf(marker.timeMs, durationMs) * 100}%` }}
              >
                <TimelineMarkerButton
                  marker={marker}
                  selected={marker.threadId === selectedThreadId}
                  onSelect={onSelectMarker}
                />
              </span>
            ))
          : null}
      </div>
      <div
        ref={trackRef}
        className="tm-media-timeline__track"
        role="slider"
        tabIndex={0}
        aria-label={t('ViewerMedia.timeline')}
        aria-valuemin={0}
        aria-valuemax={known ? Math.round((durationMs as number) / 1000) : 0}
        aria-valuenow={Math.round(currentMs / 1000)}
        aria-valuetext={valueText}
        aria-disabled={!known || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        <span className="tm-media-timeline__rail" aria-hidden="true" />
        <span
          className="tm-media-timeline__played"
          aria-hidden="true"
          style={{ width: `${played * 100}%` }}
        />
        <span
          className="tm-media-timeline__playhead"
          aria-hidden="true"
          style={{ left: `${played * 100}%` }}
        />
      </div>
      <div className="tm-media-timeline__ends" aria-hidden="true">
        <span>{formatClock(0)}</span>
        <span>{formatClock(durationMs)}</span>
      </div>
    </div>
  );
}
