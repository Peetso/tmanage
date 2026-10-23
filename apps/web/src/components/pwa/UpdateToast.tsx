'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Toast, ToastRegion } from '@tmanage/ui';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { deriveUpdateToastState, SKIP_WAITING_MESSAGE } from './update-toast-state';

/**
 * **"Update available" toast (slice 08, the updater intent).**
 *
 * Mounted once in the root layout beside {@link ServiceWorkerRegister}. It watches the app-shell
 * registration from slice 01 for a worker parked in the *waiting* state — a new build that has
 * installed but, now that the worker no longer skips waiting on its own, will not take over until
 * the window asks. When one appears it offers a reload; on click it posts `SKIP_WAITING` to that
 * worker and reloads as soon as the new worker takes control.
 *
 * It renders an always-mounted, empty {@link ToastRegion} so the live region exists before its
 * first message (the region's own contract), and it does nothing on the server or in a browser
 * without service-worker support.
 */
export function UpdateToast() {
  const t = useT();
  const tOr = useTOr();
  const [hasWaitingWorker, setHasWaitingWorker] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const waitingWorker = useRef<ServiceWorker | null>(null);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }

    let active = true;
    const noteWaiting = (worker: ServiceWorker | null) => {
      if (!active) {
        return;
      }
      waitingWorker.current = worker;
      setHasWaitingWorker(worker !== null);
      // A newly offered build is a fresh offer: surface it even if an earlier one was dismissed.
      if (worker !== null) {
        setDismissed(false);
      }
    };

    const watch = (registration: ServiceWorkerRegistration) => {
      // A build may already be waiting when this mounts (installed on a previous visit).
      if (registration.waiting && navigator.serviceWorker.controller) {
        noteWaiting(registration.waiting);
      }

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) {
          return;
        }
        installing.addEventListener('statechange', () => {
          // "installed" with an existing controller means this build is now waiting behind the
          // one in control — the exact moment there is something to offer.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            noteWaiting(registration.waiting ?? installing);
          }
        });
      });
    };

    navigator.serviceWorker
      .getRegistration()
      .then((registration) => {
        if (active && registration) {
          watch(registration);
        }
      })
      .catch(() => {
        // Non-fatal: no registration means no update to offer.
      });

    return () => {
      active = false;
    };
  }, []);

  const reload = useCallback(() => {
    const worker = waitingWorker.current;
    if (!worker || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }
    // Reload once the new worker has taken control, so the reloaded document is served by it.
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => {
        window.location.reload();
      },
      { once: true },
    );
    worker.postMessage(SKIP_WAITING_MESSAGE);
  }, []);

  const dismiss = useCallback(() => setDismissed(true), []);

  const state = deriveUpdateToastState({ hasWaitingWorker, dismissed });

  return (
    <ToastRegion aria-label={tOr('Shell.notifications', 'Notifications')}>
      {state === 'available' ? (
        <Toast tone="neutral" onDismiss={dismiss} dismissLabel={t('UpdateToast.dismissLabel')}>
          <span className="tm-toast__body">{t('UpdateToast.body')}</span>
          <Button type="button" tone="text" size="compact" onClick={reload}>
            {t('UpdateToast.reload')}
          </Button>
        </Toast>
      ) : null}
    </ToastRegion>
  );
}
