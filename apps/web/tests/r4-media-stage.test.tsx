import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioStage } from '../src/components/viewer/AudioStage';
import type { WaveformFactory } from '../src/components/viewer/AudioStage';
import { Timeline } from '../src/components/viewer/Timeline';
import { VideoStage } from '../src/components/viewer/VideoStage';
import {
  DEFAULT_FRAME_MS,
  codecDisplayName,
  firstLineOf,
  formatClock,
  fractionOf,
  frameMs,
  msAtFraction,
  nextRate,
  timeMarkers,
} from '../src/components/viewer/media-time';
import type { PreviewMedia } from '../src/lib/api/file-preview';
import type { ReviewThread } from '../src/lib/api/review';
import { activeLocale } from '../src/lib/i18n/locale-store';
import { expectNoAxeViolations } from './axe';

/**
 * R4 slice 9 — the video and audio stages (Figma V-20 / V-21): the timeline and its numbered
 * markers, "Comment at 0:42", jumping to a selected thread, frame step and speed, the codec notice
 * (from the preview job's facts, and from the browser refusing the file), the waveform card and
 * its "On the timeline" list, and the Arabic twin keeping time left to right. jsdom has no media
 * decoder, so the element's clock is driven by hand.
 */

const SRC = 'https://api.example.test/v1/organizations/atlas/files/f1/content?inline=1';
const VERSION = 'ver-2';

function thread(overrides: Partial<ReviewThread> & { id: string; number: number }): ReviewThread {
  return {
    subjectType: 'file_asset',
    subjectId: 'f1',
    fileVersionId: VERSION,
    anchorKind: 'time',
    anchor: null,
    pageNo: null,
    timeMs: 0,
    audience: 'internal',
    status: 'open',
    createdBy: { membershipId: 'm1', displayName: 'Maya Hassan', kind: 'internal' },
    createdAt: '2026-11-01T10:00:00.000Z',
    resolvedBy: null,
    resolvedAt: null,
    carriedFromThreadId: null,
    comments: [
      {
        id: `${overrides.id}-c1`,
        body: 'A note',
        mentions: [],
        createdBy: { membershipId: 'm1', displayName: 'Maya Hassan', kind: 'internal' },
        createdAt: '2026-11-01T10:00:00.000Z',
        editedAt: null,
        canEdit: false,
        canDelete: false,
      },
    ],
    canResolve: true,
    canMove: false,
    ...overrides,
  } as ReviewThread;
}

const THREADS: readonly ReviewThread[] = [
  thread({ id: 't3', number: 3, timeMs: 42_000 }),
  thread({ id: 't1', number: 1, timeMs: 8_000 }),
  thread({ id: 't4', number: 4, timeMs: 72_000, status: 'resolved' }),
  thread({ id: 't2', number: 2, timeMs: 21_000 }),
  thread({ id: 'tpin', number: 5, anchorKind: 'pin', timeMs: null }),
  thread({ id: 'told', number: 6, timeMs: 5_000, fileVersionId: 'ver-1' }),
];

const H264: PreviewMedia = {
  hasVideo: true,
  hasAudio: true,
  width: 1920,
  height: 1080,
  rotation: 0,
  frameRate: 25,
  videoCodec: 'AVC',
  audioCodec: 'AAC',
  sampleRate: 48_000,
  channels: 2,
  codecNotice: null,
};

