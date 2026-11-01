'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { browserApiClient } from './api/browser-client';
import type { ApiClient } from './api/client';
import { chatSocketFor } from './chat-socket';
import type { ChatFrame } from './chat-socket';

/** Send at most one typing frame per this window (the worker drops faster ones anyway). */
const SEND_EVERY_MS = 2_000;

/**
 * R7 typing (F4). `typingUserIds` — the people typing in `conversationId` now (never the viewer:
 * the worker skips the sender); each entry lapses at the frame's `until`. `notifyTyping()` — call
 * on composer input; throttled. Nothing is stored anywhere.
 */
export function useTyping(
  organizationSlug: string,
  conversationId: string,
  client?: ApiClient,
): { readonly typingUserIds: readonly string[]; readonly notifyTyping: () => void } {
  const [until, setUntil] = useState<ReadonlyMap<string, number>>(new Map());
  const lastSent = useRef(0);
  const api = client ?? browserApiClient();
  const socket = organizationSlug ? chatSocketFor(api, organizationSlug) : null;

  useEffect(() => {
    if (socket === null || conversationId === '') return;
    const unwatch = socket.watch(conversationId);
    const unlisten = socket.listen((frame: ChatFrame) => {
      if (frame['type'] !== 'typing' || frame['conversationId'] !== conversationId) return;
      const userId = frame['userId'];
      const at = frame['until'];
      if (typeof userId !== 'string' || typeof at !== 'number') return;
      setUntil((current) => new Map(current).set(userId, at));
    });
    return () => {
      unlisten();
      unwatch();
      setUntil(new Map());
    };
  }, [socket, conversationId]);

  // Drop lapsed entries once a second while anyone is typing.
  useEffect(() => {
    if (until.size === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setUntil((current) => {
        const next = new Map([...current].filter(([, at]) => at > now));
        return next.size === current.size ? current : next;
      });
    }, 1_000);
    return () => clearInterval(timer);
  }, [until.size]);

  const notifyTyping = useCallback(() => {
    const now = Date.now();
    if (socket === null || now - lastSent.current < SEND_EVERY_MS) return;
    lastSent.current = now;
    socket.send({ type: 'typing', conversationId });
  }, [socket, conversationId]);

  return { typingUserIds: [...until.keys()], notifyTyping };
}
