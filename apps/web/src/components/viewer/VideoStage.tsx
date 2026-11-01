'use client';

import { useEffect, useMemo, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { InlineAlert } from '@tmanage/ui';
import type { PreviewMedia } from '../../lib/api/file-preview';
import type { ReviewThread } from '../../lib/api/review';
import { useT } from '../../lib/i18n/use-t';
import { MediaCodecNotice } from './MediaCodecNotice';
import { MediaControls, withClock } from './MediaControls';
import { Timeline } from './Timeline';
import { formatClock, timeMarkers } from './media-time';
import { useMediaPlayer } from './use-media-player';
import './media-stage.css';

/** What the shell's pin layer is told about the frame under it. */
export interface VideoFrameState {
  /** The moment shown; a pin dropped now is anchored `{ timeMs, x, y }`. */
  readonly timeMs: number;
  readonly paused: boolean;
  /** The picture's own size (for normalising pin coordinates 0..1). */
  readonly width: number | null;
  readonly height: number | null;
}

export interface VideoStageProps {
  /** Absolute URL of the original (`…/content?inline=1`), sent with the session cookie. */
  readonly src: string;
  readonly media: PreviewMedia | null;
  /** The manifest's length, used until the element reads its own. */
  readonly durationMs: number | null;
  readonly sizeBytes?: number | null;
  readonly threads: readonly ReviewThread[];
  /** The version being played: only its moments are on the timeline. */
  readonly fileVersionId: string | null;
  readonly selectedThreadId: string | null;
  readonly onSelectThread: (threadId: string) => void;
  /** "Comment at 0:42": the shell opens its composer with a `time` anchor. Absent = no comments. */
  readonly onCommentAt?: (timeMs: number) => void;
  /** Saves the original (shown on the codec notice). */
  readonly onDownload?: () => void;
  /** Staff only: upload a playable version (shown on the codec notice). */
  readonly onUploadVersion?: () => void;
  /**
   * Hook point for the viewer shell (slice 6–8): the pin layer drawn over the paused frame, so a
   * pin on a video is `{ timeMs, x, y }`. Rendered inside the frame box, above the picture.
   */
  readonly renderFrameOverlay?: (frame: VideoFrameState) => ReactNode;
  /** Hook point: the shell's tool bar (select · pin · box · draw), top-start of the frame. */
  readonly toolbar?: ReactNode;
  /** Told whenever the clock moves (the shell's composer can show "at 0:42"). */
  readonly onTimeChange?: (timeMs: number) => void;
}

/**
 * **V-20 Video** (Figma `462:22995` EN / `462:23521` AR; phone `462:23419` / `462:23943`; codec
 * notice `462:23266` / `462:23792`).
 *
 * The original plays straight from the API with HTTP Range (`<video crossorigin="use-credentials"
 * preload="metadata">`), so seeking a 100 MB file fetches only what is shown. Comments are
 * moments: numbered markers on the timeline, "Comment at 0:42", and — through
 * `renderFrameOverlay` — pins on the paused frame. Selecting a thread jumps to its moment and
 * pauses. Keys: Space plays or pauses; `,` and `.` step one frame.
 *
 * When the preview job found a codec browsers cannot play (`media.codecNotice`), or the browser
 * refuses the file anyway, the frame shows the codec notice instead of a dead player.
 */
export function VideoStage({
  src,
  media,
  durationMs,
  sizeBytes = null,
  threads,
  fileVersionId,
  selectedThreadId,
  onSelectThread,
  onCommentAt,
  onDownload,
  onUploadVersion,
  renderFrameOverlay,
  toolbar,
  onTimeChange,
}: VideoStageProps) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const player = useMediaPlayer(videoRef, { durationMs, frameRate: media?.frameRate ?? null });
  const markers = useMemo(() => timeMarkers(threads, fileVersionId), [threads, fileVersionId]);
  const blocked = media?.codecNotice != null || player.unplayable;

  // Selecting a thread (here or in the panel) jumps to its moment, paused there.
  const { seek, pause } = player;
  useEffect(() => {
    const marker = markers.find((candidate) => candidate.threadId === selectedThreadId);
    if (!marker) return;
    pause();
    seek(marker.timeMs);
  }, [selectedThreadId, markers, seek, pause]);

  useEffect(() => {
    onTimeChange?.(player.currentMs);
  }, [player.currentMs, onTimeChange]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, [contenteditable="true"]')) return;
    if (event.key === ',' || event.key === '.') {
      event.preventDefault();
      player.stepFrame(event.key === '.' ? 1 : -1);
      return;
    }
    // Space on a button presses that button; only the frame itself plays and pauses.
    if ((event.key === ' ' || event.key === 'k') && !target.closest('button, [role="slider"]')) {
      event.preventDefault();
      player.togglePlay();
    }
  };

  const width = media?.width ?? null;
  const height = media?.height ?? null;
  const turned = media?.rotation === 90 || media?.rotation === 270;
  const aspect =
    width && height ? (turned ? `${height} / ${width}` : `${width} / ${height}`) : '16 / 9';

  if (blocked) {
    return (
      <div className="tm-media-stage tm-media-stage--video">
        <InlineAlert tone="warning" className="tm-media-stage__alert">
          {t('ViewerMedia.codec.alert')}
        </InlineAlert>
        <div className="tm-media-frame tm-media-frame--notice">
          <MediaCodecNotice
            kind="video"
            media={media}
            durationMs={player.durationMs}
            sizeBytes={sizeBytes}
            {...(onDownload ? { onDownload } : {})}
            {...(onUploadVersion ? { onUploadVersion } : {})}
          />
        </div>
        <p className="tm-media-stage__hint">{t('ViewerMedia.codec.hint')}</p>
      </div>
    );
  }

  return (
    // The player is one keyboard surface, as a media player is: Space plays or pauses and `,` / `.`
    // step a frame wherever focus sits inside it (the named group is what a screen reader lands on).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className="tm-media-stage tm-media-stage--video"
      role="group"
      aria-label={t('ViewerMedia.videoLabel')}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="tm-media-frame" style={{ aspectRatio: aspect }}>
        {/* A proof under review has no caption track; the comments are its text layer. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={videoRef}
          className="tm-media-frame__video"
          src={src}
          crossOrigin="use-credentials"
          preload="metadata"
          playsInline
          onClick={() => {
            if (!renderFrameOverlay) player.togglePlay();
          }}
        />
        {renderFrameOverlay ? (
          <div className="tm-media-frame__overlay">
            {renderFrameOverlay({
              timeMs: player.currentMs,
              paused: !player.playing,
              width,
              height,
            })}
          </div>
        ) : null}
        {toolbar ? <div className="tm-media-frame__toolbar">{toolbar}</div> : null}
        {!player.playing && player.ready ? (
          <span className="tm-media-frame__paused">
            {withClock(t('ViewerMedia.pausedAt'), formatClock(player.currentMs))}
          </span>
        ) : null}
      </div>
      <MediaControls
        playing={player.playing}
        currentMs={player.currentMs}
        durationMs={player.durationMs}
        rate={player.rate}
        muted={player.muted}
        ready={player.ready}
        onTogglePlay={player.togglePlay}
        onRate={player.cycleRate}
        onToggleMute={player.toggleMute}
        onFrameStep={() => player.stepFrame(1)}
        {...(onCommentAt
          ? {
              onCommentAt: () => {
                player.pause();
                onCommentAt(player.currentMs);
              },
            }
          : {})}
      />
      <Timeline
        durationMs={player.durationMs}
        currentMs={player.currentMs}
        markers={markers}
        selectedThreadId={selectedThreadId}
        onSeek={player.seek}
        onSelectMarker={onSelectThread}
      />
      <p className="tm-media-stage__hint">
        {onCommentAt ? t('ViewerMedia.videoHint') : t('ViewerMedia.videoHintReadOnly')}
      </p>
    </div>
  );
}
