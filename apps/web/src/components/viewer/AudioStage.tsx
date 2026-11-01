'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Avatar, InlineAlert } from '@tmanage/ui';
import type { PreviewMedia } from '../../lib/api/file-preview';
import type { ReviewThread } from '../../lib/api/review';
import { useT } from '../../lib/i18n/use-t';
import { MediaCodecNotice } from './MediaCodecNotice';
import { MediaControls } from './MediaControls';
import { Timeline, TimelineMarkerButton } from './Timeline';
import { MediaIcon } from './media-icons';
import { WAVEFORM_MAX_MS, firstLineOf, formatClock, fractionOf, timeMarkers } from './media-time';
import { useMediaPlayer } from './use-media-player';
import './media-stage.css';

/** The waveform the stage draws into `container`, playing through `media`. */
export interface Waveform {
  destroy(): void;
}

/**
 * Makes the waveform. The default loads wavesurfer.js (BSD-3-Clause) on demand, so the viewer
 * bundle does not carry it for images and PDFs; tests pass a fake (jsdom has no Web Audio).
 */
export type WaveformFactory = (input: {
  readonly container: HTMLElement;
  readonly media: HTMLMediaElement;
  readonly url: string;
  readonly waveColor: string;
  readonly progressColor: string;
}) => Promise<Waveform>;

const wavesurferFactory: WaveformFactory = async ({
  container,
  media,
  url,
  waveColor,
  progressColor,
}) => {
  const { default: WaveSurfer } = await import('wavesurfer.js');
  return WaveSurfer.create({
    container,
    media,
    url,
    height: 120,
    waveColor,
    progressColor,
    cursorWidth: 0,
    barWidth: 4,
    barGap: 4,
    barRadius: 2,
    normalize: true,
    interact: true,
    dragToSeek: true,
    fetchParams: { credentials: 'include' },
  });
};

/** A design token's value on `element` (wavesurfer draws on a canvas, which needs real colours). */
function tokenColour(element: HTMLElement, name: string, fallback: string): string {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  return value || fallback;
}

export interface AudioStageProps {
  /** Absolute URL of the original (`…/content?inline=1`), sent with the session cookie. */
  readonly src: string;
  readonly fileName: string;
  /** The detected type, for the facts chip ("MP3 · 44.1 kHz · stereo · 0:30"). */
  readonly mimeType: string | null;
  readonly media: PreviewMedia | null;
  readonly durationMs: number | null;
  readonly sizeBytes?: number | null;
  readonly threads: readonly ReviewThread[];
  readonly fileVersionId: string | null;
  readonly selectedThreadId: string | null;
  readonly onSelectThread: (threadId: string) => void;
  /** "Comment at 0:12": the shell opens its composer with a `time` anchor. Absent = no comments. */
  readonly onCommentAt?: (timeMs: number) => void;
  readonly onDownload?: () => void;
  readonly onUploadVersion?: () => void;
  readonly onTimeChange?: (timeMs: number) => void;
  /** Injected by tests. */
  readonly waveformFactory?: WaveformFactory;
}

const FORMAT_BY_MIME: Readonly<Record<string, string>> = {
  'audio/mpeg': 'MP3',
  'audio/wav': 'WAV',
  'audio/ogg': 'OGG',
  'audio/flac': 'FLAC',
  'audio/mp4': 'M4A',
};

/** "44.1 kHz", "48 kHz". */
function kilohertz(sampleRate: number): string {
  const khz = sampleRate / 1000;
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
}

/**
 * **V-21 Audio** (Figma `463:24243` EN / `463:24773` AR; phone `463:24613` / `463:25139`).
 *
 * The waveform is computed in the browser by wavesurfer.js from the original (Range-capable
 * content route); the numbered markers stand on it as lime lines, and "On the timeline" lists
 * every moment comment in time order. Clicking the waveform jumps there; "Comment at 0:12" opens
 * the shell's composer with a `time` anchor. Files over 30 minutes get the plain timeline
 * instead of a waveform (decoding them would hold the whole file in memory). Time runs left to
 * right in Arabic too; the card around it mirrors.
 */
