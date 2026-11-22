'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from './api/client';
import { getCalendarGrid } from './api/calendar-grid';
import { listFocusBlocks } from './api/focus-blocks';

/** One of today's meetings or focus blocks, as My Day's Today strip and the day bar draw it. */
export interface TodaySlot {
  readonly id: string;
  readonly kind: 'meeting' | 'focus';
  /** The meeting's own id, for its page; `null` for a focus block. */
  readonly meetingId: string | null;
  readonly start: number;
  readonly end: number;
  readonly label: string;
  readonly href: string;
  /** `done` has ended, `now` is under way, `next` is the first one still to come. */
  readonly state: 'done' | 'now' | 'next' | 'later';
}

export interface TodaySlots {
  readonly slots: readonly TodaySlot[];
  /** Meetings only: the number At a glance shows, so it always equals the strip. */
  readonly meetingCount: number;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly refetch: () => void;
}

/** A meeting has no end in the calendar grid; it counts as "now" for this long after it starts. */
const MEETING_NOW_MS = 30 * 60_000;

/** Today's local window, and the anchor day the calendar grid is read for. */
export function todayWindow(now: Date = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    anchor: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
    from: start.toISOString(),
    to: end.toISOString(),
    fromMs: start.getTime(),
    toMs: end.getTime(),
  };
}

/**
 * Today's real meetings and focus blocks, in time order. Meetings come from the calendar grid
 * (this week, anchored today) and blocks from the caller's own focus blocks. Nothing is invented:
 * no data, no slots. Shared by My Day's Today widget and the day bar other sections carry.
 */
export function useTodaySlots(
  api: ApiClient,
  organizationSlug: string,
  /** A fixed clock (My Day's story and test seam); the real one when omitted. */
  now?: number,
): TodaySlots {
  const today = useMemo(() => todayWindow(now === undefined ? new Date() : new Date(now)), [now]);

  const grid = useQuery({
    queryKey: ['calendar-grid', organizationSlug, 'week', today.anchor],
    queryFn: () => getCalendarGrid(api, organizationSlug, { range: 'week', anchor: today.anchor }),
  });

  const blocks = useQuery({
    queryKey: ['focus-blocks', organizationSlug, today.from, today.to],
    queryFn: () => listFocusBlocks(api, organizationSlug, today.from, today.to),
  });

  const slots = useMemo(
    () => buildTodaySlots(grid.data?.days, blocks.data, organizationSlug, today, now ?? Date.now()),
    [grid.data, blocks.data, organizationSlug, today, now],
  );

  return {
    slots,
    meetingCount: slots.filter((slot) => slot.kind === 'meeting').length,
    isPending: grid.isPending || blocks.isPending,
    isError: grid.isError && blocks.isError,
    refetch: () => {
      void grid.refetch();
      void blocks.refetch();
    },
  };
}

interface GridDayLike {
  readonly meetings?: readonly {
    readonly id: string;
    readonly title: string;
    readonly startsAt: string;
  }[];
}

interface BlockLike {
  readonly id: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

/** Pure: the slots for one day from the two reads, each with its state against `now`. */
export function buildTodaySlots(
  days: readonly GridDayLike[] | undefined,
  blocks: readonly BlockLike[] | undefined,
  organizationSlug: string,
  window: { readonly fromMs: number; readonly toMs: number },
  now: number,
): TodaySlot[] {
  const raw: Omit<TodaySlot, 'state'>[] = [];
  for (const day of Array.isArray(days) ? days : []) {
    for (const meeting of Array.isArray(day.meetings) ? day.meetings : []) {
      const start = Date.parse(meeting.startsAt);
      if (Number.isNaN(start) || start < window.fromMs || start >= window.toMs) continue;
      raw.push({
        id: `meeting-${meeting.id}`,
        kind: 'meeting',
        meetingId: meeting.id,
        start,
        end: start + MEETING_NOW_MS,
        label: meeting.title,
        href: `/${organizationSlug}/calendar/meetings/${encodeURIComponent(meeting.id)}`,
      });
    }
  }
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const start = Date.parse(block.startsAt);
    const end = Date.parse(block.endsAt);
    if (Number.isNaN(start) || start < window.fromMs || start >= window.toMs) continue;
    raw.push({
      id: `focus-${block.id}`,
      kind: 'focus',
      meetingId: null,
      start,
      end: Number.isNaN(end) ? start : end,
      label: block.title,
      href: `/${organizationSlug}/calendar`,
    });
  }
  raw.sort((a, b) => a.start - b.start);
  let nextSeen = false;
  return raw.map((slot) => {
    let state: TodaySlot['state'];
    if (slot.end <= now) state = 'done';
    else if (slot.start <= now) state = 'now';
    else if (!nextSeen) {
      state = 'next';
      nextSeen = true;
    } else state = 'later';
    return { ...slot, state };
  });
}
