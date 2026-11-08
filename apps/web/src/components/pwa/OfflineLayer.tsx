'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkItemState } from '@tmanage/domain';
import { Button } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { useTOr } from '../../lib/i18n/use-t-or';
import { offlineQueue } from '../../lib/offline/offline-runtime';
import { textOf, type OfflineWrite } from '../../lib/offline/queue';
import { keepMine, replayQueue, takeTheirs } from '../../lib/offline/replay';
import { apiTransport } from '../../lib/offline/transport';
import { useOfflineWrites, useOnline } from '../../lib/offline/use-offline';
import { stateLabel } from '../../lib/work-item-presentation';
import './offline-layer.css';

/**
 * **53-16 Offline mode** (Figma "R39 L1-53-16-offline" on the Product page).
 *
 * Mounted once, beside the service worker registration. It owns three things:
 *
 * - **The offline strip** — when the connection drops: "You are offline. Showing what you last
 *   saw." and how many changes are waiting. While the queue is being sent after reconnecting it
 *   says so.
 * - **The replay** — on reconnect (and on load, if something is still queued) the queue is sent
 *   in order through the ordinary API routes; the server checks permission and workspace on each.
 * - **Conflict cards** — one per change the server refused: keep mine, take theirs, copy my text.
 */
export function OfflineLayer() {
  const tOr = useTOr();
  const online = useOnline();
  const writes = useOfflineWrites();
  const [sending, setSending] = useState(false);
  const running = useRef(false);

  const pending = writes.filter((write) => write.status === 'pending');
  const conflicts = writes.filter((write) => write.status === 'conflict');

  const run = useCallback(async (work: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    setSending(true);
    try {
      await work();
    } catch {
      // A failed run leaves the queue as it was; the next reconnect tries again.
    } finally {
      running.current = false;
      setSending(false);
    }
  }, []);

  const pendingCount = pending.length;
  useEffect(() => {
    if (!online || pendingCount === 0) return;
    void run(() => replayQueue(offlineQueue(), apiTransport(browserApiClient())));
  }, [online, pendingCount, run]);

  const showStrip = !online || (sending && pendingCount > 0);

  return (
    <>
      {showStrip ? (
        <div className="tm-offline-strip" role="status" aria-live="polite">
          <span className="tm-offline-strip__message">
            {online
              ? tOr('OfflineMode.sending', 'Back online. Sending your changes…')
              : tOr('OfflineMode.offline', 'You are offline. Showing what you last saw.')}
          </span>
          {pendingCount > 0 ? (
            <span className="tm-offline-strip__count">
              {pendingCount === 1
                ? tOr('OfflineMode.waitingOne', '1 change waiting to send')
                : tOr('OfflineMode.waitingMany', '{count} changes waiting to send').replace(
                    '{count}',
                    String(pendingCount),
                  )}
            </span>
          ) : null}
        </div>
      ) : null}
      {conflicts.length > 0 ? (
        <div className="tm-offline-conflicts">
          {conflicts.map((write) => (
            <ConflictCard
              key={write.id}
              write={write}
              busy={sending}
              onKeep={() =>
                run(() => keepMine(offlineQueue(), apiTransport(browserApiClient()), write))
              }
              onTake={() =>
                run(() => takeTheirs(offlineQueue(), apiTransport(browserApiClient()), write))
              }
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

function ConflictCard({
  write,
  busy,
  onKeep,
  onTake,
}: {
  write: OfflineWrite;
  busy: boolean;
  onKeep: () => void;
  onTake: () => void;
}) {
  const tOr = useTOr();
  const [copied, setCopied] = useState(false);
  const code = write.conflict?.code;
  const body =
    code === 'conflict'
      ? tOr('OfflineMode.conflictChanged', 'Someone changed this item while you were offline.')
      : code === 'forbidden' || code === 'not_found'
        ? tOr('OfflineMode.conflictGone', 'You can no longer change this item.')
        : tOr('OfflineMode.conflictRefused', 'The server did not accept this change.');

  const mine =
    write.kind === 'transition'
      ? `${tOr('OfflineMode.status', 'Status')} → ${stateLabel(write.payload.to as WorkItemState)}`
      : write.kind === 'checklist'
        ? `${write.payload.done ? '✓' : '○'} ${write.payload.label}`
        : textOf(write);
  const theirs = write.conflict?.theirs;

  async function copy() {
    try {
      await navigator.clipboard.writeText(textOf(write));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="tm-offline-conflict" aria-labelledby={`tm-offline-conflict-${write.id}`}>
      <h2 id={`tm-offline-conflict-${write.id}`} className="tm-offline-conflict__title">
        {tOr('OfflineMode.conflictTitle', 'This change could not be sent')}
      </h2>
      <p className="tm-offline-conflict__body">{body}</p>
      <p className="tm-offline-conflict__row">
        <span className="tm-offline-conflict__label">{tOr('OfflineMode.yours', 'Yours:')}</span>
        <span>{mine}</span>
      </p>
      {theirs ? (
        <p className="tm-offline-conflict__row">
          <span className="tm-offline-conflict__label">{tOr('OfflineMode.now', 'Now:')}</span>
          <span>
            {tOr('OfflineMode.status', 'Status')} → {stateLabel(theirs as WorkItemState)}
          </span>
        </p>
      ) : null}
      <div className="tm-offline-conflict__actions">
        <Button tone="lime" onClick={onKeep} disabled={busy}>
          {tOr('OfflineMode.keepMine', 'Keep mine')}
        </Button>
        <Button tone="outline" onClick={onTake} disabled={busy}>
          {tOr('OfflineMode.takeTheirs', 'Take theirs')}
        </Button>
        <Button tone="text" onClick={() => void copy()}>
          {copied
            ? tOr('OfflineMode.copied', 'Copied')
            : tOr('OfflineMode.copyText', 'Copy my text')}
        </Button>
      </div>
    </section>
  );
}
