'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { frameMs, nextRate } from './media-time';

/**
 * R4 slice 9 — the state of one `<video>` / `<audio>` element for the media stages: playing,
 * the clock (smooth while playing, from `requestAnimationFrame`), length, speed, sound, and
 * whether the browser refused the file (a codec it cannot decode). The element is the single
 * source of truth; this hook only mirrors it and drives it.
 */

export interface MediaPlayerState {
  readonly playing: boolean;
  readonly currentMs: number;
  /** The element's own length once its metadata is in, else the manifest's. */
  readonly durationMs: number | null;
  readonly rate: number;
  readonly muted: boolean;
  /** The metadata is in: the controls can act. */
  readonly ready: boolean;
  /** The browser could not decode the file (MediaError 3 or 4). */
  readonly unplayable: boolean;
}

export interface MediaPlayer extends MediaPlayerState {
  togglePlay(): void;
  pause(): void;
  seek(ms: number): void;
  /** One frame forward (or back with `direction = -1`), pausing first. */
  stepFrame(direction?: 1 | -1): void;
  cycleRate(): void;
  toggleMute(): void;
}

const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

export function useMediaPlayer(
  ref: RefObject<HTMLMediaElement | null>,
  options: { readonly durationMs: number | null; readonly frameRate?: number | null },
): MediaPlayer {
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [elementMs, setElementMs] = useState<number | null>(null);
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState(false);
  const [ready, setReady] = useState(false);
  const [unplayable, setUnplayable] = useState(false);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const read = () => setCurrentMs(Math.round(element.currentTime * 1000));
    const tick = () => {
      read();
      frame.current = requestAnimationFrame(tick);
    };
    const stopTicking = () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
    const onMeta = () => {
      if (Number.isFinite(element.duration) && element.duration > 0) {
        setElementMs(Math.round(element.duration * 1000));
      }
      setReady(true);
      read();
    };
    const onPlay = () => {
      setPlaying(true);
      stopTicking();
      frame.current = requestAnimationFrame(tick);
    };
    const onPause = () => {
      setPlaying(false);
      stopTicking();
      read();
    };
    const onError = () => {
      const code = element.error?.code;
      if (code === MEDIA_ERR_DECODE || code === MEDIA_ERR_SRC_NOT_SUPPORTED) setUnplayable(true);
      onPause();
    };
    const onVolume = () => setMuted(element.muted);
    const onRate = () => setRate(element.playbackRate);

    if (element.readyState >= 1) onMeta();
    element.addEventListener('loadedmetadata', onMeta);
    element.addEventListener('durationchange', onMeta);
    element.addEventListener('play', onPlay);
    element.addEventListener('pause', onPause);
    element.addEventListener('ended', onPause);
    element.addEventListener('seeked', read);
    element.addEventListener('timeupdate', read);
    element.addEventListener('error', onError);
    element.addEventListener('volumechange', onVolume);
    element.addEventListener('ratechange', onRate);
    return () => {
      stopTicking();
      element.removeEventListener('loadedmetadata', onMeta);
      element.removeEventListener('durationchange', onMeta);
      element.removeEventListener('play', onPlay);
      element.removeEventListener('pause', onPause);
      element.removeEventListener('ended', onPause);
      element.removeEventListener('seeked', read);
      element.removeEventListener('timeupdate', read);
      element.removeEventListener('error', onError);
      element.removeEventListener('volumechange', onVolume);
      element.removeEventListener('ratechange', onRate);
    };
  }, [ref]);

  const durationMs = elementMs ?? options.durationMs;

  const pause = useCallback(() => {
    ref.current?.pause();
  }, [ref]);

  const togglePlay = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    if (element.paused) {
      // A refused play() (autoplay policy, a codec found out late) leaves the player paused.
      void Promise.resolve(element.play()).catch(() => undefined);
    } else {
      element.pause();
    }
  }, [ref]);

  const seek = useCallback(
    (ms: number) => {
      const element = ref.current;
      if (!element) return;
      const limit = durationMs ?? Number.POSITIVE_INFINITY;
      const target = Math.min(limit, Math.max(0, ms));
      element.currentTime = target / 1000;
      setCurrentMs(Math.round(target));
    },
    [ref, durationMs],
  );

  const stepFrame = useCallback(
    (direction: 1 | -1 = 1) => {
      const element = ref.current;
      if (!element) return;
      element.pause();
      seek(element.currentTime * 1000 + direction * frameMs(options.frameRate));
    },
    [ref, seek, options.frameRate],
  );

  const cycleRate = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    element.playbackRate = nextRate(element.playbackRate);
    setRate(element.playbackRate);
  }, [ref]);

  const toggleMute = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    element.muted = !element.muted;
    setMuted(element.muted);
  }, [ref]);

  return {
    playing,
    currentMs,
    durationMs,
    rate,
    muted,
    ready,
    unplayable,
    togglePlay,
    pause,
    seek,
    stepFrame,
    cycleRate,
    toggleMute,
  };
}
