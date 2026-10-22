'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import {
  appendDictation,
  dictationProblem,
  recognitionConstructor,
  transcriptFrom,
  type SpeechRecognitionLike,
} from '../../lib/voice/speech';

/** idle → listening (live words) → processing (settling the last words) → idle. */
export type DictationStatus =
  'idle' | 'listening' | 'processing' | 'blocked' | 'no-microphone' | 'failed';

export interface Dictation {
  /** False until mounted, and for good where the browser has no speech recognition. */
  readonly supported: boolean;
  readonly status: DictationStatus;
  start(): void;
  stop(): void;
  toggle(): void;
}

export interface UseDictationOptions {
  /** The text box's current text; dictated words are added after it. */
  value: string;
  onChange: (next: string) => void;
  /** BCP-47 language to listen for. Defaults to the person's display language. */
  lang?: string;
}

/**
 * Browser speech-to-text into one text box. Live words are written into the box as they are
 * heard (so the person sees them appear, as the Figma "Listening" frame shows) and settle when
 * the browser marks them final. Nothing is sent anywhere: the box is still submitted by hand.
 */
export function useDictation({ value, onChange, lang }: UseDictationOptions): Dictation {
  const locale = useActiveLocale();
  const [supported, setSupported] = useState(false);
  const [status, setStatus] = useState<DictationStatus>('idle');
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };

  // Decided after mount so the server render and the first client render agree.
  useEffect(() => {
    setSupported(recognitionConstructor() !== null);
  }, []);

  useEffect(
    () => () => {
      const active = recognition.current;
      recognition.current = null;
      if (active) {
        active.onend = null;
        active.abort();
      }
    },
    [],
  );

  const start = useCallback(() => {
    const Recognition = recognitionConstructor();
    if (!Recognition || recognition.current) return;
    const typed = latest.current.value;
    let settled = '';
    let problem: DictationStatus | null = null;
    const session = new Recognition();
    session.lang = lang ?? locale;
    session.continuous = true;
    session.interimResults = true;
    session.onresult = (event) => {
      const heard = transcriptFrom(event);
      settled = heard.final;
      latest.current.onChange(appendDictation(typed, `${heard.final} ${heard.interim}`));
    };
    session.onerror = (event) => {
      const kind = dictationProblem(event.error);
      if (kind !== 'none') problem = kind;
    };
    session.onend = () => {
      if (recognition.current === session) recognition.current = null;
      latest.current.onChange(appendDictation(typed, settled));
      setStatus(problem ?? 'idle');
    };
    recognition.current = session;
    try {
      session.start();
      setStatus('listening');
    } catch {
      recognition.current = null;
      setStatus('failed');
    }
  }, [lang, locale]);

  const stop = useCallback(() => {
    const active = recognition.current;
    if (!active) return;
    setStatus('processing');
    active.stop();
  }, []);

  const toggle = useCallback(() => {
    if (recognition.current) stop();
    else start();
  }, [start, stop]);

  return { supported, status, start, stop, toggle };
}
