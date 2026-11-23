import type {
  AiConfirmView,
  AiUndoView,
  AiUnavailableReason,
  ChatTurnRequest,
  CopilotChatView,
} from '../../lib/api/ai-chat';

/**
 * The TManage AI panel's functional core (IP-3): what the conversation holds and how one event
 * changes it. Pure — no fetch, no clock, no DOM — so every state of Figma section 764:43270 is a
 * reducer case the unit tests drive directly.
 */

/** Why a turn failed: offline, a plain failure, or an `ai_unavailable` reason (AI-TWO-WAYS). */
export type ChatFailReason = 'offline' | 'error' | { readonly unavailable: AiUnavailableReason };

/** Where a preview card (Figma G5 / G6 v2) stands after the member acted on it. */
export type CardPhase =
  | { readonly kind: 'preview' }
  | { readonly kind: 'confirming' }
  | { readonly kind: 'cancelled' }
  /** 409 on confirm: expired or already used (Figma 767:44499 "Card ended"). */
  | { readonly kind: 'ended' }
  | { readonly kind: 'done'; readonly result: AiConfirmView }
  | { readonly kind: 'undoing'; readonly result: AiConfirmView }
  | { readonly kind: 'undone'; readonly undo: AiUndoView }
  /** 409 on undo (Figma 782:48348 "Refused"). */
  | { readonly kind: 'undo_refused'; readonly result: AiConfirmView | null };

/** What a turn that ran changes at once can still do (Figma 767:44391 Done + Undo). */
export type AtOncePhase =
  | { readonly kind: 'done' }
  | { readonly kind: 'undoing' }
  | { readonly kind: 'undone'; readonly undo: AiUndoView }
  | { readonly kind: 'undo_refused' };

export type ChatEntry =
  | { readonly kind: 'member'; readonly id: string; readonly text: string }
  | { readonly kind: 'pending'; readonly id: string; readonly request: ChatTurnRequest }
  | {
      readonly kind: 'reply';
      readonly id: string;
      readonly request: ChatTurnRequest;
      readonly view: CopilotChatView;
      readonly card: CardPhase;
      readonly atOnce: AtOncePhase;
      /** The estimate was answered (Continue or Cancel): its buttons go. */
      readonly settled: boolean;
    }
  | {
      readonly kind: 'failed';
      readonly id: string;
      readonly request: ChatTurnRequest;
      /**
       * `offline` = no answer at all (unknown state, HT-2), `error` = the API refused or failed,
       * `unavailable` = TManage AI cannot answer in this workspace, with the API's reason.
       */
      readonly reason: ChatFailReason;
    }
  /** A past conversation's message, read back from the history (text only). */
  | {
      readonly kind: 'past';
      readonly id: string;
      readonly role: 'member' | 'assistant';
      readonly text: string;
    };

export interface ChatState {
  readonly entries: readonly ChatEntry[];
  readonly conversationId: string | null;
  readonly busy: boolean;
}

export const EMPTY_CHAT: ChatState = { entries: [], conversationId: null, busy: false };

export type ChatEvent =
  | {
      readonly type: 'sent';
      readonly id: string;
      readonly request: ChatTurnRequest;
      readonly echo: string | null;
    }
  | { readonly type: 'answered'; readonly id: string; readonly view: CopilotChatView }
  | { readonly type: 'failed'; readonly id: string; readonly reason: ChatFailReason }
  | { readonly type: 'estimate-settled'; readonly id: string }
  | { readonly type: 'card'; readonly id: string; readonly phase: CardPhase }
  | { readonly type: 'at-once'; readonly id: string; readonly phase: AtOncePhase }
  | { readonly type: 'retry'; readonly id: string; readonly newId: string }
  | {
      readonly type: 'loaded';
      readonly conversationId: string;
      readonly messages: readonly { id: string; role: 'member' | 'assistant'; body: string }[];
    }
  | { readonly type: 'reset' };

function replace(
  entries: readonly ChatEntry[],
  id: string,
  next: (entry: ChatEntry) => ChatEntry | null,
): ChatEntry[] {
  const out: ChatEntry[] = [];
  for (const entry of entries) {
    if (entry.id !== id) {
      out.push(entry);
      continue;
    }
    const value = next(entry);
    if (value !== null) out.push(value);
  }
  return out;
}

