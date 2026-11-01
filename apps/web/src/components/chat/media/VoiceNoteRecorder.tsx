'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { ApiClient } from '../../../lib/api/client';
import { browserApiClient } from '../../../lib/api/browser-client';
import { postMessage } from '../../../lib/api/conversations';
import type { MessageSummary } from '../../../lib/api/conversations';
import { attachMessageFile } from '../../../lib/api/message-attachments';
import { uploadProjectFile } from '../../../lib/api/uploads';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { formatVoiceClock } from './VoiceNoteBubble';
import './media.css';

/** The longest note one recording keeps; the recorder stops itself here. */
export const VOICE_NOTE_MAX_MS = 5 * 60 * 1000;
/** How many bars the waveform stores (the API admits up to 256). */
export const VOICE_PEAK_BUCKETS = 64;

/**
 * Container types in preference order. The upload verifier (F5) admits MP4 audio and Ogg, not
 * WebM, so those come first: Chrome and Safari record `audio/mp4`, Firefox `audio/ogg`. WebM is the
 * last resort and is refused before upload with a plain message.
 */
const RECORDING_TYPES: readonly {
  readonly mime: string;
  readonly type: string;
  readonly ext: string;
}[] = [
  { mime: 'audio/mp4;codecs=mp4a.40.2', type: 'audio/mp4', ext: 'm4a' },
  { mime: 'audio/mp4', type: 'audio/mp4', ext: 'm4a' },
  { mime: 'audio/ogg;codecs=opus', type: 'audio/ogg', ext: 'ogg' },
  { mime: 'audio/webm;codecs=opus', type: 'audio/webm', ext: 'webm' },
];

function pickRecordingType(): (typeof RECORDING_TYPES)[number] | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return RECORDING_TYPES.find((entry) => MediaRecorder.isTypeSupported(entry.mime)) ?? null;
}

/** 64 peak heights in 0..1, from the recording itself (no server work, no decode before play). */
export async function computePeaks(blob: Blob, buckets = VOICE_PEAK_BUCKETS): Promise<number[]> {
  const AudioContextType =
    globalThis.AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (AudioContextType === undefined) return new Array<number>(buckets).fill(0.2);
  const context = new AudioContextType();
  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer());
    const samples = audio.getChannelData(0);
    const size = Math.max(1, Math.floor(samples.length / buckets));
    const peaks: number[] = [];
    for (let bucket = 0; bucket < buckets; bucket += 1) {
      let peak = 0;
      for (let i = bucket * size; i < Math.min(samples.length, (bucket + 1) * size); i += 1) {
        peak = Math.max(peak, Math.abs(samples[i] ?? 0));
      }
      peaks.push(peak);
    }
    const loudest = Math.max(...peaks, 0.0001);
    return peaks.map((peak) => Math.round((peak / loudest) * 1000) / 1000);
  } finally {
    void context.close();
  }
}

type Phase = 'idle' | 'holding' | 'locked' | 'sending';

export interface VoiceNoteRecorderProps {
  readonly organizationSlug: string;
  readonly conversationId: string;
  /**
   * The project the note's file is stored under (the upload session needs one). `null` for a
   * conversation without a project: the mic is shown disabled with the reason.
   */
  readonly projectId: string | null;
  readonly client?: ApiClient;
  readonly onSent?: (message: MessageSummary) => void;
  readonly onError?: (message: string) => void;
}

/** How far a held press slides before it locks (up) or cancels (towards the start edge). */
const LOCK_DISTANCE = 60;
const CANCEL_DISTANCE = 80;

/**
 * **R7 voice note recorder** (Figma "Chat (R7)" › Recording). Hold the mic to record and release
 * to send; slide up to lock (then Send / Delete), slide towards the start edge to cancel. A tap
 * starts a locked recording. The note goes through the ordinary upload session (so the virus scan
 * runs), then posts a `voice` message with its duration and peaks, then links the file.
 */
