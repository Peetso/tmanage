'use client';

import { useEffect, useState } from 'react';
import { browserApiClient } from './api/browser-client';
import type { ApiClient } from './api/client';
import { getPresence, sendPresenceHeartbeat } from './api/presence';
import type { PresenceView } from './api/presence';

/**
 * R7 presence (F4). One shared cache per studio: every `usePresence(userId)` on the page joins
 * one poll (30 s, ≤ 100 ids per read) and one heartbeat (60 s, only while the tab is visible).
 */

const POLL_MS = 30_000;
const HEARTBEAT_MS = 60_000;
const MAX_IDS = 100;

type Listener = () => void;

class PresenceStore {
  readonly views = new Map<string, PresenceView>();
  readonly #wanted = new Map<string, number>();
  readonly #listeners = new Set<Listener>();
  #poll: ReturnType<typeof setInterval> | undefined;
  #beat: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly api: ApiClient,
    private readonly organizationSlug: string,
  ) {}

  want(userId: string, listener: Listener): () => void {
    this.#wanted.set(userId, (this.#wanted.get(userId) ?? 0) + 1);
    this.#listeners.add(listener);
    if (!this.views.has(userId)) void this.refresh();
    this.#start();
    return () => {
      this.#listeners.delete(listener);
      const left = (this.#wanted.get(userId) ?? 1) - 1;
      if (left > 0) this.#wanted.set(userId, left);
      else this.#wanted.delete(userId);
      if (this.#wanted.size === 0) this.#stop();
    };
  }

  async refresh(): Promise<void> {
    const ids = [...this.#wanted.keys()].slice(0, MAX_IDS);
    if (ids.length === 0) return;
    try {
      for (const view of await getPresence(this.api, this.organizationSlug, ids)) {
        this.views.set(view.userId, view);
      }
      for (const listener of this.#listeners) listener();
    } catch {
      // A failed poll keeps the last answer; the next tick retries.
    }
  }

  #start(): void {
    if (this.#poll !== undefined) return;
    const beat = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void sendPresenceHeartbeat(this.api, this.organizationSlug).catch(() => undefined);
    };
    beat();
    this.#beat = setInterval(beat, HEARTBEAT_MS);
    this.#poll = setInterval(() => void this.refresh(), POLL_MS);
  }

  #stop(): void {
    clearInterval(this.#poll);
    clearInterval(this.#beat);
    this.#poll = undefined;
    this.#beat = undefined;
  }
}

const stores = new Map<string, PresenceStore>();

function storeFor(api: ApiClient, organizationSlug: string): PresenceStore {
  const existing = stores.get(organizationSlug);
  if (existing) return existing;
  const created = new PresenceStore(api, organizationSlug);
  stores.set(organizationSlug, created);
  return created;
}

/** One person's presence, or undefined until the first answer. */
export function usePresence(
  organizationSlug: string,
  userId: string,
  client?: ApiClient,
): PresenceView | undefined {
  const api = client ?? browserApiClient();
  const store = organizationSlug ? storeFor(api, organizationSlug) : null;
  const [view, setView] = useState<PresenceView | undefined>(() => store?.views.get(userId));
  useEffect(() => {
    if (store === null || userId === '') return;
    setView(store.views.get(userId));
    return store.want(userId, () => setView(store.views.get(userId)));
  }, [store, userId]);
  return view;
}
