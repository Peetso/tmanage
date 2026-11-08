'use client';

import { useEffect, useState } from 'react';
import { Button, Toast, ToastRegion } from '@tmanage/ui';
import { useTOr } from '../../lib/i18n/use-t-or';
import { undoQueue, useUndoEntries } from '../../lib/undo/use-undo';
import type { UndoEntry, UndoQueue } from '../../lib/undo/undo-queue';
import '../../styles/screens/undo-and-access.css';

/**
 * 55-23 — the Undo toasts (Figma R50 L3, Product page `594:34380`): one toast per held action,
 * "Task deleted · Undo · ×" with the seconds left, mounted once at the root so a hold outlives
 * the screen that started it. Closing the toast sends the action now; leaving the page sends
 * everything still held, so nothing a person meant to delete is silently kept.
 */
export function UndoToastHost({ queue = undoQueue }: { readonly queue?: UndoQueue }) {
  const tOr = useTOr();
  const entries = useUndoEntries(queue);
  const now = useSecondTick(entries.some((entry) => entry.status === 'pending'));

  useEffect(() => {
    const flush = () => queue.flushAll();
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [queue]);

  return (
    <ToastRegion
      className="tm-undo-region"
      aria-label={tOr('Undo.regionLabel', 'Undo actions')}
      data-testid="undo-toasts"
    >
      {entries.map((entry) => (
        <UndoToast key={entry.id} entry={entry} now={now} queue={queue} />
      ))}
    </ToastRegion>
  );
}

function UndoToast({
  entry,
  now,
  queue,
}: {
  readonly entry: UndoEntry;
  readonly now: number;
  readonly queue: UndoQueue;
}) {
  const tOr = useTOr();
  if (entry.status === 'failed') {
    return (
      <Toast
        tone="danger"
        onDismiss={() => queue.dismiss(entry.id)}
        dismissLabel={tOr('Undo.dismiss', 'Dismiss')}
      >
        {`${entry.message} — ${tOr('Undo.failed', 'that did not go through, so nothing changed.')}`}
      </Toast>
    );
  }
  const seconds = Math.max(0, Math.ceil((entry.deadline - now) / 1000));
  return (
    <Toast
      tone="neutral"
      onDismiss={() => queue.dismiss(entry.id)}
      dismissLabel={tOr('Undo.dismiss', 'Dismiss')}
    >
      <span className="tm-undo-toast__message">{entry.message}</span>
      {entry.status === 'pending' ? (
        <>
          {' '}
          <Button type="button" tone="text" size="compact" onClick={() => queue.undo(entry.id)}>
            {tOr('Undo.action', 'Undo')}
          </Button>{' '}
          <span className="tm-undo-toast__seconds" aria-hidden="true">
            {tOr('Undo.secondsLeft', '{seconds} s').replace('{seconds}', String(seconds))}
          </span>
        </>
      ) : null}
    </Toast>
  );
}

/** `Date.now()`, refreshed every second while something is counting down. */
function useSecondTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [active]);
  return now;
}
