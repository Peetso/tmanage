/**
 * Voice for the AI assistant and the everyday text boxes (NEXT-CHAT-TASKS 1c, Figma "Extras ·
 * Microphone (A)").
 *
 * Free and in-browser only: speech-to-text is the browser's own Web Speech API
 * (`SpeechRecognition`, prefixed `webkitSpeechRecognition` in Chromium and Safari) and reading
 * aloud is `speechSynthesis`. No audio leaves the page through TManage and no paid service is
 * called. Where the browser has neither, the controls are not drawn at all.
 *
 * Everything here is pure or takes the window as an argument, so the rules can be proved without
 * a microphone.
 */

/** The slice of a `SpeechRecognitionAlternative` this module reads. */
interface AlternativeLike {
  readonly transcript: string;
}

/** The slice of a `SpeechRecognitionResult` this module reads. */
export interface RecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: AlternativeLike | undefined;
}

/** The slice of a `SpeechRecognitionEvent` this module reads. */
export interface RecognitionResultEventLike {
  readonly results: {
    readonly length: number;
    readonly [index: number]: RecognitionResultLike | undefined;
  };
}

/** The slice of a `SpeechRecognitionErrorEvent` this module reads. */
export interface RecognitionErrorEventLike {
  readonly error: string;
}

/** The slice of a `SpeechRecognition` instance the dictation hook drives. */
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionResultEventLike) => void) | null;
  onerror: ((event: RecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type RecognitionConstructor = new () => SpeechRecognitionLike;

type VoiceWindow = {
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
  speechSynthesis?: unknown;
  SpeechSynthesisUtterance?: unknown;
};

function currentWindow(): VoiceWindow | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as VoiceWindow);
}

/** The browser's speech recognition constructor, or `null` where it has none. */
export function recognitionConstructor(
  win: VoiceWindow | undefined = currentWindow(),
): RecognitionConstructor | null {
  const ctor = win?.SpeechRecognition ?? win?.webkitSpeechRecognition;
  return typeof ctor === 'function' ? (ctor as RecognitionConstructor) : null;
}

/** Whether this browser can read text aloud. */
export function canSpeak(win: VoiceWindow | undefined = currentWindow()): boolean {
  return (
    typeof win?.SpeechSynthesisUtterance === 'function' &&
    typeof win.speechSynthesis === 'object' &&
    win.speechSynthesis !== null
  );
}

/**
 * The words heard so far, split into what the browser has settled (`final`) and what it is still
 * guessing (`interim`). Continuous recognition replays every result of the session on each event,
 * so the whole list is read each time rather than appended to.
 */
export function transcriptFrom(event: RecognitionResultEventLike): {
  final: string;
  interim: string;
} {
  const finals: string[] = [];
  const interims: string[] = [];
  for (let index = 0; index < event.results.length; index += 1) {
    const result = event.results[index];
    const words = result?.[0]?.transcript.trim() ?? '';
    if (!result || words === '') continue;
    (result.isFinal ? finals : interims).push(words);
  }
  return { final: finals.join(' '), interim: interims.join(' ') };
}

/** Put dictated words after what was already typed, with exactly one space between. */
export function appendDictation(typed: string, spoken: string): string {
  const words = spoken.trim();
  if (words === '') return typed;
  if (typed.trim() === '') return words;
  return /\s$/.test(typed) ? `${typed}${words}` : `${typed} ${words}`;
}

export type DictationProblem = 'blocked' | 'no-microphone' | 'failed' | 'none';

/**
 * What a recognition error means to the person. A refused permission is "blocked" (the browser
 * or the device setting said no); silence and a deliberate stop are not problems at all.
 */
export function dictationProblem(code: string): DictationProblem {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'blocked';
    case 'audio-capture':
      return 'no-microphone';
    case 'no-speech':
    case 'aborted':
      return 'none';
    default:
      return 'failed';
  }
}

const READ_ALOUD_KEY = 'tm.voice.readAnswersAloud';

/** The "Read answers aloud" switch, remembered per browser. Storage can be absent or refuse. */
export function readAloudPreference(storage?: Pick<Storage, 'getItem'>): boolean {
  try {
    return (storage ?? window.localStorage).getItem(READ_ALOUD_KEY) === 'on';
  } catch {
    return false;
  }
}

export function saveReadAloudPreference(on: boolean, storage?: Pick<Storage, 'setItem'>): void {
  try {
    (storage ?? window.localStorage).setItem(READ_ALOUD_KEY, on ? 'on' : 'off');
  } catch {
    // A private window or blocked storage: the switch still works for this visit.
  }
}
