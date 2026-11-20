'use client';

import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listClientRequests,
  listPortalDeliverables,
  listPortalProjects,
  listPortalWorkItems,
} from './api/portal';
import type { ClientRequest, PortalDeliverable, PortalProject, PortalWorkItem } from './api/portal';
import type { ApiClient } from './api/client';
import { isWaitingOnClient } from './client-request-presentation';
import { clientOnlyRead } from './portal-preview';
import { awaitsYou } from './portal-review';

/**
 * QA-FIX-O M3 — what needs the client, decided once for every portal screen.
 *
 * The overview counted a version sent for the client's decision (TESTUX P1 4) while "My Actions"
 * did not, so the overview said "Review and approve" and /portal/actions said "Nothing needs you".
 * Both screens now read this one list (AR-8, "one decision, one place"; NN/g heuristic 4,
 * consistency and standards): work waiting on the client, questions the studio asked on the
 * client's requests, and versions awaiting the client's decision — across every shared project.
 */

export interface PortalActions {
  /** Work items the studio marked as waiting on the client, soonest due first, undated last. */
  readonly waiting: readonly PortalWorkItem[];
  /** The client's requests the studio asked a question on. */
  readonly questions: readonly ClientRequest[];
  /** Versions sent for this client's decision, oldest first. */
  readonly reviews: readonly PortalDeliverable[];
  readonly count: number;
}

/** Undated last: a missing date is not urgency, and sorting it first would invent some. */
export function byDueDate(left: PortalWorkItem, right: PortalWorkItem): number {
  if (left.dueAt === right.dueAt) return 0;
  if (left.dueAt === null) return 1;
  if (right.dueAt === null) return -1;
  return left.dueAt < right.dueAt ? -1 : 1;
}

/** The pure rule both screens apply. */
export function portalActions(input: {
  readonly workItems: readonly PortalWorkItem[];
  readonly requests: readonly ClientRequest[];
  readonly deliverables: readonly PortalDeliverable[];
}): PortalActions {
  const waiting = input.workItems
    .filter((item) => item.progress === 'waiting_on_you')
    .sort(byDueDate);
  const questions = input.requests.filter(isWaitingOnClient);
  const seen = new Set<string>();
  const reviews = input.deliverables
    .filter((deliverable) => {
      if (seen.has(deliverable.id) || !awaitsYou(deliverable.review)) return false;
      seen.add(deliverable.id);
      return true;
    })
    .sort((left, right) => (left.publishedAt < right.publishedAt ? -1 : 1));
  return { waiting, questions, reviews, count: waiting.length + questions.length + reviews.length };
}

export interface PortalActionsQuery {
  readonly projects: readonly PortalProject[] | undefined;
  readonly workItems: readonly PortalWorkItem[];
  readonly requests: readonly ClientRequest[];
  readonly actions: PortalActions;
  /** True once every read that feeds the count has answered (successfully or not). */
  readonly settled: boolean;
  readonly isPending: boolean;
  /** The first failure among the reads, or null. */
  readonly error: unknown;
}

/**
 * The reads behind {@link portalActions}, under the query keys the portal screens already use, so
 * the overview and My Actions share one cache. A staff preview reads the client's empty request
 * list instead of the API's 403 (`clientOnlyRead`).
 */
export function usePortalActions(api: ApiClient, organizationSlug: string): PortalActionsQuery {
  const queryClient = useQueryClient();
  const projects = useQuery({
    queryKey: ['portal-projects', organizationSlug],
    queryFn: () => listPortalProjects(api, organizationSlug),
  });
  const workItems = useQuery({
    queryKey: ['portal-work-items', organizationSlug],
    queryFn: () => listPortalWorkItems(api, organizationSlug),
  });
  const requests = useQuery({
    queryKey: ['portal-requests', organizationSlug],
    queryFn: () =>
      clientOnlyRead(queryClient, organizationSlug, [], () =>
        listClientRequests(api, organizationSlug),
      ),
  });
  const deliverables = useQueries({
    queries: (projects.data ?? []).map((project) => ({
      queryKey: ['portal-deliverables', organizationSlug, project.id],
      queryFn: () => listPortalDeliverables(api, organizationSlug, project.id),
    })),
  });

  const actions = portalActions({
    workItems: workItems.data ?? [],
    requests: requests.data ?? [],
    deliverables: deliverables.flatMap((query) => query.data ?? []),
  });
  const reads = [projects, workItems, requests, ...deliverables];
  const failed = reads.find((query) => query.isError);
  return {
    projects: projects.data,
    workItems: workItems.data ?? [],
    requests: requests.data ?? [],
    actions,
    settled: reads.every((query) => !query.isPending),
    isPending: projects.isPending || workItems.isPending,
    error: failed?.error ?? null,
  };
}
