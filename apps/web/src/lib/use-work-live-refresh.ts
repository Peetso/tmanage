'use client';

import { useEffect, useRef } from 'react';
import type { ApiClient } from './api/client';
import { chatSocketFor, type ChatFrame, type ChatSocket } from './chat-socket';

/**
 * 53-01 — live work: boards, lists, My Day and iterations refetch when work changes elsewhere.
 *
 * The worker publishes every work-item event (`created`, `updated` = a move between states,
 * `changed` = a field edit or a move between projects, `commented`, `people_assigned`,
 * `comment_created`) as an ids-only frame on two kinds of topic:
 *
 * - `project:<projectId>` — everyone who can read the project (checked against current rows at
 *   subscribe and on every revalidation, exactly like a channel);
 * - `me` — the acting person's own work (they own it, do it or supervise it), for My Day.
 *
 * A frame is a nudge, never data: the answer is a refetch through the ordinary authorized read,
 * debounced so a burst (a bulk move) costs one refetch. It rides the studio's one shared socket
 * (`chat-socket.ts`), so a screen adds subscriptions, not connections. A deployment without a
 * socket keeps the screen's existing behaviour: nothing here ever fires.
 */

export const WORK_EVENT_PREFIX = 'work_item.';
/** The personal topic: the worker maps it to the socket's own user. */
export const MY_WORK_TOPIC = 'me';

export function projectWorkTopic(projectId: string): string {
  return `project:${projectId}`;
}

/** Whether a socket frame is a work event on one of the watched topics. */
export function isWorkFrame(frame: ChatFrame, topics: ReadonlySet<string>): boolean {
  if (frame['type'] !== 'event') return false;
  const eventType = frame['eventType'];
  const topic = frame['conversationId'];
  return (
    typeof eventType === 'string' &&
    eventType.startsWith(WORK_EVENT_PREFIX) &&
    typeof topic === 'string' &&
    topics.has(topic)
  );
}

export interface WorkLiveRefreshOptions {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  /** Topics to follow; an empty list follows nothing. */
  readonly topics: readonly string[];
  /** Refetch. Called at most once per `debounceMs` burst. */
  readonly onChange: () => void;
  readonly enabled?: boolean;
  readonly debounceMs?: number;
  /** Injected in tests. Defaults to the studio's shared socket. */
  readonly socket?: Pick<ChatSocket, 'watch' | 'listen'>;
}

export function useWorkLiveRefresh(options: WorkLiveRefreshOptions): void {
  const onChange = useRef(options.onChange);
  onChange.current = options.onChange;
  const { api, organizationSlug, enabled = true, debounceMs = 400 } = options;
  const injected = options.socket;
  const key = [...new Set(options.topics)].sort().join('|');

  useEffect(() => {
    if (!enabled || key === '' || organizationSlug === '') return undefined;
    const topics = new Set(key.split('|'));
    const socket = injected ?? chatSocketFor(api, organizationSlug);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unlisten = socket.listen((frame) => {
      if (!isWorkFrame(frame, topics)) return;
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        onChange.current();
      }, debounceMs);
    });
    const unwatch = [...topics].map((topic) => socket.watch(topic));
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      unlisten();
      for (const off of unwatch) off();
    };
  }, [api, organizationSlug, enabled, debounceMs, key, injected]);
}