export function chatReducer(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case 'sent': {
      const echo: ChatEntry[] =
        event.echo === null ? [] : [{ kind: 'member', id: `${event.id}-q`, text: event.echo }];
      return {
        ...state,
        busy: true,
        entries: [
          ...state.entries,
          ...echo,
          { kind: 'pending', id: event.id, request: event.request },
        ],
      };
    }
    case 'answered':
      return {
        busy: false,
        conversationId: event.view.conversationId ?? state.conversationId,
        entries: replace(state.entries, event.id, (entry) =>
          entry.kind === 'pending'
            ? {
                kind: 'reply',
                id: entry.id,
                request: entry.request,
                view: event.view,
                card: { kind: 'preview' },
                atOnce: { kind: 'done' },
                settled: false,
              }
            : entry,
        ),
      };
    case 'failed':
      return {
        ...state,
        busy: false,
        entries: replace(state.entries, event.id, (entry) =>
          entry.kind === 'pending'
            ? { kind: 'failed', id: entry.id, request: entry.request, reason: event.reason }
            : entry,
        ),
      };
    case 'retry':
      return {
        ...state,
        busy: true,
        entries: replace(state.entries, event.id, (entry) =>
          entry.kind === 'failed'
            ? { kind: 'pending', id: event.newId, request: entry.request }
            : entry,
        ),
      };
    case 'estimate-settled':
      return {
        ...state,
        entries: replace(state.entries, event.id, (entry) =>
          entry.kind === 'reply' ? { ...entry, settled: true } : entry,
        ),
      };
    case 'card':
      return {
        ...state,
        entries: replace(state.entries, event.id, (entry) =>
          entry.kind === 'reply' ? { ...entry, card: event.phase } : entry,
        ),
      };
    case 'at-once':
      return {
        ...state,
        entries: replace(state.entries, event.id, (entry) =>
          entry.kind === 'reply' ? { ...entry, atOnce: event.phase } : entry,
        ),
      };
    case 'loaded':
      return {
        busy: false,
        conversationId: event.conversationId,
        entries: event.messages.map((message) => ({
          kind: 'past' as const,
          id: message.id,
          role: message.role,
          text: message.body,
        })),
      };
    case 'reset':
      return EMPTY_CHAT;
  }
}

/** One piece of an answer: plain text, or a link to a page inside TManage. */
export type AnswerPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly href: string };

/** An org-relative in-app path (`/work/…`) as a link inside this workspace. */
export function inAppHref(path: string, organizationSlug: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) return `/${organizationSlug}`;
  return path.startsWith(`/${organizationSlug}/`) ? path : `/${organizationSlug}${path}`;
}

const LINK = /\[([^\]]+)\]\((\/(?!\/)[^\s)]*)\)/g;

/**
 * The answer guard (62-12) already made every link inert except in-app paths. The panel turns only
 * those `[words](/path)` into links, prefixed with the workspace; anything else stays text.
 */
export function answerParts(text: string, organizationSlug: string): AnswerPart[] {
  const parts: AnswerPart[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ kind: 'text', text: text.slice(last, start) });
    const href = inAppHref(match[2] ?? '/', organizationSlug);
    parts.push({ kind: 'link', text: match[1] ?? href, href });
    last = start + match[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}

/** "What I read": the in-app records an answer links to, each once, in order. */
export function readLinks(
  text: string,
  organizationSlug: string,
): { text: string; href: string }[] {
  const seen = new Set<string>();
  const out: { text: string; href: string }[] = [];
  for (const part of answerParts(text, organizationSlug)) {
    if (part.kind !== 'link' || seen.has(part.href)) continue;
    seen.add(part.href);
    out.push({ text: part.text, href: part.href });
  }
  return out;
}

const ARABIC_INDIC = /[\u0660-\u0669\u06f0-\u06f9]/g;

/**
 * The amount a member typed to confirm a money change (Fable fix 34): `18400`, `18,400`,
 * `18,400.00`, Arabic-Indic digits and the Arabic thousands/decimal marks are all read; anything
 * else is `null`.
 */
export function parseTypedAmount(raw: string): number | null {
  const western = raw
    .trim()
    .replace(ARABIC_INDIC, (digit) => {
      const code = digit.charCodeAt(0);
      return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
    })
    .replace(/\u066c/g, ',')
    .replace(/\u066b/g, '.')
    .replace(/[\s\u00a0\u202f]/g, '');
  if (!/^\d{1,3}(,\d{3})*(\.\d+)?$|^\d+(\.\d+)?$/.test(western)) return null;
  const value = Number(western.replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

/** The kind of stop notice a stopped turn shows (Figma G7 v2, 789:51792). */
export type StopNotice =
  | 'member_share'
  | 'credits_used'
  | 'platform_paused'
  | 'provider'
  | 'sonnet'
  | 'own_ai'
  | 'rate_limited'
  | 'free_help_used'
  | 'not_understood'
  | 'scan'
  | 'tier'
  | 'generic';

export function stopNotice(view: CopilotChatView): StopNotice {
  switch (view.stop) {
    case 'member_credits_used':
      return 'member_share';
    case 'workspace_credits_used':
      return 'credits_used';
    case 'platform_paused':
      return 'platform_paused';
    case 'provider_error':
      return 'provider';
    case 'sonnet_unavailable':
      return 'sonnet';
    case 'tool_limit':
      return 'own_ai';
    case 'rate_limited':
      return 'rate_limited';
    case 'free_support_used':
      return 'free_help_used';
    case 'not_understood':
    case 'model_refused':
      return 'not_understood';
    case 'scan_unavailable':
      return 'scan';
    case 'tier_ceiling':
      return 'tier';
    default:
      return 'generic';
  }
}
