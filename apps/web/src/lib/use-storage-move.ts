import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from './api/client';
import { getLatestStorageMove, getStorageMove, startStorageMove } from './api/storage-root';
import type {
  StorageMoveLatest,
  StorageMoveView,
  StorageOnTManageView,
  StorageProvider,
} from './api/storage-root';

/**
 * 57-13c. The "Move to Drive" job for the Plan & usage storage card (plan 57 §19.3).
 *
 * The card asks once for the company's latest job; while that job is queued or running the hook
 * follows it by id at a calm interval and stops as soon as it is done or stopped, reading the
 * company's figures once more then so the card shows what is left on TManage. Starting a move
 * stores the server's answer (a new job, or the one already running) under the same key, so the
 * card switches to progress without a second request. The server decides who may move files;
 * `enabled` only spares people without `org.security.manage` a request that would be refused.
 */

/** How often a running move is read again: calm, the job moves about two files a second. */
export const STORAGE_MOVE_POLL_MS = 5_000;

export const storageMoveKeys = {
  latest: (organizationSlug: string) => ['storage-move', organizationSlug, 'latest'] as const,
};

export function isStorageMoveActive(job: StorageMoveView | null | undefined): boolean {
  return job?.status === 'queued' || job?.status === 'running';
}

export interface StorageMoveState {
  readonly job: StorageMoveView | null;
  /** What is still on TManage, from the latest read; null until it arrives. */
  readonly onTManage: StorageOnTManageView | null;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly isStarting: boolean;
  readonly startError: unknown;
  readonly start: (provider: StorageProvider) => void;
}

export function useStorageMove(
  api: ApiClient,
  organizationSlug: string,
  enabled: boolean,
): StorageMoveState {
  const queryClient = useQueryClient();
  const key = storageMoveKeys.latest(organizationSlug);
  const query = useQuery({
    queryKey: key,
    enabled,
    queryFn: async (): Promise<StorageMoveLatest> => {
      const known = queryClient.getQueryData<StorageMoveLatest>(key);
      if (!known?.job || !isStorageMoveActive(known.job)) {
        return getLatestStorageMove(api, organizationSlug);
      }
      const job = await getStorageMove(api, organizationSlug, known.job.id);
      return isStorageMoveActive(job)
        ? { ...known, job }
        : getLatestStorageMove(api, organizationSlug);
    },
    refetchInterval: (current) =>
      isStorageMoveActive(current.state.data?.job) ? STORAGE_MOVE_POLL_MS : false,
  });
  const mutation = useMutation({
    mutationFn: (provider: StorageProvider) => startStorageMove(api, organizationSlug, provider),
    onSuccess: (job) =>
      queryClient.setQueryData<StorageMoveLatest>(key, (known) => known && { ...known, job }),
  });
  return {
    job: query.data?.job ?? null,
    onTManage: query.data?.onTManage ?? null,
    isPending: query.isPending,
    isError: query.isError,
    isStarting: mutation.isPending,
    startError: mutation.error,
    start: mutation.mutate,
  };
}
