'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Button } from '@tmanage/ui';
import { canSpeak } from '../../lib/voice/speech';
import { useAiText } from './use-ai-text';

/**
 * TManage AI voice mode (plan 62-16, Figma G3 766:43968 and 789:50684): reading an answer aloud
 * with the browser's own `speechSynthesis` (nothing leaves the page, no paid service). One answer
 * reads at a time; the panel owns the reader so every answer's button knows which one speaks.
 *
 * Speaking never acts: dictation only fills the composer, which is sent by hand, and a change
 * card is confirmed by its button only, never by voice (the card's confirm is a sensitive action).
 */

export interface AnswerReader {
  /** False until mounted, and for good where the browser cannot speak. */
  readonly able: boolean;
  readonly readingId: string | null;
  read(id: string, text: string, lang: string): void;
  stop(): void;
}

const ReaderContext = createContext<AnswerReader | null>(null);
export const AnswerReaderProvider = ReaderContext.Provider;

export function useAnswerReader(): AnswerReader {
  const [able, setAble] = useState(false);
  const [readingId, setReadingId] = useState<string | null>(null);
  useEffect(() => setAble(canSpeak()), []);
  useEffect(
    () => () => {
      if (canSpeak()) window.speechSynthesis.cancel();
    },
    [],
  );
  const stop = useCallback(() => {
    if (canSpeak()) window.speechSynthesis.cancel();
    setReadingId(null);
  }, []);
  const read = useCallback((id: string, text: string, lang: string) => {
    if (!canSpeak()) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    const done = () => setReadingId((current) => (current === id ? null : current));
    utterance.onend = done;
    utterance.onerror = done;
    setReadingId(id);
    window.speechSynthesis.speak(utterance);
  }, []);
  return useMemo(() => ({ able, readingId, read, stop }), [able, readingId, read, stop]);
}

function SpeakerIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M2 6h2.5L8 3v10L4.5 10H2z" fill="currentColor" />
      <path
        d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6.5 6.5 0 0 1 0 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The speaker on an answer's receipt line (789:50684). Not drawn where the browser cannot speak. */
export function ReadAloudIcon({ id, text }: { readonly id: string; readonly text: string }) {
  const reader = useContext(ReaderContext);
  const { t, locale } = useAiText();
  if (!reader?.able || text.trim() === '') return null;
  const reading = reader.readingId === id;
  return (
    <button
      type="button"
      className="tm-aic__icon tm-aic-speaker"
      aria-label={t(reading ? 'AiChat.voice.stopReading' : 'AiChat.voice.readAloud')}
      aria-pressed={reading}
      onClick={() => (reading ? reader.stop() : reader.read(id, text, locale))}
    >
      <SpeakerIcon />
    </button>
  );
}

/** "Reading the answer aloud · Stop" under the answer while it speaks (766:43968 frame 4). */
export function ReadingBar({ id }: { readonly id: string }) {
  const reader = useContext(ReaderContext);
  const { t } = useAiText();
  if (reader?.readingId !== id) return null;
  return (
    <div className="tm-aic-speaking" role="status">
      <SpeakerIcon />
      <span className="tm-aic-speaking__text">{t('AiChat.voice.reading')}</span>
      <Button tone="outline" size="compact" className="tm-aic-touch" onClick={reader.stop}>
        {t('AiChat.voice.stop')}
      </Button>
    </div>
  );
}

/** The answer as plain words for speech: links read as their text. */
export function spokenText(parts: readonly { readonly text: string }[]): string {
  return parts
    .map((part) => part.text)
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
}