export function VoiceNoteRecorder({
  organizationSlug,
  conversationId,
  projectId,
  client,
  onSent,
  onError,
}: VoiceNoteRecorderProps) {
  const tOr = useTOr();
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [cancelHint, setCancelHint] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const discard = useRef(false);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fail = useCallback(
    (message: string) => {
      setPhase('idle');
      onError?.(message);
    },
    [onError],
  );

  useEffect(() => {
    if (phase !== 'holding' && phase !== 'locked') return undefined;
    const tick = setInterval(() => setElapsedMs(Date.now() - startedAt.current), 250);
    return () => clearInterval(tick);
  }, [phase]);

  useEffect(
    () => () => {
      if (stopTimer.current !== null) clearTimeout(stopTimer.current);
      recorder.current?.stream.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  const send = useCallback(
    async (blob: Blob, type: string, ext: string, durationMs: number) => {
      if (projectId === null) return;
      setPhase('sending');
      const api = client ?? browserApiClient();
      try {
        const peaks = await computePeaks(blob).catch(() =>
          new Array<number>(VOICE_PEAK_BUCKETS).fill(0.2),
        );
        const name = `voice-note-${new Date().toISOString().replace(/[:.]/gu, '-')}.${ext}`;
        const file = Object.assign(new Blob([blob], { type }), { name });
        const fileId = await uploadProjectFile(api, organizationSlug, { projectId, file });
        const message = await postMessage(api, organizationSlug, conversationId, {
          body: tOr('ChatVoice.messageBody', 'Voice note'),
          kind: 'voice',
          meta: { durationMs: Math.max(1, Math.round(durationMs)), peaks },
          clientGeneratedId: crypto.randomUUID(),
        });
        await attachMessageFile(api, organizationSlug, conversationId, message.id, fileId);
        setPhase('idle');
        onSent?.(message);
      } catch {
        fail(tOr('ChatVoice.sendFailed', 'The voice note could not be sent. Try again.'));
      }
    },
    [client, conversationId, fail, onSent, organizationSlug, projectId, tOr],
  );

  const stop = useCallback((keep: boolean) => {
    discard.current = !keep;
    if (stopTimer.current !== null) clearTimeout(stopTimer.current);
    const active = recorder.current;
    if (active !== null && active.state !== 'inactive') active.stop();
    else setPhase('idle');
  }, []);

  const start = useCallback(async () => {
    const choice = pickRecordingType();
    if (choice === null || typeof navigator === 'undefined' || !navigator.mediaDevices) {
      fail(tOr('ChatVoice.unsupported', 'This browser cannot record voice notes.'));
      return false;
    }
    if (choice.type === 'audio/webm') {
      fail(
        tOr(
          'ChatVoice.unsupportedFormat',
          'This browser records a format TManage does not accept yet.',
        ),
      );
      return false;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      fail(tOr('ChatVoice.micDenied', 'Allow the microphone to record a voice note.'));
      return false;
    }
    const media = new MediaRecorder(stream, { mimeType: choice.mime });
    chunks.current = [];
    discard.current = false;
    media.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.current.push(event.data);
    };
    media.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      recorder.current = null;
      const durationMs = Date.now() - startedAt.current;
      if (discard.current || chunks.current.length === 0) {
        setPhase('idle');
        return;
      }
      void send(
        new Blob(chunks.current, { type: choice.type }),
        choice.type,
        choice.ext,
        durationMs,
      );
    };
    recorder.current = media;
    startedAt.current = Date.now();
    setElapsedMs(0);
    media.start(1000);
    stopTimer.current = setTimeout(() => stop(true), VOICE_NOTE_MAX_MS);
    return true;
  }, [fail, send, stop, tOr]);

  const onPointerDown = async (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (phase !== 'idle' || projectId === null) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    origin.current = { x: event.clientX, y: event.clientY };
    setCancelHint(false);
    setPhase('holding');
    if (!(await start())) origin.current = null;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (phase !== 'holding' || origin.current === null) return;
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const towardsStart = (rtl ? 1 : -1) * (event.clientX - origin.current.x);
    if (origin.current.y - event.clientY > LOCK_DISTANCE) {
      origin.current = null;
      setPhase('locked');
    } else if (towardsStart > CANCEL_DISTANCE) {
      origin.current = null;
      stop(false);
    } else {
      setCancelHint(towardsStart > CANCEL_DISTANCE / 2);
    }
  };

  const onPointerUp = () => {
    if (phase !== 'holding' || origin.current === null) return;
    origin.current = null;
    // A tap (under half a second), or a release while the browser still asks for the microphone,
    // keeps recording, locked; a held press sends on release.
    if (recorder.current === null || Date.now() - startedAt.current < 500) setPhase('locked');
    else stop(true);
  };

  const label =
    projectId === null
      ? tOr('ChatVoice.needsProject', 'Voice notes need a project chat for now.')
      : tOr('ChatVoice.hold', 'Hold to record a voice note');
  const recording = phase === 'holding' || phase === 'locked';

  return (
    <div className="r7-voice-recorder" data-phase={phase}>
      {recording ? (
        <div className="r7-voice-recorder__bar" role="status" aria-live="polite">
          <span className="r7-voice-recorder__dot" aria-hidden="true" />
          <span className="r7-voice-recorder__clock">{formatVoiceClock(elapsedMs)}</span>
          {phase === 'holding' ? (
            <span className="r7-voice-recorder__hint" data-cancel={cancelHint || undefined}>
              {tOr('ChatVoice.slideToCancel', '‹ Slide to cancel · slide up to lock')}
            </span>
          ) : (
            <>
              <button
                type="button"
                className="r7-voice-recorder__delete"
                onClick={() => stop(false)}
              >
                {tOr('ChatVoice.delete', 'Delete')}
              </button>
              <button type="button" className="r7-voice-recorder__send" onClick={() => stop(true)}>
                {tOr('ChatVoice.send', 'Send')}
              </button>
            </>
          )}
        </div>
      ) : null}
      {phase === 'sending' ? (
        <span className="r7-voice-recorder__sending" role="status">
          {tOr('ChatVoice.sending', 'Sending voice note…')}
        </span>
      ) : null}
      {phase !== 'locked' ? (
        <button
          type="button"
          className="r7-voice-recorder__mic"
          aria-label={label}
          title={label}
          aria-pressed={phase === 'holding'}
          disabled={projectId === null || phase === 'sending'}
          onPointerDown={(event) => void onPointerDown(event)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => phase === 'holding' && stop(false)}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"
              fill="currentColor"
            />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
