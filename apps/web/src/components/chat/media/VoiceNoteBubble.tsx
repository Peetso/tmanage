'use client';

import { useEffect, useRef, useState } from 'react';
import { useTOr } from '../../../lib/i18n/use-t-or';
import './media.css';

/** "0:07", "4:59". */
export function formatVoiceClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export const VOICE_SPEEDS = [1, 1.5, 2] as const;

/** The waveform the bubble plays through. */
export interface VoiceWave {
  playPause(): unknown;
  setPlaybackRate(rate: number): void;
  destroy(): void;
}

/** Makes the waveform; tests pass a fake (jsdom has no canvas or audio). */
export type VoiceWaveFactory = (input: {
  readonly container: HTMLElement;
  readonly url: string;
  readonly peaks: readonly number[];
  readonly durationMs: number;
  readonly waveColor: string;
  readonly progressColor: string;
  readonly onPlaying: (playing: boolean) => void;
  readonly onTime: (ms: number) => void;
}) => Promise<VoiceWave>;

/** wavesurfer.js (BSD-3-Clause), loaded on demand as `AudioStage` does; the stored peaks mean no decode. */
const wavesurferFactory: VoiceWaveFactory = async (input) => {
  const { default: WaveSurfer } = await import('wavesurfer.js');
  const wave = WaveSurfer.create({
    container: input.container,
    url: input.url,
    peaks: [[...input.peaks]],
    duration: input.durationMs / 1000,
    height: 32,
    waveColor: input.waveColor,
    progressColor: input.progressColor,
    cursorWidth: 0,
    barWidth: 3,
    barGap: 2,
    barRadius: 2,
    normalize: true,
    interact: true,
    dragToSeek: true,
    fetchParams: { credentials: 'include' },
  });
  wave.on('play', () => input.onPlaying(true));
  wave.on('pause', () => input.onPlaying(false));
  wave.on('finish', () => input.onPlaying(false));
  wave.on('timeupdate', (seconds: number) => input.onTime(seconds * 1000));
  return wave;
};

function tokenColour(element: HTMLElement, name: string, fallback: string): string {
  return getComputedStyle(element).getPropertyValue(name).trim() || fallback;
}

export interface VoiceNoteBubbleProps {
  /** The note's file (`…/content?inline=1`); `null` while the scan has not cleared it. */
  readonly src: string | null;
  readonly durationMs: number;
  readonly peaks: readonly number[];
  /** Somebody (the viewer, for their own reading) already played it: the bars take the quiet tint. */
  readonly listened?: boolean;
  readonly onPlayed?: () => void;
  readonly waveformFactory?: VoiceWaveFactory;
}

/**
 * **R7 voice note bubble** (Figma "Chat (R7)" › Voice note). Play/pause, the stored waveform (64
 * peaks from the recorder, so nothing is decoded before play), elapsed/total time and 1× / 1.5× /
 * 2×. Time runs left to right in Arabic too (`dir="ltr"` on the wave); the bubble mirrors.
 */
export function VoiceNoteBubble({
  src,
  durationMs,
  peaks,
  listened = false,
  onPlayed,
  waveformFactory = wavesurferFactory,
}: VoiceNoteBubbleProps) {
  const tOr = useTOr();
  const waveRef = useRef<HTMLDivElement>(null);
  const wave = useRef<VoiceWave | null>(null);
  const [playing, setPlaying] = useState(false);
  const [timeMs, setTimeMs] = useState(0);
  const [speed, setSpeed] = useState<(typeof VOICE_SPEEDS)[number]>(1);
  const [heard, setHeard] = useState(listened);
  const [ready, setReady] = useState(false);
  const played = useRef(onPlayed);
  played.current = onPlayed;

  useEffect(() => {
    const container = waveRef.current;
    if (src === null || container === null) return undefined;
    let cancelled = false;
    let made: VoiceWave | null = null;
    void waveformFactory({
      container,
      url: src,
      peaks,
      durationMs,
      waveColor: tokenColour(container, '--ink-500', '#8a8a8a'),
      progressColor: tokenColour(container, '--ink-950', '#111111'),
      onPlaying: (now) => {
        setPlaying(now);
        if (now) {
          setHeard(true);
          played.current?.();
        }
      },
      onTime: setTimeMs,
    })
      .then((created) => {
        if (cancelled) created.destroy();
        else {
          made = created;
          wave.current = created;
          setReady(true);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      made?.destroy();
      wave.current = null;
      setReady(false);
    };
  }, [durationMs, peaks, src, waveformFactory]);

  const nextSpeed = () => {
    const next = VOICE_SPEEDS[(VOICE_SPEEDS.indexOf(speed) + 1) % VOICE_SPEEDS.length] ?? 1;
    setSpeed(next);
    wave.current?.setPlaybackRate(next);
  };

  const disabled = src === null;
  return (
    <div
      className="r7-voice"
      data-listened={heard || undefined}
      data-playing={playing || undefined}
    >
      <button
        type="button"
        className="r7-voice__play"
        aria-label={
          playing
            ? tOr('ChatVoice.pause', 'Pause voice note')
            : tOr('ChatVoice.play', 'Play voice note')
        }
        disabled={disabled}
        onClick={() => void wave.current?.playPause()}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          {playing ? (
            <path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" />
          ) : (
            <path d="M8 5v14l11-7z" fill="currentColor" />
          )}
        </svg>
      </button>
      <div className="r7-voice__track" dir="ltr">
        <div className="r7-voice__wave" ref={waveRef} />
        {ready ? null : (
          <div className="r7-voice__bars" aria-hidden="true">
            {peaks.map((peak, index) => (
              <span key={index} style={{ height: `${Math.max(12, Math.round(peak * 100))}%` }} />
            ))}
          </div>
        )}
      </div>
      <span className="r7-voice__time">
        {formatVoiceClock(playing || timeMs > 0 ? timeMs : durationMs)}
      </span>
      <button
        type="button"
        className="r7-voice__speed"
        aria-label={tOr('ChatVoice.speed', 'Playback speed')}
        disabled={disabled}
        onClick={nextSpeed}
      >
        {`${speed}×`}
      </button>
    </div>
  );
}
