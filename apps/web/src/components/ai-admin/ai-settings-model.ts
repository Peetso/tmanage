import {
  AI_RETENTION_MAX_DAYS,
  AI_RETENTION_MIN_DAYS,
  type AiSettingsPatch,
  type AiSettingsView,
  type AiWriteScope,
} from '../../lib/api/ai-settings';

/**
 * Settings > AI's functional core (IP-3): the owner's unsaved choices, what changed, and the
 * retention check the form shows before the server checks it again (AR-9). Pure.
 */

export interface BlockedDraftEntry {
  readonly membershipId: string;
  readonly displayName: string;
  /** When the server blocked them; null for a member blocked in this draft, not yet saved. */
  readonly blockedAt: string | null;
}

export interface AiSettingsDraft {
  readonly writeScope: AiWriteScope;
  readonly runAtOnce: boolean;
  readonly fileReading: boolean;
  readonly memberSharePercent: number;
  /** As typed, so a half-typed number is kept and checked rather than lost. */
  readonly retention: string;
  readonly blocked: readonly BlockedDraftEntry[];
}

export function draftOf(view: AiSettingsView): AiSettingsDraft {
  return {
    writeScope: view.writeScope,
    runAtOnce: view.runAtOnce,
    fileReading: view.fileReading,
    memberSharePercent: view.memberSharePercent,
    retention: String(view.conversationRetentionDays),
    blocked: view.blockedMembers.map((entry) => ({ ...entry })),
  };
}

/** "Answer questions only" turns quick changes off: the server refuses the pair (400). */
export function withScope(draft: AiSettingsDraft, writeScope: AiWriteScope): AiSettingsDraft {
  return { ...draft, writeScope, runAtOnce: writeScope === 'read' ? false : draft.runAtOnce };
}

/** The typed retention in whole days, or null when it is not a whole number in 1–365. */
export function retentionDays(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d{1,3}$/u.test(text)) return null;
  const days = Number(text);
  return days >= AI_RETENTION_MIN_DAYS && days <= AI_RETENTION_MAX_DAYS ? days : null;
}

/** Only what the owner changed; an empty object means nothing to save. */
export function patchOf(view: AiSettingsView, draft: AiSettingsDraft): AiSettingsPatch {
  const saved = new Set(view.blockedMembers.map((entry) => entry.membershipId));
  const now = new Set(draft.blocked.map((entry) => entry.membershipId));
  const block = [...now].filter((id) => !saved.has(id));
  const allow = [...saved].filter((id) => !now.has(id));
  const days = retentionDays(draft.retention);
  return {
    ...(draft.writeScope !== view.writeScope ? { writeScope: draft.writeScope } : {}),
    ...(draft.runAtOnce !== view.runAtOnce ? { runAtOnce: draft.runAtOnce } : {}),
    ...(draft.fileReading !== view.fileReading ? { fileReading: draft.fileReading } : {}),
    ...(draft.memberSharePercent !== view.memberSharePercent
      ? { memberSharePercent: draft.memberSharePercent }
      : {}),
    ...(days !== null && days !== view.conversationRetentionDays
      ? { conversationRetentionDays: days }
      : {}),
    ...(block.length > 0 ? { blockMembershipIds: block } : {}),
    ...(allow.length > 0 ? { allowMembershipIds: allow } : {}),
  };
}

/** Unsaved when anything differs, a retention typed out of range included. */
export function isDirty(view: AiSettingsView, draft: AiSettingsDraft): boolean {
  return (
    Object.keys(patchOf(view, draft)).length > 0 ||
    draft.retention.trim() !== String(view.conversationRetentionDays)
  );
}

/** The share Select's options: the server's choices, plus a saved share that is not one of them. */
export function shareOptions(view: AiSettingsView): readonly number[] {
  const choices = view.credits.shareChoices.map((choice) => choice.percent);
  return choices.includes(view.memberSharePercent)
    ? choices
    : [...choices, view.memberSharePercent].sort((a, b) => a - b);
}

/** What one member could use at `percent`: the server's figure, or the same rounding for others. */
export function memberCreditsAt(view: AiSettingsView, percent: number): number {
  const choice = view.credits.shareChoices.find((entry) => entry.percent === percent);
  if (choice) return choice.memberCredits;
  if (percent === view.memberSharePercent) return view.credits.memberCredits;
  return Math.floor((view.credits.workspaceCredits * percent) / 100);
}