/** Gives the jsdom media element a clock, a length and play/pause that fire their events. */
function driveMedia(element: HTMLMediaElement, durationS: number) {
  let time = 0;
  let paused = true;
  Object.defineProperty(element, 'duration', { configurable: true, get: () => durationS });
  Object.defineProperty(element, 'readyState', { configurable: true, get: () => 1 });
  Object.defineProperty(element, 'paused', { configurable: true, get: () => paused });
  Object.defineProperty(element, 'currentTime', {
    configurable: true,
    get: () => time,
    set: (value: number) => {
      time = value;
      element.dispatchEvent(new Event('seeked'));
    },
  });
  element.play = vi.fn(() => {
    paused = false;
    element.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  element.pause = vi.fn(() => {
    if (paused) return;
    paused = true;
    element.dispatchEvent(new Event('pause'));
  });
  act(() => {
    element.dispatchEvent(new Event('loadedmetadata'));
  });
  return {
    get time() {
      return time;
    },
    setTime(seconds: number) {
      act(() => {
        element.currentTime = seconds;
      });
    },
  };
}

afterEach(() => {
  act(() => activeLocale.set('en-US'));
});

describe('media-time', () => {
  it('writes clocks, fractions and frames', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(42_400)).toBe('0:42');
    expect(formatClock(90_000)).toBe('1:30');
    expect(formatClock(3_723_000)).toBe('1:02:03');
    expect(formatClock(null)).toBe('0:00');
    expect(fractionOf(45_000, 90_000)).toBe(0.5);
    expect(fractionOf(120_000, 90_000)).toBe(1);
    expect(fractionOf(10, null)).toBe(0);
    expect(msAtFraction(0.25, 90_000)).toBe(22_500);
    expect(msAtFraction(-1, 90_000)).toBe(0);
    expect(frameMs(25)).toBe(40);
    expect(frameMs(null)).toBe(DEFAULT_FRAME_MS);
    expect(frameMs(1000)).toBe(DEFAULT_FRAME_MS);
    expect([1, 1.5, 2, 0.5].map(nextRate)).toEqual([1.5, 2, 0.5, 1]);
    expect(codecDisplayName('HEVC')).toBe('HEVC (H.265)');
    expect(codecDisplayName('VC-1')).toBe('VC-1');
    expect(firstLineOf('\n  Hi @0193a2b4-1c2d-7e8f-9a0b-1c2d3e4f5a6b,\nmore', 'someone')).toBe(
      'Hi @someone,',
    );
  });

  it('keeps only moments on this version, sorted by time', () => {
    const markers = timeMarkers(THREADS, VERSION);
    expect(markers.map((marker) => marker.number)).toEqual([1, 2, 3, 4]);
    expect(markers[3]).toEqual({ threadId: 't4', number: 4, timeMs: 72_000, state: 'resolved' });
    expect(timeMarkers(THREADS, null).map((marker) => marker.number)).toEqual([6, 1, 2, 3, 4]);
  });
});

describe('Timeline', () => {
  it('names each marker, selects it, and seeks by click and by keys', async () => {
    const onSeek = vi.fn();
    const onSelect = vi.fn();
    const { container } = render(
      <main>
        <Timeline
          durationMs={90_000}
          currentMs={42_000}
          markers={timeMarkers(THREADS, VERSION)}
          selectedThreadId="t3"
          onSeek={onSeek}
          onSelectMarker={onSelect}
        />
      </main>,
    );
    const marker = screen.getByRole('button', { name: 'Comment 3 at 0:42' });
    expect(marker).toHaveAttribute('aria-pressed', 'true');
    expect(marker.parentElement).toHaveStyle({ left: `${(42 / 90) * 100}%` });
    fireEvent.click(screen.getByRole('button', { name: 'Comment 1 at 0:08' }));
    expect(onSelect).toHaveBeenCalledWith('t1');

    const slider = screen.getByRole('slider', { name: 'Timeline' });
    expect(slider).toHaveAttribute('aria-valuetext', '0:42 of 1:30');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onSeek).toHaveBeenLastCalledWith(47_000);
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(onSeek).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(slider, { key: 'End' });
    expect(onSeek).toHaveBeenLastCalledWith(90_000);

    slider.getBoundingClientRect = () =>
      ({ left: 100, width: 900, top: 0, right: 1000, bottom: 26, height: 26 }) as DOMRect;
    fireEvent.pointerDown(slider, { button: 0, clientX: 325, pointerId: 1 });
    expect(onSeek).toHaveBeenLastCalledWith(22_500);
    expect(container.querySelector('.tm-media-timeline')).toHaveAttribute('dir', 'ltr');
    await expectNoAxeViolations(container);
  });
});

