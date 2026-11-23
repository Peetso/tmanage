'use client';

import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useDescribeApiError } from '../../../lib/api/describe-error';
import type { StageSetView } from '../../../lib/api/work-stages';
import { workItemKeys } from '../../../lib/query-keys';
import { stageSetsKey } from './use-work-stages';

/**
 * One write path for every stage-set change in the editor (rename, add, reorder, delete, copy,
 * default, create). A write that answers with the set puts it straight into the list the editor
 * reads (feedback within 400 ms, UX-17); every write then refreshes the project sets and the
 * works, because a deleted stage or a new default moves works to another stage on the server.
 * A refused write names its cause in the editor (HT-3), never silently.
 */
export function useStageSetWrites(organizationSlug: string) {
  const queries = useQueryClient();
  const describe = useDescribeApiError();
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const write = useMutation({
    mutationFn: (run: () => Promise<StageSetView | void>) => run(),
    onMutate: () => setFailure(undefined),
    onSuccess: (set) => {
      if (set) {
        queries.setQueryData<readonly StageSetView[]>(stageSetsKey(organizationSlug), (old) =>
          old === undefined
            ? old
            : old.some((entry) => entry.id === set.id)
              ? old.map((entry) => (entry.id === set.id ? set : entry))
              : [...old, set],
        );
      }
      void queries.invalidateQueries({ queryKey: stageSetsKey(organizationSlug) });
      void queries.invalidateQueries({ queryKey: ['project-stage-set', organizationSlug] });
      void queries.invalidateQueries({ queryKey: workItemKeys.all(organizationSlug) });
    },
    onError: (error) => setFailure(describe(error)),
  });

  const { mutateAsync } = write;
  /** Run one write; resolves with the set (or `undefined`), or `null` when it was refused. */
  const run = useCallback(
    async (op: () => Promise<StageSetView | void>): Promise<StageSetView | undefined | null> => {
      try {
        return (await mutateAsync(op)) ?? undefined;
      } catch {
        return null;
      }
    },
    [mutateAsync],
  );

  return {
    run,
    pending: write.isPending,
    failure,
    clearFailure: () => setFailure(undefined),
  };
}

export type StageSetWrites = ReturnType<typeof useStageSetWrites>;
