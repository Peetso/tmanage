'use client';

import type { ApiClient } from './api/client';
import { mintRealtimeTicket } from './api/realtime';
import type { LiveSocket, LiveSocketFactory } from './use-channel-live-feed';

/**
 * R7 slice 6 — one shared realtime socket per studio for the chat's status layer: typing frames
 * (in and out) and the notification bridge's `message.created.v1` frames for conversations that
 * are not open. It sits beside `use-channel-live-feed.ts` (which keeps its own socket per open
 * conversation) so the transcript's feed is untouched. One socket carries many subscriptions;
 * the worker checks each one against current rows, and frames are ids only.
 */

export type ChatFrame = Readonly<Record<string, unknown>>;
type Listener = (frame: ChatFrame) => void;

const RECONNECT_CAP_MS = 30_000;

function defaultFactory(url: string): LiveSocket | null {
  if (typeof WebSocket === 'undefined') return null;
  return new WebSocket(url) as unknown as LiveSocket;
}

export class ChatSocket {
  readonly #watched = new Map<string, number>();
  readonly #listeners = new Set<Listener>();
  #socket: LiveSocket | null = null;
  #open = false;
  #attempts = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #off = false;
  #connecting = false;

  constructor(
    private readonly api: ApiClient,
    private readonly organizationSlug: string,
    private readonly factory: LiveSocketFactory = defaultFactory,
  ) {}

  /** Hear every frame on this socket. */
  listen(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  /** Subscribe to a conversation for as long as the returned function is not called. */
  watch(conversationId: string): () => void {
    const count = this.#watched.get(conversationId) ?? 0;
    this.#watched.set(conversationId, count + 1);
    if (count === 0 && this.#open) this.send({ type: 'subscribe', conversationId });
    this.#ensure();
    return () => {
      const left = (this.#watched.get(conversationId) ?? 1) - 1;
      if (left > 0) this.#watched.set(conversationId, left);
      else this.#watched.delete(conversationId);
      if (this.#watched.size === 0) this.#close();
    };
  }

  /** Send a frame if the socket is open; dropped otherwise (typing is best-effort). */
  send(frame: ChatFrame): void {
    if (!this.#open || this.#socket === null) return;
    try {
      this.#socket.send(JSON.stringify(frame));
    } catch {
      // A socket mid-close throws; its close handler reconnects.
    }
  }

  #ensure(): void {
    if (this.#socket !== null || this.#timer !== undefined || this.#off || this.#connecting) {
      return;
    }
    void this.#connect();
  }

  async #connect(): Promise<void> {
    this.#timer = undefined;
    if (this.#watched.size === 0) return;
    let minted;
    this.#connecting = true;
    try {
      minted = await mintRealtimeTicket(this.api, this.organizationSlug);
    } catch {
      this.#retry();
      return;
    } finally {
      this.#connecting = false;
    }
    if (minted.socketUrl === null || this.#watched.size === 0) {
      this.#off = minted.socketUrl === null;
      return;
    }
    const joiner = minted.socketUrl.includes('?') ? '&' : '?';
    const socket = this.factory(
      `${minted.socketUrl}${joiner}ticket=${encodeURIComponent(minted.ticket)}`,
    );
    if (socket === null) {
      this.#off = true;
      return;
    }
    this.#socket = socket;
    socket.onopen = () => {
      this.#open = true;
      this.#attempts = 0;
      for (const conversationId of this.#watched.keys()) {
        this.send({ type: 'subscribe', conversationId });
      }
    };
    socket.onmessage = (event) => {
      let frame: ChatFrame;
      try {
        frame = JSON.parse(String(event.data)) as ChatFrame;
      } catch {
        return;
      }
      for (const listener of this.#listeners) listener(frame);
    };
    socket.onclose = () => {
      this.#socket = null;
      this.#open = false;
      this.#retry();
    };
  }

  #retry(): void {
    if (this.#watched.size === 0) return;
    this.#attempts += 1;
    const ceiling = Math.min(RECONNECT_CAP_MS, 1_000 * 2 ** Math.min(this.#attempts - 1, 10));
    this.#timer = setTimeout(() => void this.#connect(), Math.floor(Math.random() * ceiling));
  }

  #close(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const socket = this.#socket;
    this.#socket = null;
    this.#open = false;
    if (socket !== null) {
      socket.onclose = null;
      socket.close();
    }
  }
}

const sockets = new Map<string, ChatSocket>();

/** The studio's shared chat socket (created on first use). */
export function chatSocketFor(api: ApiClient, organizationSlug: string): ChatSocket {
  const existing = sockets.get(organizationSlug);
  if (existing) return existing;
  const created = new ChatSocket(api, organizationSlug);
  sockets.set(organizationSlug, created);
  return created;
}
