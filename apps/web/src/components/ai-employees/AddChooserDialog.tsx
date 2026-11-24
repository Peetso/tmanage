'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@tmanage/ui';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { withNumerals } from '../../lib/i18n/display-format';
import { fill } from '../people/ChangeRoleDialog';
import { AiAvatar } from './AiBadge';
import { AiDialogFrame, AiDialogHead } from './AiDialog';
import { AtIcon } from './ai-icons';
import { CheckIcon } from '../work/work-icons';

export type AddChoice = 'person' | 'ai';

/**
 * S2 "Add to your team" (Figma `949:2775`): two cards, Invite a person or Hire an AI employee,
 * then Continue. S2b: when the AI card cannot be used (the workspace is at its beta cap, the
 * workspace has AI switched off, or the reader may not hire) it is dimmed with the reason in the
 * muted colour, and Invite is chosen. A card the reader may not use is never the default.
 */
export function AddChooserDialog({
  mayInvite,
  aiBlockedReason,
  live,
  limit,
  onChoose,
  onClose,
}: {
  readonly mayInvite: boolean;
  /** Why the AI card is off, or null when it can be chosen. */
  readonly aiBlockedReason: string | null;
  readonly live: number;
  readonly limit: number;
  readonly onChoose: (choice: AddChoice) => void;
  readonly onClose: () => void;
}) {
  const tOr = useTOr();
  const locale = useActiveLocale();
  const titleId = useId();
  const groupName = useId();
  const aiOpen = aiBlockedReason === null;
  // The AI card is the default whenever it can be chosen (design S2). The roster's AI list may
  // still be loading when the dialog opens, so the default is worked out on every render until
  // the user picks a card, and a pick of a card that has since closed falls back the same way.
  const [picked, setChoice] = useState<AddChoice | null>(null);
  const fallback: AddChoice | null = aiOpen ? 'ai' : mayInvite ? 'person' : null;
  const choice = picked === 'ai' && !aiOpen ? fallback : (picked ?? fallback);
  // When the default moves to the AI card after the list loads, focus follows it, so the focus
  // ring and the tick are on the same card.
  const cards = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    if (picked !== null) return;
    const checked = cards.current?.querySelector<HTMLInputElement>('input:checked');
    if (checked && cards.current?.contains(document.activeElement)) checked.focus();
  }, [choice, picked]);
  const number = (value: number) => value.toLocaleString(withNumerals(locale));
  const used = fill(tOr('AiPeople.usedInBeta', '{live} of {limit} used in the beta'), {
    live: number(live),
    limit: number(limit),
  });

  return (
    <AiDialogFrame labelledBy={titleId} onClose={onClose}>
      <form
        noValidate
        className="tm-team-dialog__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (choice) onChoose(choice);
        }}
      >
        <AiDialogHead
          id={titleId}
          title={tOr('AiPeople.addTitle', 'Add to your team')}
          onClose={onClose}
        />
        <fieldset ref={cards} className="tm-aie-cards">
          <legend className="tm-visually-hidden">
            {tOr('AiPeople.addTitle', 'Add to your team')}
          </legend>
          <label className="tm-aie-card" data-disabled={!mayInvite || undefined}>
            <input
              type="radio"
              name={groupName}
              className="tm-visually-hidden"
              checked={choice === 'person'}
              disabled={!mayInvite}
              onChange={() => setChoice('person')}
              data-autofocus={choice === 'person' || undefined}
            />
            <span className="tm-aie-card__top">
              <span className="tm-aie-card__icon" aria-hidden="true">
                <AtIcon />
              </span>
              {choice === 'person' ? (
                <span className="tm-aie-card__tick" aria-hidden="true">
                  <CheckIcon />
                </span>
              ) : null}
            </span>
            <span className="tm-aie-card__title">
              {tOr('AiPeople.invitePerson', 'Invite a person')}
            </span>
            <span className="tm-aie-card__body">
              {mayInvite
                ? tOr('AiPeople.invitePersonBody', 'They join with their own email.')
                : tOr('AiPeople.inviteNotAllowed', 'Only owners and admins invite people.')}
            </span>
          </label>
          <label className="tm-aie-card" data-disabled={!aiOpen || undefined}>
            <input
              type="radio"
              name={groupName}
              className="tm-visually-hidden"
              checked={choice === 'ai'}
              disabled={!aiOpen}
              onChange={() => setChoice('ai')}
              data-autofocus={choice === 'ai' || undefined}
            />
            <span className="tm-aie-card__top">
              <AiAvatar initials="AI" size={40} className="tm-aie-dim" />
              {choice === 'ai' ? (
                <span className="tm-aie-card__tick" aria-hidden="true">
                  <CheckIcon />
                </span>
              ) : null}
            </span>
            <span className="tm-aie-card__title tm-aie-dim">
              {tOr('AiPeople.hireAi', 'Hire an AI employee')}
            </span>
            <span className="tm-aie-card__body tm-aie-dim">
              {tOr('AiPeople.hireAiBody', 'Your own AI agent, working like a team member.')}
            </span>
            <span className="tm-aie-card__note">{aiOpen ? used : aiBlockedReason}</span>
          </label>
        </fieldset>
        <div className="tm-team-dialog__actions">
          <Button type="button" tone="text" size="large" onClick={onClose}>
            {tOr('AiEmployees.cancel', 'Cancel')}
          </Button>
          <Button type="submit" tone="lime" size="large" disabled={choice === null}>
            {tOr('AiPeople.continue', 'Continue')}
          </Button>
        </div>
      </form>
    </AiDialogFrame>
  );
}
