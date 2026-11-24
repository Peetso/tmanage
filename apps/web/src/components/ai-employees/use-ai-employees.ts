'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getAiEmployeeSettings,
  listAiEmployeeConnections,
  listAiEmployees,
  listAiExcludedProjects,
  type AiEmployeeListView,
  type AiEmployeeSettingsView,
} from '../../lib/api/ai-employees';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import { readOrganizationMe } from '../../lib/api/permission-matrix';
import { listProjectPortfolio } from '../../lib/api/project-portfolio';
import type { ProjectOption } from './ai-employee-model';

/**
 * Plan 60 slice 60-07: the reads behind People, the hire wizard, the AI profile and Settings ›
 * AI employees, each under one query key so a write anywhere refreshes every screen that shows it.
 */

export const aiKeys = {
  list: (slug: string) => ['ai-employees', slug] as const,
  connections: (slug: string, id: string) => ['ai-employees', slug, 'connections', id] as const,
  settings: (slug: string) => ['ai-employees', slug, 'settings'] as const,
  excluded: (slug: string) => ['ai-employees', slug, 'excluded'] as const,
  projects: (slug: string) => ['ai-employees', slug, 'project-options'] as const,
};

/**
 * A refusal that means "this workspace shows no AI employees to you": the server switch is off
 * (404) or the reader may not see them (403). Never an error on screen.
 */
export function isAbsent(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === 404 || error.status === 403);
}

/** A stale write (409): someone changed the row first; the screen re-reads and says so. */
export function isStale(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 409;
}

/** The AI employees, or `null` when the workspace shows none to this reader (see `isAbsent`). */
export function useAiEmployeeList(api: ApiClient, slug: string) {
  return useQuery({
    queryKey: aiKeys.list(slug),
    queryFn: async (): Promise<AiEmployeeListView | null> => {
      try {
        return await listAiEmployees(api, slug);
      } catch (error) {
        if (isAbsent(error)) return null;
        throw error;
      }
    },
    retry: false,
  });
}

export function useAiConnections(api: ApiClient, slug: string, id: string | null) {
  return useQuery({
    queryKey: aiKeys.connections(slug, id ?? ''),
    queryFn: () => listAiEmployeeConnections(api, slug, id ?? ''),
    enabled: id !== null,
    retry: false,
  });
}

/** S8's read; `null` while the server switch is off or the reader may not manage AI employees. */
export function useAiSettings(api: ApiClient, slug: string) {
  return useQuery({
    queryKey: aiKeys.settings(slug),
    queryFn: async (): Promise<AiEmployeeSettingsView | null> => {
      try {
        return await getAiEmployeeSettings(api, slug);
      } catch (error) {
        if (isAbsent(error)) return null;
        throw error;
      }
    },
    retry: false,
  });
}

/** Projects closed to AI; empty when the reader may not see the list (the server still refuses). */
export function useExcludedProjects(api: ApiClient, slug: string, enabled = true) {
  return useQuery({
    queryKey: aiKeys.excluded(slug),
    queryFn: async () => {
      try {
        return await listAiExcludedProjects(api, slug);
      } catch (error) {
        if (isAbsent(error)) return { projects: [], canEdit: false };
        throw error;
      }
    },
    enabled,
    retry: false,
  });
}

/**
 * The open projects a reader can see, each marked when it has a client company (the portfolio
 * read carries `clientName`; it is the only list read that says so). Bounded at the API's 200.
 */
export function useProjectOptions(api: ApiClient, slug: string, enabled = true) {
  return useQuery({
    queryKey: aiKeys.projects(slug),
    queryFn: async (): Promise<readonly ProjectOption[]> => {
      const rows = await listProjectPortfolio(api, slug, { limit: 200 });
      return rows
        .filter((row) => row.archivedAt === null)
        .map((row) => ({ id: row.projectId, name: row.name, isClient: row.clientName !== null }));
    },
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}

/** The signed-in person in this workspace: their membership (the sponsor default) and rights. */
export function useOrganizationMe(api: ApiClient, slug: string) {
  return useQuery({
    queryKey: ['organization-me', slug],
    queryFn: () => readOrganizationMe(api, slug),
    retry: false,
    staleTime: 5 * 60_000,
  });
}

/** Re-read everything an AI-employee write can change (People, the profile, pickers). */
export function useAiRefresh(slug: string): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['ai-employees', slug] });
    void queryClient.invalidateQueries({ queryKey: ['people-directory', slug] });
    void queryClient.invalidateQueries({ queryKey: ['members', slug] });
  };
}
