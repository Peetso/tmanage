import type { Meta, StoryObj } from '@storybook/react-vite';
import { AudioStage } from '../src/components/viewer/AudioStage';
import type { WaveformFactory } from '../src/components/viewer/AudioStage';
import { VideoStage } from '../src/components/viewer/VideoStage';
import type { PreviewMedia } from '../src/lib/api/file-preview';
import type { ReviewThread } from '../src/lib/api/review';

/**
 * **R4 slice 9 — video and audio stages (Figma V-20 `462:22995`, codec notice `462:23266`,
 * V-21 `463:24243`).** Atlas Hospitality samples from batch C. No network: the video story is the
 * codec notice (a player needs real bytes), and the audio story draws a fixed waveform with a fake
 * factory so the picture is the same on every run.
 */

function thread(
  id: string,
  number: number,
  timeMs: number,
  body: string,
  author: string,
  kind: 'internal' | 'client',
  status: 'open' | 'resolved' = 'open',
): ReviewThread {
  const person = { membershipId: `m-${id}`, displayName: author, kind };
  return {
    id,
    number,
    subjectType: 'file_asset',
    subjectId: 'f1',
    fileVersionId: 'fv1',
    anchorKind: 'time',
    anchor: null,
    pageNo: null,
    timeMs,
    audience: kind === 'client' ? 'client_visible' : 'internal',
    status,
    createdBy: person,
    createdAt: '2026-11-01T10:02:00.000Z',
    resolvedBy: null,
    resolvedAt: null,
    carriedFromThreadId: null,
    comments: [{ id: `${id}-c`, body, createdBy: person, createdAt: '2026-11-01T10:02:00.000Z' }],
    canResolve: true,
    canMove: false,
  } as unknown as ReviewThread;
}

const AUDIO_THREADS = [
  thread(
    'a1',
    1,
    4_000,
    'The voice-over starts before the logo sting ends.',
    'Youssef Kamal',
    'client',
  ),
  thread(
    'a2',
    2,
    12_000,
    'Say "Atlas Hospitality" a little slower here.',
    'Maya Hassan',
    'internal',
  ),
  thread(
    'a3',
    3,
    24_000,
    'The Arabic version needs the same pause before the offer.',
    'Noor Fathy',
    'internal',
  ),
];

/** Fixed bars instead of wavesurfer (deterministic for the visual baseline). */
const fixedWave: WaveformFactory = async ({ container }) => {
  const bars = Array.from(
    { length: 76 },
    (_, i) => 20 + Math.round(80 * Math.abs(Math.sin(i * 0.7) * Math.cos(i * 0.13))),
  );
  container.innerHTML = `<div style="display:flex;align-items:center;gap:4px;height:120px">${bars
    .map(
      (h, i) =>
        `<span style="flex:1;height:${h}%;border-radius:2px;background:${i < 30 ? 'var(--ink-950)' : 'var(--ink-500)'}"></span>`,
    )
    .join('')}</div>`;
  return { destroy: () => (container.innerHTML = '') };
};

const MP3: PreviewMedia = {
  hasVideo: false,
  hasAudio: true,
  width: null,
  height: null,
  rotation: 0,
  frameRate: null,
  videoCodec: null,
  audioCodec: 'MPEG Audio',
  sampleRate: 44_100,
  channels: 2,
  codecNotice: null,
};

const HEVC: PreviewMedia = {
  hasVideo: true,
  hasAudio: true,
  width: 3840,
  height: 2160,
  rotation: 0,
  frameRate: 25,
  videoCodec: 'HEVC',
  audioCodec: 'AAC',
  sampleRate: 48_000,
  channels: 2,
  codecNotice: 'video_codec',
};

const meta: Meta = {
  title: 'Screens/Viewer/Media',
  parameters: { layout: 'padded' },
};
export default meta;

export const AudioWaveform: StoryObj = {
  render: () => (
    <main style={{ maxWidth: 900 }}>
      <AudioStage
        src="about:blank"
        fileName="atlas-radio-spot-30s.mp3"
        mimeType="audio/mpeg"
        media={MP3}
        durationMs={30_000}
        threads={AUDIO_THREADS}
        fileVersionId="fv1"
        selectedThreadId="a2"
        onSelectThread={() => undefined}
        onCommentAt={() => undefined}
        waveformFactory={fixedWave}
      />
    </main>
  ),
};

export const VideoCodecNotice: StoryObj = {
  render: () => (
    <main style={{ maxWidth: 900 }}>
      <VideoStage
        src="about:blank"
        media={HEVC}
        durationMs={124_000}
        sizeBytes={286 * 1024 * 1024}
        threads={[]}
        fileVersionId="fv1"
        selectedThreadId={null}
        onSelectThread={() => undefined}
        onDownload={() => undefined}
        onUploadVersion={() => undefined}
      />
    </main>
  ),
};
