'use client';

import type { AiAvailability } from '../../lib/api/members';
import { useTOr } from '../../lib/i18n/use-t-or';
import { AiAvatar, AiBadge, aiInitialsOf } from '../ai-employees/AiBadge';
import type { OwnerCandidate } from './OwnerPickerDialog';
import { InfoIcon } from './work-icons';
import './ai-people.css';

/**
 * 60-08 (plan 60 v2 S7, Figma `AI-S7a` / `AI-S7b`) — the AI parts of the Work people pickers:
 * the group headings, an AI employee's row and the supervisor note. A row that cannot be chosen
 * now keeps only its avatar and name dimmed; the reason stays in the full muted colour (Fable
 * must-fix 19, 6.5:1). The row stays focusable (`aria-disabled`) so a keyboard user hears why.
 */

type TOr = ReturnType<typeof useTOr>;

/** The reason an AI employee cannot be chosen, as the row says it; `null` when he can be. */
export function aiReason(availability: AiAvailability, tOr: TOr): string | null {
  switch (availability) {
    case 'paused':
      return tOr('AiPickers.paused', 'Paused');
    case 'not_connected':
      return tOr('AiPickers.notConnected', 'Not connected');
    case 'switched_off':
      return tOr('AiPickers.switchedOff', 'Switched off');
    default:
      return null;
  }
}

/** A group's visible heading inside a picker list ("People", "AI employees"). */
export function PickerGroupHeading({ id, children }: { id: string; children: string }) {
  return (
    <p id={id} className="tm-ai-pick__heading">
      {children}
    </p>
  );
}

/**
 * One AI employee in a Doers picker: the square AI avatar, the name with the AI mark, the job line
 * when he can be chosen, or the reason at the end side when he cannot. A ticked row can always be
 * unticked, whatever his state now.
 */
export function AiCandidateRow({
  candidate,
  ticked,
  onToggle,
}: {
  readonly candidate: OwnerCandidate;
  readonly ticked: boolean;
  readonly onToggle: (userId: string) => void;
}) {
  const tOr = useTOr();
  const reason = candidate.ai === undefined ? null : aiReason(candidate.ai.availability, tOr);
  const unavailable = reason !== null && !ticked;
  return (
    <button
      type="button"
      className="tm-wk-person tm-ai-pick__row"
      role="checkbox"
      aria-checked={ticked}
      aria-disabled={unavailable || undefined}
      data-unavailable={unavailable || undefined}
      data-testid="ai-candidate"
      onClick={() => {
        if (!unavailable) onToggle(candidate.userId);
      }}
    >
      <span className="tm-ai-pick__dim">
        <AiAvatar initials={aiInitialsOf(candidate.displayName)} size={40} />
      </span>
      <span className="tm-wk-person__text">
        <span className="tm-ai-pick__name">
          <bdi className="tm-wk-person__name tm-ai-pick__dim">{candidate.displayName}</bdi>
          <AiBadge />
        </span>
        {reason === null && candidate.subtitle ? (
          <span className="tm-wk-person__role">{candidate.subtitle}</span>
        ) : null}
      </span>
      {reason !== null ? <span className="tm-ai-pick__reason">{reason}</span> : null}
      {ticked ? (
        <span className="tm-wk-person__tick" aria-hidden="true">
          ✓
        </span>
      ) : null}
    </button>
  );
}

/** The quiet line with an info mark: "AI employees can't supervise." / "you supervise his work". */
export function AiPeopleNote({
  children,
  testId,
  flush = false,
}: {
  children: string;
  testId?: string;
  /** In the properties panel: start at the label column, not indented like a list row. */
  flush?: boolean;
}) {
  return (
    <p className="tm-ai-pick__note" data-testid={testId} data-flush={flush || undefined}>
      <span className="tm-ai-pick__note-mark" aria-hidden="true">
        <InfoIcon />
      </span>
      <span>{children}</span>
    </p>
  );
}
