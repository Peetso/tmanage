'use client';

import type { ReactNode } from 'react';
import { Button } from '@tmanage/ui';
import { useT } from '../../lib/i18n/use-t';
import { MediaIcon } from './media-icons';
import { formatClock, rateLabel } from './media-time';

/**
 * A message with a `{time}` slot, the clock isolated left to right so "0:42" never turns into
 * "42:0" inside an Arabic sentence.
 */
export function withClock(template: string, clock: string): ReactNode {
  const [before = '', after = ''] = template.split('{time}');
  return (
    <>
      {before}
      <bdi dir="ltr">{clock}</bdi>
      {after}
    </>
  );
}

export interface MediaControlsProps {
  readonly playing: boolean;
  readonly currentMs: number;
  readonly durationMs: number | null;
  readonly rate: number;
  readonly muted: boolean;
  /** Can play at all (the element has its metadata). */
  readonly ready: boolean;
  readonly onTogglePlay: () => void;
  readonly onRate: () => void;
  readonly onToggleMute: () => void;
  /** Video only: one frame forward (`.`). Absent for audio. */
  readonly onFrameStep?: () => void;
  /** "Comment at 0:42". Absent when the person may not comment here. */
  readonly onCommentAt?: () => void;
}

/**
 * The player bar shared by V-20 (`462:23113`) and V-21: an ink play / pause orb, the clock, frame
 * step (video), then on the far side the speed chip, sound, and the lime "Comment at 0:42". The
 * row mirrors in Arabic (logical order); the clock itself is always written left to right.
 */
export function MediaControls({
  playing,
  currentMs,
  durationMs,
  rate,
  muted,
  ready,
  onTogglePlay,
  onRate,
  onToggleMute,
  onFrameStep,
  onCommentAt,
}: MediaControlsProps) {
  const t = useT();
  const clock = `${formatClock(currentMs)} / ${formatClock(durationMs)}`;
  return (
    <div className="tm-media-controls" role="group" aria-label={t('ViewerMedia.controls')}>
      <button
        type="button"
        className="tm-media-controls__play"
        aria-label={playing ? t('ViewerMedia.pause') : t('ViewerMedia.play')}
        onClick={onTogglePlay}
        disabled={!ready}
      >
        <MediaIcon name={playing ? 'pause' : 'play'} />
      </button>
      <span className="tm-media-controls__clock" dir="ltr" aria-live="off">
        {clock}
      </span>
      {onFrameStep ? (
        <button
          type="button"
          className="tm-media-controls__icon tm-media-controls__frame-step"
          aria-label={t('ViewerMedia.frameStep')}
          onClick={onFrameStep}
          disabled={!ready}
        >
          <MediaIcon name="frame-step" />
        </button>
      ) : null}
      <span className="tm-media-controls__spacer" />
      <button
        type="button"
        className="tm-media-controls__rate"
        aria-label={t('ViewerMedia.speed').replace('{rate}', rateLabel(rate))}
        onClick={onRate}
        disabled={!ready}
      >
        <span dir="ltr">{rateLabel(rate)}</span>
      </button>
      <button
        type="button"
        className="tm-media-controls__icon tm-media-controls__sound"
        aria-label={muted ? t('ViewerMedia.unmute') : t('ViewerMedia.mute')}
        aria-pressed={muted}
        onClick={onToggleMute}
        disabled={!ready}
      >
        <MediaIcon name={muted ? 'muted' : 'volume'} />
      </button>
      {onCommentAt ? (
        <Button
          tone="lime"
          size="feature"
          className="tm-media-controls__comment"
          onClick={onCommentAt}
          disabled={!ready}
        >
          <MediaIcon name="comment" />
          <span>{withClock(t('ViewerMedia.commentAt'), formatClock(currentMs))}</span>
        </Button>
      ) : null}
    </div>
  );
}
