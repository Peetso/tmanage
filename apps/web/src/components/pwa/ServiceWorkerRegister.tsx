'use client';

import { useEffect } from 'react';
import { OfflineLayer } from './OfflineLayer';

/**
 * Registers the app-shell service worker (`/sw.js`) once the window has loaded.
 *
 * Mounted in the root layout. It renders nothing and does nothing on the server or in a
 * browser without service-worker support — the whole body is guarded behind
 * `'serviceWorker' in navigator`, so an unsupported browser simply gets the app without the
 * offline shell. Registration failures are swallowed: the shell is an enhancement, never a
 * prerequisite for the app rendering.
 *
 * Registration is deferred to the `load` event so it never competes with the first paint.
 *
 * 53-16: it also mounts the {@link OfflineLayer} — the offline strip, the replay of changes
 * queued while offline, and the conflict cards — so offline mode lives beside the worker that
 * serves the last-seen pages.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }

    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // Non-fatal: the app works without the cached shell.
      });
    };

    if (document.readyState === 'complete') {
      register();
      return;
    }

    window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);

  return <OfflineLayer />;
}
