import { INTERNAL_ROLES, PLATFORM_SUPPORT_ROLE, isUuid } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import {
  AI_CONVERSATION_RETENTION_MAX_DAYS,
  AI_CONVERSATION_RETENTION_MIN_DAYS,
} from './ai-conversations.service.js';
import type { AiOwnerSettings } from './ai-settings.repository.js';
import type { AiWriteScope } from './copilot-chat.service.js';

/**
 * 62-17 (plan 62 J1) — the pure rules of Settings > AI. Every one runs on the server; the web
 * screen only draws what the API answers (AR-8).
 */

/** The member-share figures the screen offers, each with its credits in the view (plan 62 §5). */
export const AI_MEMBER_SHARE_CHOICES = [25, 50, 75, 100] as const;
export const AI_MEMBER_SHARE_MIN_PERCENT = 1;
export const AI_MEMBER_SHARE_MAX_PERCENT = 100;

/** Members one PATCH may block or allow again, per list. */
export const AI_SETTINGS_MEMBERS_PER_PATCH = 50;

/** The providers a workspace's questions go to, in the order the provider line names them. */
export type AiProvider = 'anthropic' | 'voyage';

/**
 * Only the workspace owner opens Settings > AI. An organization admin, every other internal role,
 * every client role and the hidden Support-session role are refused (403).
 */
export function mayManageAiSettings(principal: Principal): boolean {
  return (
    principal.kind === 'internal' &&
    principal.membershipStatus === 'active' &&
    principal.role === 'owner'
  );
}

export function requireAiSettingsOwner(principal: Principal): void {
  if (!mayManageAiSettings(principal)) {
    throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'copilot.settings:owner');
  }
}

/** The owner's change, every field optional; at least one is present. */
export interface AiSettingsPatch {
  readonly aiEnabled?: boolean;
  readonly writeScope?: AiWriteScope;
  readonly runAtOnce?: boolean;
  readonly fileReading?: boolean;
  readonly memberSharePercent?: number;
  readonly conversationRetentionDays?: number;
  readonly blockMembershipIds?: readonly string[];
  readonly allowMembershipIds?: readonly string[];
}

const PATCH_KEYS = [
  'aiEnabled',
  'writeScope',
  'runAtOnce',
  'fileReading',
  'memberSharePercent',
  'conversationRetentionDays',
  'blockMembershipIds',
  'allowMembershipIds',
] as const;

interface FieldError {
  readonly field: string;
  readonly message: string;
}

function invalid(errors: readonly FieldError[]): ApiError {
  return new ApiError(400, 'validation_failed', 'Check the AI settings.', errors);
}

function wholeIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function idList(value: unknown, field: string, errors: FieldError[]): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > AI_SETTINGS_MEMBERS_PER_PATCH ||
    !value.every((id) => typeof id === 'string' && isUuid(id))
  ) {
    errors.push({
      field,
      message: `a list of at most ${String(AI_SETTINGS_MEMBERS_PER_PATCH)} member ids`,
    });
    return null;
  }
  return [...new Set(value as string[])];
}

