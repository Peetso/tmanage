import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDictation } from '../src/components/voice/useDictation';
import { MicButton, MicNotice, ReadAloudButton } from '../src/components/voice/VoiceControls';
import {
  appendDictation,
  dictationProblem,
  readAloudPreference,
  saveReadAloudPreference,
  transcriptFrom,
  type RecognitionResultEventLike,
  type SpeechRecognitionLike,
} from '../src/lib/voice/speech';

/**
 * Microphone and read-aloud (NEXT-CHAT-TASKS 1c, Figma "Extras · Microphone (A)"). The browser's
 * speech engines are faked; what is proved is what TManage does with them.
 */

// Labels resolve from the catalog once the wave's keys are merged; before that `t` returns the key.
const TALK = /Talk instead of typing|Voice\.talkLabel/;
const STOP = /Stop listening|Voice\.stopLabel/;

function results(...items: Array<[string, boolean]>): RecognitionResultEventLike {
  const list = items.map(([transcript, isFinal]) => ({ isFinal, length: 1, 0: { transcript } }));
  return { results: Object.assign(list, { length: list.length }) };
}

class FakeRecognition implements SpeechRecognitionLike {
  static last: FakeRecognition | null = null;
  lang = '';
  continuous = false;
  interimResults = false;
  onresult: SpeechRecognitionLike['onresult'] = null;
  onerror: SpeechRecognitionLike['onerror'] = null;
  onend: SpeechRecognitionLike['onend'] = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  constructor() {
    FakeRecognition.last = this;
  }
}

function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  const dictation = useDictation({ value, onChange: setValue, lang: 'ar-EG' });
  return (
    <>
      <input aria-label="box" value={value} readOnly />
      <MicButton dictation={dictation} />
      <MicNotice dictation={dictation} />
    </>
  );
}

afterEach(() => {
  delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  FakeRecognition.last = null;
  vi.unstubAllGlobals();
});

describe('speech helpers', () => {
  it('splits settled words from words still being guessed', () => {
    expect(transcriptFrom(results([' what is ', true], ['waiting', false]))).toEqual({
      final: 'what is',
      interim: 'waiting',
    });
  });

  it('adds dictated words after typed text with one space', () => {
    expect(appendDictation('Draft', 'the update')).toBe('Draft the update');
    expect(appendDictation('Draft ', 'the update')).toBe('Draft the update');
    expect(appendDictation('', '  hello ')).toBe('hello');
    expect(appendDictation('kept', '   ')).toBe('kept');
  });

  it('treats a refused permission as blocked and silence as no problem', () => {
    expect(dictationProblem('not-allowed')).toBe('blocked');
    expect(dictationProblem('service-not-allowed')).toBe('blocked');
    expect(dictationProblem('audio-capture')).toBe('no-microphone');
    expect(dictationProblem('no-speech')).toBe('none');
    expect(dictationProblem('network')).toBe('failed');
  });

  it('remembers the read-aloud switch and survives storage that refuses', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    saveReadAloudPreference(true, storage);
    expect(readAloudPreference(storage)).toBe(true);
    const refusing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => saveReadAloudPreference(true, refusing)).not.toThrow();
    expect(readAloudPreference(refusing)).toBe(false);
  });
});

describe('microphone button', () => {
  it('is not drawn where the browser has no speech recognition', () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: TALK })).toBeNull();
  });

  it('writes live words into the box, then settles them after Stop', () => {
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition;
    render(<Harness initial="Note:" />);

    fireEvent.click(screen.getByRole('button', { name: TALK }));
    const session = FakeRecognition.last!;
    expect(session.start).toHaveBeenCalled();
    expect(session.lang).toBe('ar-EG');
    expect(screen.getByRole('button', { name: STOP })).toBeInTheDocument();

    act(() => session.onresult?.(results(['what is', true], ['waiting', false])));
    expect(screen.getByRole('textbox', { name: 'box' })).toHaveValue('Note: what is waiting');

    fireEvent.click(screen.getByRole('button', { name: STOP }));
    expect(session.stop).toHaveBeenCalled();
    expect(document.querySelector('[data-state="processing"]')).not.toBeNull();

    act(() => session.onend?.());
    expect(screen.getByRole('textbox', { name: 'box' })).toHaveValue('Note: what is');
    expect(screen.getByRole('button', { name: TALK })).toBeInTheDocument();
  });

  it('shows the blocked warning when the browser refuses the microphone', () => {
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition;
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: TALK }));
    const session = FakeRecognition.last!;
    act(() => {
      session.onerror?.({ error: 'not-allowed' });
      session.onend?.();
    });
    expect(screen.getByRole('status')).toHaveTextContent(/Microphone blocked|Voice\.blockedTitle/);
  });
});

describe('read aloud', () => {
  it('speaks the answer in the display language and stops on a second press', () => {
    const speak = vi.fn();
    const cancel = vi.fn();
    vi.stubGlobal('speechSynthesis', { speak, cancel });
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        lang = '';
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(public text: string) {}
      },
    );
    render(<ReadAloudButton text="One honest update." />);
    fireEvent.click(
      screen.getByRole('button', { name: /Read this answer aloud|Voice\.readAloudLabel/ }),
    );
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0]![0]).toMatchObject({ text: 'One honest update.', lang: 'en-US' });

    cancel.mockClear();
    fireEvent.click(
      screen.getByRole('button', { name: /Stop reading aloud|Voice\.stopReadingLabel/ }),
    );
    expect(cancel).toHaveBeenCalled();
  });

  it('reads a new answer by itself when the switch is on', () => {
    const speak = vi.fn();
    vi.stubGlobal('speechSynthesis', { speak, cancel: vi.fn() });
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        constructor(public text: string) {}
      },
    );
    render(<ReadAloudButton text="Auto." autoRead />);
    expect(speak).toHaveBeenCalledTimes(1);
  });
});
