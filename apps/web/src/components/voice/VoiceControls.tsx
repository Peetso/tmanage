'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { Announce, Button, InlineAlert, Switch } from '@tmanage/ui';
import { useT } from '../../lib/i18n/use-t';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { canSpeak, readAloudPreference, saveReadAloudPreference } from '../../lib/voice/speech';
import type { Dictation } from './useDictation';
import './voice.css';

/** Pressed for longer than this, the button behaves as push-to-talk: release stops. */
const HOLD_MS = 450;

function MicGlyph() {
  return (
    <svg className="tm-mic__glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" />
    </svg>
  );
}

function SpeakerGlyph() {
  return (
    <svg className="tm-mic__glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2 6h2.5L8 3v10L4.5 10H2z" />
      <path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6.5 6.5 0 0 1 0 9" />
    </svg>
  );
}

/**
 * The microphone button (Figma 343:1119 idle "Talk", 343:1261 listening "Stop" with five sound
 * bars, 343:1408 processing "Working"). Click to start and click to stop, or hold and release.
 * Not drawn at all where the browser has no speech recognition.
 */
export function MicButton({
  dictation,
  compact = false,
}: {
  dictation: Dictation;
  compact?: boolean;
}) {
  const t = useT();
  const pressedAt = useRef<number | null>(null);
  const startedByPress = useRef(false);

  if (!dictation.supported) return null;

  const { status } = dictation;
  const className = ['tm-mic', compact ? 'tm-mic--compact' : null].filter(Boolean).join(' ');

  if (status === 'processing') {
    return (
      <span className={className} data-state="processing">
        <Button
          tone="lime"
          size="compact"
          className="tm-mic__button tm-mic__button--working"
          loading
          loadingLabel={t('Voice.workingLabel')}
        >
          <span className="tm-mic__spinner" aria-hidden="true" />
          {t('Voice.working')}
        </Button>
      </span>
    );
  }

  const listening = status === 'listening';

  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || listening) return;
    pressedAt.current = Date.now();
    startedByPress.current = true;
    dictation.start();
  }

  function onPointerUp() {
    const since = pressedAt.current;
    pressedAt.current = null;
    if (since !== null && Date.now() - since >= HOLD_MS) dictation.stop();
  }

  function onClick() {
    // The press already started listening; the click that follows it must not stop it again.
    if (startedByPress.current) {
      startedByPress.current = false;
      return;
    }
    dictation.toggle();
  }

  return (
    <span className={className} data-state={listening ? 'listening' : 'idle'}>
      {listening ? (
        <span className="tm-mic__bars" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
      ) : null}
      <Button
        tone={listening ? 'lime' : 'text'}
        size="compact"
        className="tm-mic__button"
        aria-label={listening ? t('Voice.stopLabel') : t('Voice.talkLabel')}
        title={listening ? t('Voice.listeningHint') : t('Voice.idleHint')}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onClick={onClick}
      >
        {listening ? <span className="tm-mic__ring" aria-hidden="true" /> : <MicGlyph />}
        <span className={compact ? 'tm-visually-hidden' : undefined}>
          {listening ? t('Voice.stop') : t('Voice.talk')}
        </span>
      </Button>
    </span>
  );
}

/**
 * The line under the box: what the microphone is doing, and the warning when the browser
 * refused it (Figma 344:1425 / 344:1565, the InlineAlert warning).
 */
export function MicNotice({
  dictation,
  showIdleHint = false,
}: {
  dictation: Dictation;
  showIdleHint?: boolean;
}) {
  const t = useT();
  if (!dictation.supported) return null;
  const { status } = dictation;

  if (status === 'blocked') {
    return (
      <InlineAlert tone="warning" title={t('Voice.blockedTitle')} live className="tm-mic-alert">
        {t('Voice.blockedBody')}
      </InlineAlert>
    );
  }
  if (status === 'no-microphone' || status === 'failed') {
    return (
      <InlineAlert tone="warning" title={t('Voice.failedTitle')} live className="tm-mic-alert">
        {status === 'no-microphone' ? t('Voice.noMicBody') : t('Voice.failedBody')}
      </InlineAlert>
    );
  }
  if (status === 'listening') {
    return (
      <p className="tm-mic-hint">
        {t('Voice.listeningHint')}
        <Announce message={t('Voice.listeningHint')} />
      </p>
    );
  }
  if (status === 'processing') return <p className="tm-mic-hint">{t('Voice.processingHint')}</p>;
  return showIdleHint ? <p className="tm-mic-hint">{t('Voice.idleHint')}</p> : null;
}

/** Whether this browser can read aloud, decided after mount so server and client agree. */
export function useCanSpeak(): boolean {
  const [able, setAble] = useState(false);
  useEffect(() => setAble(canSpeak()), []);
  return able;
}

/** The "Read answers aloud" preference, remembered in this browser. */
export function useReadAloudPreference(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);
  useEffect(() => setOn(readAloudPreference()), []);
  const update = useCallback((next: boolean) => {
    setOn(next);
    saveReadAloudPreference(next);
  }, []);
  return [on, update];
}

/**
 * The speaker button on an answer (Figma 346:1156): "Read aloud", and "Reading… stop" while it
 * speaks. With `autoRead`, a new answer starts reading by itself.
 */
export function ReadAloudButton({ text, autoRead = false }: { text: string; autoRead?: boolean }) {
  const t = useT();
  const locale = useActiveLocale();
  const able = useCanSpeak();
  const [reading, setReading] = useState(false);

  const stop = useCallback(() => {
    window.speechSynthesis.cancel();
    setReading(false);
  }, []);

  const read = useCallback(() => {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = locale;
    utterance.onend = () => setReading(false);
    utterance.onerror = () => setReading(false);
    setReading(true);
    window.speechSynthesis.speak(utterance);
  }, [text, locale]);

  useEffect(() => {
    if (able && autoRead && text.trim() !== '') read();
    // Only a new answer (or the switch turning on) starts reading by itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [able, autoRead, text]);

  useEffect(
    () => () => {
      if (canSpeak()) window.speechSynthesis.cancel();
    },
    [],
  );

  if (!able || text.trim() === '') return null;

  return (
    <Button
      tone={reading ? 'lime' : 'outline'}
      size="compact"
      className="tm-mic__button"
      aria-label={reading ? t('Voice.stopReadingLabel') : t('Voice.readAloudLabel')}
      onClick={reading ? stop : read}
    >
      {reading ? <span className="tm-mic__ring" aria-hidden="true" /> : <SpeakerGlyph />}
      {reading ? t('Voice.readingStop') : t('Voice.readAloud')}
    </Button>
  );
}

/** The "Read answers aloud" switch (Figma 346:1156). Not drawn where the browser cannot speak. */
export function ReadAloudSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  const t = useT();
  const able = useCanSpeak();
  if (!able) return null;
  return (
    <Switch
      className="tm-mic-switch"
      label={t('Voice.readAnswersAloud')}
      hint={t('Voice.readAnswersAloudHint')}
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}