describe('VideoStage (V-20)', () => {
  function renderVideo(props: Partial<Parameters<typeof VideoStage>[0]> = {}) {
    const onSelectThread = vi.fn();
    const onCommentAt = vi.fn();
    const view = render(
      <main>
        <VideoStage
          src={SRC}
          media={H264}
          durationMs={90_000}
          sizeBytes={12_000_000}
          threads={THREADS}
          fileVersionId={VERSION}
          selectedThreadId={null}
          onSelectThread={onSelectThread}
          onCommentAt={onCommentAt}
          {...props}
        />
      </main>,
    );
    const video = view.container.querySelector('video') as HTMLVideoElement | null;
    return { ...view, video, onSelectThread, onCommentAt };
  }

  it('plays the original with credentials and Range-friendly preload, markers on the timeline', async () => {
    const { video, container } = renderVideo();
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute('src', SRC);
    expect(video).toHaveAttribute('crossorigin', 'use-credentials');
    expect(video).toHaveAttribute('preload', 'metadata');
    expect(screen.getAllByRole('button', { name: /^Comment \d at / })).toHaveLength(4);
    // Nothing acts until the metadata is in.
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
    driveMedia(video as HTMLVideoElement, 90);
    expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
    expect(screen.getByText('0:00 / 1:30')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('"Comment at" pauses and hands the shell the moment', () => {
    const { video, onCommentAt } = renderVideo();
    const clock = driveMedia(video as HTMLVideoElement, 90);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    clock.setTime(42.4);
    fireEvent.click(screen.getByRole('button', { name: 'Comment at 0:42' }));
    expect(onCommentAt).toHaveBeenCalledWith(42_400);
    expect((video as HTMLVideoElement).pause).toHaveBeenCalled();
    const paused = document.querySelector('.tm-media-frame__paused');
    expect(paused?.textContent).toBe('Paused · 0:42');
  });

  it('selecting a thread jumps to its moment; frame step and speed drive the element', () => {
    const { video, rerender, onSelectThread } = renderVideo();
    const clock = driveMedia(video as HTMLVideoElement, 90);
    rerender(
      <main>
        <VideoStage
          src={SRC}
          media={H264}
          durationMs={90_000}
          threads={THREADS}
          fileVersionId={VERSION}
          selectedThreadId="t2"
          onSelectThread={onSelectThread}
        />
      </main>,
    );
    expect(clock.time).toBe(21);
    // Read-only (no onCommentAt): no comment button, a hint without the pin instruction.
    expect(screen.queryByRole('button', { name: /^Comment at/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next frame' }));
    expect(clock.time).toBeCloseTo(21.04, 5);
    const stage = screen.getByRole('group', { name: 'Video' });
    fireEvent.keyDown(stage, { key: ',' });
    expect(clock.time).toBeCloseTo(21, 5);
    fireEvent.click(screen.getByRole('button', { name: 'Speed 1×' }));
    expect((video as HTMLVideoElement).playbackRate).toBe(1.5);
    expect(screen.getByRole('button', { name: 'Speed 1.5×' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    expect((video as HTMLVideoElement).muted).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Comment 4 at 1:12' }));
    expect(onSelectThread).toHaveBeenCalledWith('t4');
  });

  it('shows the codec notice instead of a player for an HEVC .mov, with download and upload', async () => {
    const onDownload = vi.fn();
    const onUploadVersion = vi.fn();
    const { video, container } = renderVideo({
      media: { ...H264, videoCodec: 'HEVC', width: 3840, height: 2160, codecNotice: 'video_codec' },
      durationMs: 124_000,
      sizeBytes: 286 * 1024 * 1024,
      onDownload,
      onUploadVersion,
    });
    expect(video).toBeNull();
    expect(
      screen.getByRole('heading', { name: "Your browser can't play this video" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/It uses HEVC \(H\.265\)\./)).toBeInTheDocument();
    expect(screen.getByText('HEVC · 3840×2160 · 2:04 · 286 MB')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download original' }));
    fireEvent.click(screen.getByRole('button', { name: 'Upload an MP4 version' }));
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onUploadVersion).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Comments still work/)).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('a client (no upload) sees only the download; a file the browser refuses turns into the notice', () => {
    const { video } = renderVideo({ media: null });
    expect(screen.queryByRole('button', { name: 'Upload an MP4 version' })).toBeNull();
    Object.defineProperty(video, 'error', { configurable: true, get: () => ({ code: 4 }) });
    act(() => {
      (video as HTMLVideoElement).dispatchEvent(new Event('error'));
    });
    expect(
      screen.getByRole('heading', { name: "Your browser can't play this video" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Download it to watch/)).toBeInTheDocument();
  });

  it('Arabic: the bar mirrors, the clock and the timeline stay left to right', () => {
    act(() => activeLocale.set('ar-EG'));
    const { video, container } = renderVideo();
    driveMedia(video as HTMLVideoElement, 90);
    const comment = screen.getByRole('button', { name: /علّق عند/ });
    expect(within(comment).getByText('0:00').tagName).toBe('BDI');
    expect(within(comment).getByText('0:00')).toHaveAttribute('dir', 'ltr');
    expect(container.querySelector('.tm-media-timeline')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByRole('button', { name: 'التعليق 3 عند 0:42' })).toBeInTheDocument();
  });
});

describe('AudioStage (V-21)', () => {
  const fakeWave = () => {
    const destroy = vi.fn();
    const factory = vi.fn<WaveformFactory>(async () => ({ destroy }));
    return { factory, destroy };
  };

  function renderAudio(props: Partial<Parameters<typeof AudioStage>[0]> = {}) {
    const wave = fakeWave();
    const onSelectThread = vi.fn();
    const view = render(
      <main>
        <AudioStage
          src={SRC}
          fileName="atlas-radio-spot-30s.mp3"
          mimeType="audio/mpeg"
          media={{
            ...H264,
            hasVideo: false,
            width: null,
            height: null,
            videoCodec: null,
            audioCodec: 'MPEG Audio',
            sampleRate: 44_100,
          }}
          durationMs={90_000}
          threads={THREADS}
          fileVersionId={VERSION}
          selectedThreadId="t2"
          onSelectThread={onSelectThread}
          onCommentAt={vi.fn()}
          waveformFactory={wave.factory}
          {...props}
        />
      </main>,
    );
    return { ...view, wave, onSelectThread };
  }

  it('draws the waveform through the audio element, with facts and the moments list', async () => {
    const { wave, container, onSelectThread, unmount } = renderAudio();
    await waitFor(() => expect(wave.factory).toHaveBeenCalledTimes(1));
    const call = wave.factory.mock.calls[0]?.[0];
    expect(call?.url).toBe(SRC);
    expect(call?.media).toBe(container.querySelector('audio'));
    expect(container.querySelector('audio')).toHaveAttribute('crossorigin', 'use-credentials');
    expect(screen.getByText('MP3 · 44.1 kHz · stereo · 1:30')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'atlas-radio-spot-30s.mp3' })).toBeInTheDocument();

    const list = screen.getByRole('region', { name: 'On the timeline' });
    const rows = within(list).getAllByRole('button');
    expect(rows.map((row) => within(row).getByText(/^\d+:\d\d$/).textContent)).toEqual([
      '0:08',
      '0:21',
      '0:42',
      '1:12',
    ]);
    expect(rows[1]).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(rows[2] as HTMLElement);
    expect(onSelectThread).toHaveBeenCalledWith('t3');
    // Frame step is a video control only.
    expect(screen.queryByRole('button', { name: 'Next frame' })).toBeNull();
    await expectNoAxeViolations(container);
    unmount();
    expect(wave.destroy).toHaveBeenCalled();
  });

  it('a file over 30 minutes gets the plain timeline, no waveform', () => {
    const { wave } = renderAudio({ durationMs: 45 * 60 * 1000 });
    expect(wave.factory).not.toHaveBeenCalled();
    expect(screen.getByRole('slider', { name: 'Timeline' })).toBeInTheDocument();
  });

  it('a waveform that cannot be made falls back to the timeline', async () => {
    const factory = vi.fn<WaveformFactory>(() => Promise.reject(new Error('decode')));
    renderAudio({ waveformFactory: factory });
    expect(await screen.findByRole('slider', { name: 'Timeline' })).toBeInTheDocument();
  });

  it('an AC-3 track shows the sound codec notice', () => {
    renderAudio({
      mimeType: 'audio/mp4',
      media: { ...H264, hasVideo: false, audioCodec: 'AC-3', codecNotice: 'audio_codec' },
      onDownload: vi.fn(),
    });
    expect(
      screen.getByRole('heading', { name: "Your browser can't play this sound file" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/It uses Dolby Digital \(AC-3\)\./)).toBeInTheDocument();
  });
});
