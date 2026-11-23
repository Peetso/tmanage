import type { AiActivityItem, AiPanelView } from '../../lib/api/ai-panel';

/**
 * The AI panel's decisions, pure (IP-3; Figma 851:906; Fable 5.2 rulings 2026-11-23, gap 4). The
 * server sends every flag (`GET …/ai/panel`, AR-9); these functions only read them, so the rules
 * are proved without a browser.
 */

export type AiPanelTab = 'tmanage' | 'own';

/**
 * How the panel is laid out.
 * - `tabs`: both directions can be used here (the member may connect their own AI, and the plan
 *   has TManage AI). Tab 1 TManage AI, tab 2 Your AI.
 * - `tmanage-only` / `own-only`: one direction, a plain title and no tab bar.
 * - `none`: neither; the launcher keeps its own-AI popovers (they say why it is off).
 */
export type AiPanelLayout = 'tabs' | 'tmanage-only' | 'own-only' | 'none';

export function panelLayout(view: AiPanelView): AiPanelLayout {
  const tmanage = view.tmanageAi.inPlan;
  const own = view.ownAi.enabled;
  if (tmanage && own) return 'tabs';
  if (tmanage) return 'tmanage-only';
  if (own) return 'own-only';
  return 'none';
}

/**
 * The tab the panel opens on: TManage AI when it is on; Your AI when TManage AI is off, or when
 * something waits and the panel was opened from the approvals badge.
 */
export function defaultTab(view: AiPanelView, fromApprovals = false): AiPanelTab {
  const layout = panelLayout(view);
  if (layout === 'own-only') return 'own';
  if (layout === 'tmanage-only') return 'tmanage';
  if (fromApprovals && view.pendingApprovals > 0) return 'own';
  return view.tmanageAi.enabled ? 'tmanage' : 'own';
}

/**
 * Tab 1 shows the short "not on" state instead of the chat when the plan has TManage AI but the
 * owner turned it off. Every other refusal (no key yet, the member blocked) stays the chat's own
 * failure line, as before.
 */
export function tmanageAiOff(view: AiPanelView): boolean {
  return view.tmanageAi.inPlan && !view.tmanageAi.enabled;
}

/** The activity kinds the panel names; any other kind reads as a plain "item". */
export const ACTIVITY_KINDS = [
  'work_item',
  'project',
  'client',
  'member',
  'document',
  'file',
  'invoice',
  'expense',
  'time_entry',
  'item',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

const KIND_ALIASES: Readonly<Record<string, ActivityKind>> = {
  task: 'work_item',
  person: 'member',
  people: 'member',
  membership: 'member',
  invitation: 'member',
  attachment: 'file',
  doc: 'document',
};

/** The server's kind (snake_case, singular, open-ended) as one the panel has words for. */
export function activityKind(kind: string | null): ActivityKind {
  if (kind === null) return 'item';
  if ((ACTIVITY_KINDS as readonly string[]).includes(kind)) return kind as ActivityKind;
  return KIND_ALIASES[kind] ?? 'item';
}

/** One day of activity, newest first, under its date line. */
export interface ActivityDay {
  /** `YYYY-MM-DD` in the member's time zone. */
  readonly key: string;
  readonly items: readonly AiActivityItem[];
}

/** `YYYY-MM-DD` of an instant, in a time zone (the runtime's own when none is given). */
export function dayKey(iso: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Rows grouped by day, keeping the server's newest-first order. */
export function groupByDay(items: readonly AiActivityItem[], timeZone?: string): ActivityDay[] {
  const days: { key: string; items: AiActivityItem[] }[] = [];
  for (const item of items) {
    const key = dayKey(item.at, timeZone);
    const last = days[days.length - 1];
    if (last && last.key === key) last.items.push(item);
    else days.push({ key, items: [item] });
  }
  return days;
}

/** Which date line a day gets: "Today", "Yesterday · 22 Nov", or the date alone. */
export function dayLabelKind(
  key: string,
  now: Date,
  timeZone?: string,
): 'today' | 'yesterday' | 'earlier' {
  if (key === dayKey(now.toISOString(), timeZone)) return 'today';
  const yesterday = dayKey(new Date(now.getTime() - 86_400_000).toISOString(), timeZone);
  return key === yesterday ? 'yesterday' : 'earlier';
}

/** The activity list refreshes every 20 s while it is visible (gap 1 ruling). */
export const ACTIVITY_REFRESH_MS = 20_000;

/** "Live" shows only while updates really arrive: the last good read is at most two cycles old. */
export function isLive(lastSuccessAt: number, now: number): boolean {
  return lastSuccessAt > 0 && now - lastSuccessAt <= ACTIVITY_REFRESH_MS * 2;
}

/** The approval card's local outcome after the member answered it in the panel. */
export type ApprovalOutcome =
  | { readonly kind: 'open' }
  | { readonly kind: 'approving' }
  | { readonly kind: 'rejecting' }
  | { readonly kind: 'approved'; readonly at: string }
  | { readonly kind: 'rejected'; readonly at: string }
  | { readonly kind: 'ended'; readonly at: string }
  | { readonly kind: 'failed' };
