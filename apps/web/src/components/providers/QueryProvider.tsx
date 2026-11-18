'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiRequestError } from '../../lib/api/errors';

/**
 * TanStack Query, configured once.
 *
 * `03-TECHNICAL-ARCHITECTURE` names it as the server-state cache: "Explicit server-state
 * caching without a global-state monolith."
 *
 * The client is created inside `useState` rather than at module scope. At module scope one
 * `QueryClient` would be shared by every request the Node server handles, so one tenant's
 * cached response could be served to another — which in a multi-tenant application is not a
 * performance bug but a disclosure. Per-render creation keeps the cache in the browser
 * where it belongs.
 *
 * ## The retry rule
 *
 * Nothing retries a refusal. A 401, a 403, a 404 or a validation failure is a decision the
 * server has already made, and repeating the request produces the same decision three times
 * more slowly — while a retried 429 makes the rate limit it just hit worse. Only a
 * transport failure or a server fault is worth trying again.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Tenant data. Refetching on focus is right for a work surface where someone
            // else may have changed the object while the tab was in the background.
            refetchOnWindowFocus: true,
            staleTime: 30_000,
            retry: (failureCount, error) => !isFinal(error) && failureCount < 2,
          },
          mutations: {
            // A mutation that is retried automatically is a mutation that can be applied
            // twice. Until the API carries an idempotency key (13 §3), this stays off.
            retry: false,
            // A write always runs when asked. TanStack's default ('online') parks a mutation
            // while the browser reports offline, before its function runs, so the offline-aware
            // writes (`lib/offline/write-or-queue.ts`) never reached their queue: Log time sat
            // on a grey "Working" with no "Kept on this phone" and sent itself later (TESTUX P1
            // 8). Every other write now fails at once with the network error its screen shows,
            // instead of a silent pending write that may land after the person has left.
            networkMode: 'always',
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** A refusal the server has already decided. Retrying it changes nothing. */
function isFinal(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  return error.status < 500 && error.status !== 408;
}
