'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { joinRefusalOf, type JoinRefusal, type MeetingJoinView } from '../../lib/api/meeting-join';

export type JoinOutcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'opened'; readonly url: string }
  | { readonly kind: 'refused'; readonly reason: JoinRefusal }
  | { readonly kind: 'failed'; readonly url: string | null };

/**
 * 53-12 — the Join button's behaviour. A tab is opened in the click itself (a browser blocks one
 * opened after an await), the API is asked to join (it records attendance and answers the link),
 * and the tab is sent there. If the API refuses, or the tab was blocked, the tab is closed and the
 * page shows the "Call didn't open" state with Try again / Open in new tab.
 */
export function useMeetingJoin(join: () => Promise<MeetingJoinView>, invalidate: unknown[]) {
  const queries = useQueryClient();
  const [outcome, setOutcome] = useState<JoinOutcome>({ kind: 'idle' });
  const mutation = useMutation({ mutationFn: join });

  const start = () => {
    const tab = typeof window === 'undefined' ? null : window.open('', '_blank');
    if (tab) tab.opener = null;
    mutation.mutate(undefined, {
      onSuccess: (answer) => {
        void queries.invalidateQueries({ queryKey: invalidate });
        if (tab) {
          tab.location.href = answer.url;
          setOutcome({ kind: 'opened', url: answer.url });
        } else {
          setOutcome({ kind: 'failed', url: answer.url });
        }
      },
      onError: (error) => {
        tab?.close();
        const reason = joinRefusalOf(error);
        setOutcome(reason ? { kind: 'refused', reason } : { kind: 'failed', url: null });
      },
    });
  };

  return { start, pending: mutation.isPending, outcome, reset: () => setOutcome({ kind: 'idle' }) };
}