export function AudioStage({
  src,
  fileName,
  mimeType,
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
  onTimeChange,
  waveformFactory = wavesurferFactory,
}: AudioStageProps) {
  const t = useT();
  const audioRef = useRef<HTMLAudioElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const player = useMediaPlayer(audioRef, { durationMs });
  const markers = useMemo(() => timeMarkers(threads, fileVersionId), [threads, fileVersionId]);
  const blocked = media?.codecNotice != null || player.unplayable;
  const length = player.durationMs;
  const drawWave = !blocked && (length === null || length <= WAVEFORM_MAX_MS);
  const [waveFailed, setWaveFailed] = useState(false);
  const momentsTitleId = useId();
  const showWave = drawWave && !waveFailed;

  useEffect(() => {
    const container = waveRef.current;
    const element = audioRef.current;
    if (!showWave || !container || !element) return undefined;
    let wave: Waveform | null = null;
    let cancelled = false;
    waveformFactory({
      container,
      media: element,
      url: src,
      waveColor: tokenColour(container, '--ink-500', '#74786f'),
      progressColor: tokenColour(container, '--ink-950', '#090a09'),
    })
      .then((made) => {
        if (cancelled) made.destroy();
        else wave = made;
      })
      .catch(() => {
        if (!cancelled) setWaveFailed(true);
      });
    return () => {
      cancelled = true;
      wave?.destroy();
    };
  }, [showWave, src, waveformFactory]);

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

  const facts = [
    (mimeType && FORMAT_BY_MIME[mimeType]) ?? media?.audioCodec ?? null,
    media?.sampleRate ? kilohertz(media.sampleRate) : null,
    media?.channels === 1
      ? t('ViewerMedia.mono')
      : media?.channels === 2
        ? t('ViewerMedia.stereo')
        : media?.channels
          ? t('ViewerMedia.channels').replace('{count}', String(media.channels))
          : null,
    length ? formatClock(length) : null,
  ].filter((fact): fact is string => Boolean(fact));

  if (blocked) {
    return (
      <div className="tm-media-stage tm-media-stage--audio">
        <InlineAlert tone="warning" className="tm-media-stage__alert">
          {t('ViewerMedia.codec.audioAlert')}
        </InlineAlert>
        <div className="tm-media-frame tm-media-frame--notice">
          <MediaCodecNotice
            kind="audio"
            media={media}
            durationMs={length}
            sizeBytes={sizeBytes}
            {...(onDownload ? { onDownload } : {})}
            {...(onUploadVersion ? { onUploadVersion } : {})}
          />
        </div>
        <p className="tm-media-stage__hint">{t('ViewerMedia.codec.audioHint')}</p>
      </div>
    );
  }

  const byThread = new Map(threads.map((thread) => [thread.id, thread]));

  return (
    <div className="tm-media-stage tm-media-stage--audio">
      <section className="tm-media-wave-card" aria-label={t('ViewerMedia.audioLabel')}>
        <header className="tm-media-wave-card__head">
          <span className="tm-media-wave-card__orb" aria-hidden="true">
            <MediaIcon name="waveform" />
          </span>
          <h2 className="tm-media-wave-card__title">{fileName}</h2>
          {facts.length > 0 ? (
            <span className="tm-media-wave-card__facts" dir="ltr">
              {facts.join(' · ')}
            </span>
          ) : null}
        </header>
        {/* The sound itself: wavesurfer plays through this element, so the controls drive it. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a proof has no caption track */}
        <audio ref={audioRef} src={src} crossOrigin="use-credentials" preload="metadata" />
        {showWave ? (
          <div className="tm-media-wave" dir="ltr">
            <div ref={waveRef} className="tm-media-wave__canvas" />
            {length
              ? markers.map((marker) => (
                  <span
                    key={marker.threadId}
                    className={`tm-media-wave__line tm-media-wave__line--${
                      marker.threadId === selectedThreadId ? 'selected' : marker.state
                    }`}
                    style={{ left: `${fractionOf(marker.timeMs, length) * 100}%` }}
                  >
                    <TimelineMarkerButton
                      marker={marker}
                      selected={marker.threadId === selectedThreadId}
                      onSelect={onSelectThread}
                    />
                  </span>
                ))
              : null}
            <div className="tm-media-wave__ends" aria-hidden="true">
              <span>{formatClock(0)}</span>
              <span>{formatClock(length)}</span>
            </div>
          </div>
        ) : (
          <Timeline
            durationMs={length}
            currentMs={player.currentMs}
            markers={markers}
            selectedThreadId={selectedThreadId}
            onSeek={player.seek}
            onSelectMarker={onSelectThread}
          />
        )}
      </section>
      <MediaControls
        playing={player.playing}
        currentMs={player.currentMs}
        durationMs={length}
        rate={player.rate}
        muted={player.muted}
        ready={player.ready}
        onTogglePlay={player.togglePlay}
        onRate={player.cycleRate}
        onToggleMute={player.toggleMute}
        {...(onCommentAt
          ? {
              onCommentAt: () => {
                player.pause();
                onCommentAt(player.currentMs);
              },
            }
          : {})}
      />
      <p className="tm-media-stage__hint">
        {onCommentAt ? t('ViewerMedia.audioHint') : t('ViewerMedia.audioHintReadOnly')}
      </p>
      {markers.length > 0 ? (
        <section className="tm-media-moments" aria-labelledby={momentsTitleId}>
          <header className="tm-media-moments__head">
            <h3 id={momentsTitleId} className="tm-media-moments__title">
              {t('ViewerMedia.moments')}
            </h3>
            <span className="tm-media-moments__sort">{t('ViewerMedia.momentsSorted')}</span>
          </header>
          <ul className="tm-media-moments__list">
            {markers.map((marker) => {
              const thread = byThread.get(marker.threadId);
              const author = thread?.createdBy.displayName ?? t('ViewerMedia.formerMember');
              const first = firstLineOf(thread?.comments[0]?.body ?? '', t('ViewerMedia.someone'));
              const selected = marker.threadId === selectedThreadId;
              return (
                <li key={marker.threadId}>
                  <button
                    type="button"
                    className={`tm-media-moment${selected ? ' tm-media-moment--selected' : ''}${
                      marker.state === 'resolved' ? ' tm-media-moment--resolved' : ''
                    }`}
                    aria-pressed={selected}
                    onClick={() => onSelectThread(marker.threadId)}
                  >
                    <span
                      className={`tm-media-moment__number tm-media-marker--${marker.state}`}
                      aria-hidden="true"
                    >
                      {marker.number}
                    </span>
                    <span className="tm-media-moment__time" dir="ltr">
                      {formatClock(marker.timeMs)}
                    </span>
                    <span className="tm-media-moment__text">{first}</span>
                    <Avatar
                      name={author}
                      size="compact"
                      audience={thread?.createdBy.kind === 'client' ? 'client' : 'internal'}
                      className="tm-media-moment__avatar"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
