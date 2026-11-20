'use client';

import { useEffect, useState } from 'react';
import type { ProviderAvailability } from '../../lib/api/provider-availability';
import { retryDelay } from '../session/useSessionCheck';

/**
 * The probe behind "Continue with Google / Microsoft". `null` until the first answer. `unknown`
 * is never final: the probe runs again on the session check's schedule (`retryDelay`), so a
 * deploy restart does not leave the page without the button or with a stale answer (HT-3).
 */
export function useProviderAvailability(
  probe: () => Promise<ProviderAvailability>,
): ProviderAvailability | null {
  const [availability, setAvailability] = useState<ProviderAvailability | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const ask = () => {
      void probe().then((answer) => {
        if (!live) return;
        setAvailability(answer);
        if (answer.state === 'unknown') {
          timer = setTimeout(ask, retryDelay(attempt));
          attempt += 1;
        }
      });
    };
    ask();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
    // The probe is bound to the page's one API client; it is asked once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return availability;
}
