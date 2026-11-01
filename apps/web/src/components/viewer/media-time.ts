import type { ReviewThread } from '../../lib/api/review';

/**
 * R4 slice 9 — the arithmetic behind the video and audio stages: clock text, where a moment sits
 * on the timeline, which threads are moments, and the frame step. Pure, so it is tested without
 * a media element (jsdom has no decoder).
 *
 * Time always runs left to right, in Arabic too (Figma V-20/V-21, decision 1: as YouTube and
 * Spotify do); the stages mark the timeline `dir="ltr"` and use these fractions as physical
 * `left` offsets.
 */

/** `0:42`, `12:05`, `1:02:03` — Latin digits, as the design shows in both languages. */
export function formatClock(ms: number | null | undefined): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? (ms as number) : 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

/** Where `ms` sits on a timeline of `durationMs`, 0..1 (0 when the length is unknown). */
export function fractionOf(ms: number, durationMs: number | null): number {
  if (!durationMs || durationMs <= 0 || !Number.isFinite(ms)) return 0;
  return Math.min(1, Math.max(0, ms / durationMs));
}

/** The moment a point on the timeline stands for, rounded to the millisecond. */
export function msAtFraction(fraction: number, durationMs: number | null): number {
  if (!durationMs || durationMs <= 0 || !Number.isFinite(fraction)) return 0;
  return Math.round(Math.min(1, Math.max(0, fraction)) * durationMs);
}

export type MarkerState = 'open' | 'resolved';

/** A numbered dot on the timeline: one thread anchored to a moment. */
export interface TimeMarker {
  readonly threadId: string;
  readonly number: number;
  readonly timeMs: number;
  readonly state: MarkerState;
}

/**
 * The threads that are moments (`anchorKind: 'time'`, with `timeMs`) on the version being
 * played, as markers sorted by time then number. A thread drawn on another version stays on that
 * version's timeline; general (`none`) threads are not moments.
 */
export function timeMarkers(
  threads: readonly ReviewThread[],
  fileVersionId: string | null,
): readonly TimeMarker[] {
  return threads
    .filter(
      (thread) =>
        thread.anchorKind === 'time' &&
        typeof thread.timeMs === 'number' &&
        thread.timeMs >= 0 &&
        (fileVersionId === null || thread.fileVersionId === fileVersionId),
    )
    .map((thread) => ({
      threadId: thread.id,
      number: thread.number,
      timeMs: thread.timeMs as number,
      state: thread.status === 'resolved' ? ('resolved' as const) : ('open' as const),
    }))
    .sort((a, b) => a.timeMs - b.timeMs || a.number - b.number);
}

/** Without a known frame rate a step is one 25 fps frame (40 ms). */
export const DEFAULT_FRAME_MS = 40;

/** One frame in milliseconds at `frameRate`, or the 25 fps fallback. */
export function frameMs(frameRate: number | null | undefined): number {
  if (!frameRate || !Number.isFinite(frameRate) || frameRate <= 0 || frameRate > 240) {
    return DEFAULT_FRAME_MS;
  }
  return 1000 / frameRate;
}

/** The playback speeds the speed chip steps through. */
export const PLAYBACK_RATES = [1, 1.5, 2, 0.5] as const;

export function nextRate(current: number): number {
  const index = PLAYBACK_RATES.findIndex((rate) => rate === current);
  return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length] ?? 1;
}

/** `1×`, `1.5×`, `0.5×`. */
export function rateLabel(rate: number): string {
  return `${rate}×`;
}

/** Above this length the waveform is not drawn (decoding it would hold the whole file in memory). */
export const WAVEFORM_MAX_MS = 30 * 60 * 1000;

const CODEC_NAMES: Readonly<Record<string, string>> = {
  HEVC: 'HEVC (H.265)',
  AVC: 'H.264',
  ProRes: 'Apple ProRes',
  'AC-3': 'Dolby Digital (AC-3)',
  'E-AC-3': 'Dolby Digital Plus (E-AC-3)',
  ALAC: 'Apple Lossless (ALAC)',
};

/** The name a person recognises for a MediaInfo format name. */
export function codecDisplayName(codec: string | null | undefined): string | null {
  if (!codec) return null;
  return CODEC_NAMES[codec] ?? codec;
}

const MENTION_TOKEN = /@[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

/**
 * The first line of a comment for the "On the timeline" list: a raw `@<userId>` token reads as
 * "@someone" (an id is never shown), whitespace collapsed.
 */
export function firstLineOf(body: string, someone: string): string {
  const line = body.split(/\r?\n/u).find((part) => part.trim().length > 0) ?? '';
  return line.replace(MENTION_TOKEN, `@${someone}`).replace(/\s+/gu, ' ').trim();
}
