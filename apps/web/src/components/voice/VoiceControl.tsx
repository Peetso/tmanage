'use client';

import { DictationLanguagePicker } from '../ai-chat/DictationLanguagePicker';
import { MicIcon } from '../ai-chat/icons';
import '../ai-chat/ai-chat.css';
import { MicButton } from './VoiceControls';
import type { VoiceInput } from './use-voice-language';
import './voice-control.css';

/**
 * Figma `Control/Voice` (set `929:977`, LTR `929:955`, RTL `929:966`): a 28 px microphone button
 * and a 28 px language chip, beside every name or text the member can dictate (a work's title,
 * a step, a comment, a team or stage name). The chip is the AI chat's dictation language menu
 * (`DictationLanguagePicker`), so one choice of language serves every box (WORK-AREA plan
 * W-WEB-3). Where dictation cannot run the mic is drawn off and the chip says why.
 */
export function VoiceControl({
  input,
  placement = 'below',
}: {
  input: VoiceInput;
  /** Where the language menu opens; `above` for a box at the foot of the screen. */
  placement?: 'above' | 'below';
}) {
  const { dictation, language, block } = input;
  const listening = dictation.status === 'listening' || dictation.status === 'processing';
  return (
    <span className="tm-voice">
      {dictation.supported ? (
        <MicButton dictation={dictation} compact />
      ) : block !== null ? (
        <span className="tm-voice__mic-off" aria-hidden="true">
          <MicIcon />
        </span>
      ) : null}
      <DictationLanguagePicker
        value={language.tag}
        appTag={language.appTag}
        onChange={language.choose}
        blocked={block}
        locked={listening}
        placement={placement}
      />
    </span>
  );
}
