'use client';

import type { Editor } from '@tiptap/core';
import { useEffect, useRef, useState } from 'react';

import type { ApiClient } from '../../../lib/api/client';
import {
  pollCollab,
  pushCollabSteps,
  putCollabCursor,
  snapshotCollab,
  type CollabJoinResponse,
  type CollabStepJson,
} from './collab-api';
import {
  collabVersion,
  receiveSteps,
  sendableSteps,
  setRemoteCursors,
  stepsFromJson,
  type RemoteCursor,
} from './collab-steps';

/**
 * Slice 53-10 — the sync loop for one joined editor (Figma 586:33239). One tick at a time: send
 * the unconfirmed steps (a refusal means someone was first: take their steps, the rebase runs,
 * and the next tick sends again), otherwise poll for new steps and cursors; send this tab's
 * cursor when it moved; and every {@link SNAPSHOT_MS} a writer with nothing unconfirmed saves the
 * document at its confirmed version. A viewer only polls.
 */

export type CollabStatus = 'live' | 'catching-up' | 'offline';

export interface CollabPeer {
  readonly userId: string;
  readonly name: string;
  readonly colour: number;
}

const SNAPSHOT_MS = 10_000;

export function newClientId(): string {
  const crypto = globalThis.crypto as Crypto | undefined;
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

export function useDocCollab(options: {
  readonly editor: Editor | null;
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly documentId: string;
  readonly join: CollabJoinResponse | null;
  readonly clientId: string;
  readonly selfUserId?: string;
  readonly onResync: () => void;
  readonly pollMs?: number;
}): { readonly status: CollabStatus; readonly peers: readonly CollabPeer[] } {
  const { editor, api, organizationSlug, documentId, join, clientId, pollMs = 1_000 } = options;
  const [status, setStatus] = useState<CollabStatus>('live');
  const [peers, setPeers] = useState<readonly CollabPeer[]>([]);
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    if (!editor || !join) return undefined;
    const writer = join.role === 'editor';
    editor.setEditable(writer);
    let busy = false;
    let stopped = false;
    let lastCursor = '';
    let snapshotAt = Date.now();
    let snapshotVersion = join.version;

    const apply = (steps: readonly CollabStepJson[]): boolean => {
      if (steps.length === 0) return true;
      try {
        const parsed = stepsFromJson(
          editor.schema,
          steps.map((s) => s.step),
        );
        editor.view.dispatch(
          receiveSteps(
            editor.state,
            parsed,
            steps.map((s) => s.clientId),
            clientId,
          ),
        );
        return true;
      } catch {
        return false;
      }
    };
    const showCursors = (cursors: CollabJoinResponse['cursors']) => {
      const others: RemoteCursor[] = cursors.filter((c) => c.clientId !== clientId);
      editor.view.dispatch(setRemoteCursors(editor.state, others));
      const byUser = new Map<string, CollabPeer>();
      for (const c of cursors) {
        if (c.clientId === clientId || c.userId === latest.current.selfUserId) continue;
        byUser.set(c.userId, { userId: c.userId, name: c.name, colour: c.colour });
      }
      setPeers([...byUser.values()]);
    };
    const resync = () => {
      stopped = true;
      latest.current.onResync();
    };

    if (!apply(join.steps)) {
      resync();
      return undefined;
    }
    showCursors(join.cursors);

    const tick = async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        const sendable = writer ? sendableSteps(editor.state) : null;
        if (sendable) {
          const result = await pushCollabSteps(api, organizationSlug, documentId, {
            version: sendable.version,
            clientId,
            steps: sendable.steps.map((s) => s.toJSON() as unknown),
          });
          if (stopped) return;
          if (result.accepted) {
            editor.view.dispatch(
              receiveSteps(
                editor.state,
                sendable.steps,
                sendable.steps.map(() => clientId),
                clientId,
              ),
            );
            setStatus('live');
            return;
          }
          setStatus('catching-up');
        }
        const polled = await pollCollab(
          api,
          organizationSlug,
          documentId,
          collabVersion(editor.state),
        );
        if (stopped) return;
        if (polled.kind === 'resync' || !apply(polled.steps)) {
          resync();
          return;
        }
        showCursors(polled.cursors);
        if (!sendable) setStatus('live');
        if (!writer) return;
        const { anchor, head } = editor.state.selection;
        const cursorKey = `${anchor}:${head}`;
        if (editor.isFocused && cursorKey !== lastCursor) {
          lastCursor = cursorKey;
          await putCollabCursor(api, organizationSlug, documentId, { clientId, anchor, head });
        }
        const version = collabVersion(editor.state);
        if (
          version > snapshotVersion &&
          Date.now() - snapshotAt >= SNAPSHOT_MS &&
          !sendableSteps(editor.state) &&
          !editor.isEmpty
        ) {
          snapshotAt = Date.now();
          const saved = await snapshotCollab(api, organizationSlug, documentId, {
            version,
            html: editor.getHTML(),
          });
          if (saved.saved) snapshotVersion = version;
        }
      } catch {
        if (!stopped) setStatus('offline');
      } finally {
        busy = false;
      }
    };

    const timer = setInterval(() => void tick(), pollMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // The loop is per joined editor; `api` is a new object per render when no client is passed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, join, clientId, organizationSlug, documentId, pollMs]);

  return { status, peers };
}
