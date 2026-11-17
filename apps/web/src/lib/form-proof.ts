'use client';

import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from './api/client';

/**
 * 52-21 — the invisible form proof, the browser half (the server half is
 * `apps/api/src/modules/public-abuse/form-proof.ts`).
 *
 * When a public form is shown, the page asks `GET /v1/public/form-proof` for a signed `startedAt`
 * and a `nonce`, keeps both in hidden inputs, and on submit adds
 * `proof = SHA-256(nonce + startedAt)` computed here. A person never sees or does anything; a
 * script that never ran the page sends no proof and is held. If the proof cannot be fetched (an
 * old API, a network blip) the form still submits without it — the server decides, nothing breaks.
 */

/** `GET /v1/public/form-proof`. Mirrors the API's `FormProofView`. */
export interface FormProofView {
  readonly startedAt: string;
  readonly nonce: string;
}

/** The fields a submission carries; empty when no proof could be fetched. */
export interface FormProofFields {
  readonly startedAt?: string;
  readonly nonce?: string;
  readonly proof?: string;
}

export async function fetchFormProof(client: ApiClient): Promise<FormProofView | null> {
  try {
    const { data } = await client.request<FormProofView>({
      method: 'GET',
      path: '/v1/public/form-proof',
      authentication: 'none',
    });
    return typeof data?.startedAt === 'string' && typeof data.nonce === 'string' ? data : null;
  } catch {
    return null;
  }
}

/** Lower-case hex SHA-256 of `nonce + startedAt` — exactly what the server recomputes. */
export async function computeFormProof(nonce: string, startedAt: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${nonce}${startedAt}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function formProofFields(issue: FormProofView | null): Promise<FormProofFields> {
  if (issue === null) return {};
  try {
    return {
      startedAt: issue.startedAt,
      nonce: issue.nonce,
      proof: await computeFormProof(issue.nonce, issue.startedAt),
    };
  } catch {
    // No Web Crypto (a very old browser): send the token without the proof.
    return { startedAt: issue.startedAt, nonce: issue.nonce };
  }
}

/**
 * Fetch the proof once when the form mounts. `issue` feeds the hidden inputs; `fields()` is what
 * the submit handler spreads into its body (it waits for a fetch still in flight). A new
 * `generation` fetches it again (sign-up's "Try again" after the page failed to load).
 */
export function useFormProof(
  client: ApiClient,
  generation = 0,
): {
  readonly issue: FormProofView | null;
  fields(): Promise<FormProofFields>;
} {
  const [issue, setIssue] = useState<FormProofView | null>(null);
  const pending = useRef<Promise<FormProofView | null> | null>(null);
  useEffect(() => {
    let cancelled = false;
    const request = fetchFormProof(client);
    pending.current = request;
    void request.then((value) => {
      if (!cancelled) setIssue(value);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);
  return {
    issue,
    fields: async () =>
      formProofFields(issue ?? (await (pending.current ?? Promise.resolve(null)))),
  };
}
