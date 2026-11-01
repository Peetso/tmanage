import { createRequire } from 'node:module';
import { failed, unsupported } from './types.js';
import type { PreviewGenerator, PreviewOutcome } from './types.js';

/**
 * R4 slice 9 — video and audio facts (`media_meta`), read with mediainfo.js (MediaInfoLib compiled
 * to WebAssembly, BSD-2-Clause). Nothing is transcoded: Hostinger shared hosting has no ffmpeg and
 * a WASM encoder would be GPL and far too heavy (SPEC R4 §2). The browser plays the original
 * through the Range-capable content route; this row tells the viewer how long the file is, how big
 * the picture is, and whether a browser can play it at all (an HEVC or ProRes `.mov` cannot in
 * Chrome or Firefox — the screen then says so and offers the download).
 *
 * The answer is a meta-only row: no derivative bytes are stored.
 */

const require = createRequire(import.meta.url);

export const MEDIA_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/flac',
] as const;

/** One track as MediaInfo reports it (only the fields read here). */
export interface MediaTrack {
  readonly '@type': string;
  readonly Format?: string;
  readonly Duration?: number | string;
  readonly Width?: number | string;
  readonly Height?: number | string;
  readonly Rotation?: number | string;
  readonly FrameRate?: number | string;
  readonly SamplingRate?: number | string;
  readonly Channels?: number | string;
}

/** The analyser, swappable in tests. Answers the tracks, or throws when it cannot read the file. */
export type MediaAnalyse = (bytes: Uint8Array) => Promise<readonly MediaTrack[]>;

/**
 * Why a browser cannot play the file: its picture codec (HEVC, ProRes …) or its sound codec
 * (AC-3, ALAC …). `null` when the common browsers play it.
 */
export type CodecNotice = 'video_codec' | 'audio_codec';

export interface MediaFacts {
  readonly durationMs: number | null;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  readonly width: number | null;
  readonly height: number | null;
  /** Degrees the player turns the picture (phone videos shot upright say 90). */
  readonly rotation: number;
  readonly frameRate: number | null;
  readonly container: string | null;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  /** Sound samples a second (44100 …) and channel count (1 mono, 2 stereo) of the sound track. */
  readonly sampleRate: number | null;
  readonly channels: number | null;
  readonly codecNotice: CodecNotice | null;
}

/**
 * Picture codecs Chrome, Firefox, Safari and Edge all play inside MP4/MOV. HEVC is left out on
 * purpose: Safari plays it, Chrome only on some hardware, Firefox not at all (SPEC R4 risk 4).
 */
const PLAYABLE_VIDEO = new Set(['avc', 'vp8', 'vp9', 'av1']);

/** Sound codecs every current browser decodes. */
const PLAYABLE_AUDIO = new Set(['aac', 'mpeg audio', 'opus', 'vorbis', 'flac', 'pcm']);

function toNumber(value: number | string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toCount(value: number | string | undefined): number | null {
  const parsed = toNumber(value);
  return parsed !== null && parsed > 0 ? Math.round(parsed) : null;
}

/** Quarter turns only; anything else is treated as upright. */
function toRotation(value: number | string | undefined): number {
  const parsed = toNumber(value);
  if (parsed === null) return 0;
  const turned = ((Math.round(parsed) % 360) + 360) % 360;
  return turned === 90 || turned === 180 || turned === 270 ? turned : 0;
}

/** The facts the viewer needs, from MediaInfo's tracks. `null` when no stream was found. */
export function mediaFactsFrom(tracks: readonly MediaTrack[]): MediaFacts | null {
  const general = tracks.find((track) => track['@type'] === 'General');
  const video = tracks.find((track) => track['@type'] === 'Video');
  const audio = tracks.find((track) => track['@type'] === 'Audio');
  if (!video && !audio) return null;

  const seconds = [general, video, audio]
    .map((track) => toNumber(track?.Duration))
    .filter((value): value is number => value !== null && value > 0);
  const longest = seconds.length > 0 ? Math.max(...seconds) : null;

  const videoCodec = video?.Format?.trim() || null;
  const audioCodec = audio?.Format?.trim() || null;
  let codecNotice: CodecNotice | null = null;
  if (video && !PLAYABLE_VIDEO.has((videoCodec ?? '').toLowerCase())) codecNotice = 'video_codec';
  else if (audio && !PLAYABLE_AUDIO.has((audioCodec ?? '').toLowerCase())) {
    codecNotice = 'audio_codec';
  }

  return {
    durationMs: longest === null ? null : Math.round(longest * 1000),
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
    width: video ? toCount(video.Width) : null,
    height: video ? toCount(video.Height) : null,
    rotation: video ? toRotation(video.Rotation) : 0,
    frameRate: video ? toNumber(video.FrameRate) : null,
    container: general?.Format?.trim() || null,
    videoCodec,
    audioCodec,
    sampleRate: audio ? toCount(audio.SamplingRate) : null,
    channels: audio ? toCount(audio.Channels) : null,
    codecNotice,
  };
}

interface MediaInfoInstance {
  analyzeData(
    size: number,
    readChunk: (size: number, offset: number) => Uint8Array,
  ): Promise<{ media?: { track?: MediaTrack[] } | null }>;
  reset?(): void;
}

type MediaInfoFactory = (options: {
  format: 'object';
  locateFile: (path: string) => string;
}) => Promise<MediaInfoInstance>;

let instance: Promise<MediaInfoInstance> | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** One WASM instance for the process, made on first use (the API boot pays nothing). */
function mediaInfo(): Promise<MediaInfoInstance> {
  if (!instance) {
    const loaded = require('mediainfo.js') as MediaInfoFactory | { default: MediaInfoFactory };
    const factory = typeof loaded === 'function' ? loaded : loaded.default;
    const wasm = require.resolve('mediainfo.js/MediaInfoModule.wasm');
    instance = factory({ format: 'object', locateFile: () => wasm }).catch((error: unknown) => {
      instance = null;
      throw error;
    });
  }
  return instance;
}

/** MediaInfo keeps state per analysis, so files are read one after another. */
const mediaInfoAnalyse: MediaAnalyse = (bytes) => {
  const run = queue.then(async () => {
    const reader = await mediaInfo();
    const result = await reader.analyzeData(bytes.byteLength, (size, offset) =>
      bytes.subarray(offset, offset + size),
    );
    return result.media?.track ?? [];
  });
  queue = run.catch(() => undefined);
  return run;
};

export function createMediaMetaGenerator(
  analyse: MediaAnalyse = mediaInfoAnalyse,
): PreviewGenerator {
  return {
    name: 'media',
    mimeTypes: MEDIA_MIME_TYPES,
    plan() {
      return [{ kind: 'media_meta' }];
    },
    async generate(source, requests) {
      let facts: MediaFacts | null = null;
      try {
        facts = mediaFactsFrom(await analyse(source.bytes));
      } catch {
        facts = null;
      }
      return requests.map((request): PreviewOutcome => {
        if (request.kind !== 'media_meta') return unsupported('unknown_kind');
        if (!facts) return failed('media_unreadable');
        return {
          status: 'ready',
          body: null,
          mimeType: null,
          width: facts.width,
          height: facts.height,
          meta: { ...facts },
        };
      });
    },
  };
}

export const mediaMetaGenerator = createMediaMetaGenerator();