/** Parses the PATCH body: unknown fields, wrong types and out-of-range numbers are a 400. */
export function parseAiSettingsPatch(
  body: Readonly<Record<string, unknown>> | null,
): AiSettingsPatch {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalid([{ field: 'body', message: 'an object' }]);
  }
  const errors: FieldError[] = [];
  for (const key of Object.keys(body)) {
    if (!(PATCH_KEYS as readonly string[]).includes(key)) {
      errors.push({ field: key, message: 'not a setting' });
    }
  }
  const patch: {
    -readonly [K in keyof AiSettingsPatch]: AiSettingsPatch[K];
  } = {};
  for (const key of ['aiEnabled', 'runAtOnce', 'fileReading'] as const) {
    if (!(key in body)) continue;
    const value = body[key];
    if (typeof value === 'boolean') patch[key] = value;
    else errors.push({ field: key, message: 'true or false' });
  }
  if ('writeScope' in body) {
    const value = body['writeScope'];
    if (value === 'read' || value === 'read_write') patch.writeScope = value;
    else errors.push({ field: 'writeScope', message: "'read' or 'read_write'" });
  }
  if ('memberSharePercent' in body) {
    const value = body['memberSharePercent'];
    if (wholeIn(value, AI_MEMBER_SHARE_MIN_PERCENT, AI_MEMBER_SHARE_MAX_PERCENT)) {
      patch.memberSharePercent = value;
    } else {
      errors.push({ field: 'memberSharePercent', message: 'a whole number from 1 to 100' });
    }
  }
  if ('conversationRetentionDays' in body) {
    const value = body['conversationRetentionDays'];
    if (wholeIn(value, AI_CONVERSATION_RETENTION_MIN_DAYS, AI_CONVERSATION_RETENTION_MAX_DAYS)) {
      patch.conversationRetentionDays = value;
    } else {
      errors.push({
        field: 'conversationRetentionDays',
        message: `a whole number from ${String(AI_CONVERSATION_RETENTION_MIN_DAYS)} to ${String(AI_CONVERSATION_RETENTION_MAX_DAYS)}`,
      });
    }
  }
  for (const key of ['blockMembershipIds', 'allowMembershipIds'] as const) {
    if (!(key in body)) continue;
    const ids = idList(body[key], key, errors);
    if (ids !== null) patch[key] = ids;
  }
  const both = (patch.blockMembershipIds ?? []).filter((id) =>
    (patch.allowMembershipIds ?? []).includes(id),
  );
  if (both.length > 0) {
    errors.push({
      field: 'allowMembershipIds',
      message: 'a member cannot be blocked and allowed at once',
    });
  }
  if (errors.length > 0) throw invalid(errors);
  if (Object.keys(patch).length === 0) {
    throw invalid([{ field: 'body', message: 'at least one setting to change' }]);
  }
  return patch;
}

/**
 * The settings after the patch. "Answer questions only" turns quick changes off with it (the
 * screen greys the box); asking for quick changes while answers-only is a 400.
 */
export function applyAiSettingsPatch(
  before: AiOwnerSettings,
  patch: AiSettingsPatch,
): AiOwnerSettings {
  const writeScope = patch.writeScope ?? before.writeScope;
  if (writeScope === 'read' && patch.runAtOnce === true) {
    throw invalid([
      { field: 'runAtOnce', message: 'quick changes need "Answer and make changes"' },
    ]);
  }
  return {
    aiEnabled: patch.aiEnabled ?? before.aiEnabled,
    writeScope,
    runAtOnce: writeScope === 'read' ? false : (patch.runAtOnce ?? before.runAtOnce),
    fileReading: patch.fileReading ?? before.fileReading,
    memberSharePercent: patch.memberSharePercent ?? before.memberSharePercent,
    conversationRetentionDays: patch.conversationRetentionDays ?? before.conversationRetentionDays,
  };
}

/** One `{ field, before, after }` per setting the patch changed (the audit change rows). */
export function changedSettings(
  before: AiOwnerSettings,
  after: AiOwnerSettings,
): readonly { readonly field: string; readonly before: unknown; readonly after: unknown }[] {
  return (Object.keys(after) as (keyof AiOwnerSettings)[])
    .filter((key) => before[key] !== after[key])
    .map((key) => ({ field: key, before: before[key], after: after[key] }));
}

/**
 * Whether a membership may be put on the block list: an internal person of the workspace other
 * than the owner. Anything else (a client, an AI employee, the hidden Support session) reads as
 * absent (404) so the route reveals nothing; the owner is a 400.
 */
export function blockableMember(
  member: { role: string; kind: string } | null,
): 'ok' | 'owner' | 'absent' {
  if (member === null || member.kind !== 'human') return 'absent';
  if (member.role === PLATFORM_SUPPORT_ROLE) return 'absent';
  if (!(INTERNAL_ROLES as readonly string[]).includes(member.role)) return 'absent';
  return member.role === 'owner' ? 'owner' : 'ok';
}

/** The provider line: Anthropic always; Voyage only while search by meaning is on. */
export function aiProvidersOf(searchByMeaning: boolean): readonly AiProvider[] {
  return searchByMeaning ? ['anthropic', 'voyage'] : ['anthropic'];
}
