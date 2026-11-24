import type { AiEmployeeLimits } from '@tmanage/domain';
import type { ApiClient } from './client';

/**
 * AI employees (plan 60 v2, slices 60-03, 60-05, 60-07): hire, list, read, edit, pause, resume,
 * change the sponsor of and retire an AI employee, its connections (agent keys and connectors that
 * work as it), and the workspace's AI-employee settings (S8).
 *
 * Every route is behind the server switch `TMANAGE_AI_EMPLOYEES`: while it is off each one is a
 * plain 404, which the screens read as "this workspace has no AI employees" (never an error).
 * Every route also refuses anything but a person's own signed-in session (an API key or an agent
 * gets 403). The tenant is the slug in the path, resolved against the caller's membership.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projections in
 * `e2e/contracts/api-web-shapes.ts` so the two shapes cannot drift.
 */

export type AiEmployeeStatus = 'active' | 'paused' | 'retired';

export interface AiEmployeeWorkingWindowView {
  /** 0 = Sunday … 6 = Saturday. */
  readonly day: number;
  /** `HH:MM`, in the AI employee's own time zone. */
  readonly start: string;
  readonly end: string;
}

/** A project an AI employee works in: its boundary (plan §4.6 rule 6). */
export interface AiEmployeeProjectView {
  readonly id: string;
  readonly name: string;
  /** The project has a client company: the wizard warns, the profile marks it with a dot. */
  readonly isClient: boolean;
}

/** How the AI employee is connected: live credentials and when it last called TManage. */
export interface AiEmployeeConnectionSummaryView {
  readonly live: number;
  /** The latest use of any of its credentials (ISO), or null when it never called. */
  readonly lastCalledAt: string | null;
}

export interface AiEmployeeView {
  readonly id: string;
  readonly membershipId: string;
  /** The AI employee's user id (avatars, people pickers). */
  readonly userId: string;
  readonly displayName: string;
  /** `member`, `guest` or a custom role id. */
  readonly role: string;
  readonly jobTitle: string;
  readonly departmentKey: string | null;
  readonly vendorLabel: string | null;
  readonly modelLabel: string | null;
  readonly status: AiEmployeeStatus;
  readonly pausedReason: string | null;
  readonly pausedAt: string | null;
  readonly retiredAt: string | null;
  readonly sponsor: { readonly membershipId: string; readonly displayName: string | null };
  readonly timezone: string;
  readonly workingHours: readonly AiEmployeeWorkingWindowView[] | null;
  readonly limits: AiEmployeeLimits;
  readonly discloseToClients: boolean;
  readonly projects: readonly AiEmployeeProjectView[];
  /** Task type keys (the catalogue arrives in Phase 2; until then the list is empty). */
  readonly taskTypes: readonly string[];
  readonly connection: AiEmployeeConnectionSummaryView;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly canEdit: boolean;
  readonly canPause: boolean;
  readonly canResume: boolean;
  readonly canRetire: boolean;
}

export interface AiEmployeeListView {
  readonly aiEmployees: readonly AiEmployeeView[];
  /** The workspace's beta cap and how many are not retired. */
  readonly limit: number;
  readonly live: number;
  readonly canHire: boolean;
  /** The workspace switch (S8): false = every agent call is refused; People shows a banner. */
  readonly enabled: boolean;
}

/** The hire body. `role` is `member`, `guest` or a custom role id. */
export interface HireAiEmployeeInput {
  readonly displayName: string;
  readonly jobTitle: string;
  readonly role?: string;
  /** Omitted or null = the hiring person sponsors it. */
  readonly sponsorMembershipId?: string | null;
  readonly departmentKey?: string | null;
  readonly vendorLabel?: string | null;
  readonly modelLabel?: string | null;
  readonly timezone?: string;
  /** At least one project: his boundary. */
  readonly projectIds: readonly string[];
  readonly taskTypes?: readonly string[];
  readonly discloseToClients?: boolean;
}

export interface UpdateAiEmployeeInput {
  readonly version: number;
  readonly jobTitle?: string;
  readonly role?: string;
  readonly departmentKey?: string | null;
  readonly vendorLabel?: string | null;
  readonly modelLabel?: string | null;
  readonly timezone?: string;
  readonly workingHours?: readonly AiEmployeeWorkingWindowView[] | null;
  readonly projectIds?: readonly string[];
  readonly discloseToClients?: boolean;
}

/** One connection of an AI employee: an agent key or a connector that works as it. */
export interface AiEmployeeConnectionView {
  readonly id: string;
  readonly kind: 'key' | 'connector';
  /** The connector's app name ("Claude"), or the key's name. */
  readonly name: string;
  /** A key's display hint (`tmanage_pat_a1b2…`); null for a connector. */
  readonly tokenPrefix: string | null;
  readonly addedBy: { readonly membershipId: string | null; readonly displayName: string | null };
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly live: boolean;
}

export interface AiEmployeeConnectionListView {
  readonly connections: readonly AiEmployeeConnectionView[];
  readonly limit: number;
  readonly live: number;
  readonly canCreate: boolean;
}

/** A key exactly once, with its plaintext (never shown again). */
export interface CreatedAgentKeyView {
  readonly id: string;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdByMembershipId: string | null;
  readonly ipAllowlist: readonly string[];
  readonly live: boolean;
  readonly token: string;
}

export interface CreateAgentKeyInput {
  readonly name: string;
  readonly lifetimeDays: 30 | 60 | 90;
}

export type AiHirePolicy = 'owners_and_admins' | 'owners';
export type AiAssignPolicy = 'managers' | 'owners_and_admins';
export type AiClientWork = 'allowed' | 'internal_only';

/** S8: the workspace's rules for AI employees. */
export interface AiEmployeeSettingsView {
  readonly enabled: boolean;
  readonly hirePolicy: AiHirePolicy;
  readonly assignPolicy: AiAssignPolicy;
  readonly clientWork: AiClientWork;
  readonly discloseToClients: boolean;
  readonly secondApprover: boolean;
  readonly version: number;
  readonly limit: number;
  readonly live: number;
  readonly canEdit: boolean;
}

export interface UpdateAiEmployeeSettingsInput {
  readonly version: number;
  readonly enabled?: boolean;
  readonly hirePolicy?: AiHirePolicy;
  readonly assignPolicy?: AiAssignPolicy;
  readonly clientWork?: AiClientWork;
  readonly discloseToClients?: boolean;
  readonly secondApprover?: boolean;
}

export interface AiExcludedProjectView {
  readonly projectId: string;
  readonly name: string;
  readonly setByMembershipId: string;
  readonly createdAt: string;
}

export interface AiExcludedProjectListView {
  readonly projects: readonly AiExcludedProjectView[];
  readonly canEdit: boolean;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/ai-employees`;
}

function one(organizationSlug: string, id: string): string {
  return `${base(organizationSlug)}/${encodeURIComponent(id)}`;
}

export async function listAiEmployees(
  client: ApiClient,
  organizationSlug: string,
): Promise<AiEmployeeListView> {
  const { data } = await client.request<AiEmployeeListView>({ path: base(organizationSlug) });
  return data;
}

export async function getAiEmployee(
  client: ApiClient,
  organizationSlug: string,
  id: string,
): Promise<AiEmployeeView> {
  const { data } = await client.request<AiEmployeeView>({ path: one(organizationSlug, id) });
  return data;
}

export async function hireAiEmployee(
  client: ApiClient,
  organizationSlug: string,
  input: HireAiEmployeeInput,
): Promise<AiEmployeeView> {
  const { data } = await client.request<AiEmployeeView>({
    method: 'POST',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

export async function updateAiEmployee(
  client: ApiClient,
  organizationSlug: string,
  id: string,
  input: UpdateAiEmployeeInput,
): Promise<AiEmployeeView> {
  const { data } = await client.request<AiEmployeeView>({
    method: 'PATCH',
    path: one(organizationSlug, id),
    body: input,
  });
  return data;
}

type LifecycleStep = 'pause' | 'resume' | 'retire';

/** Pause, resume or retire (retired is final). A stale version is a 409: re-read first. */
export async function changeAiEmployeeStatus(
  client: ApiClient,
  organizationSlug: string,
  id: string,
  step: LifecycleStep,
  version: number,
): Promise<AiEmployeeView> {
  const { data } = await client.request<AiEmployeeView>({
    method: 'POST',
    path: `${one(organizationSlug, id)}/${step}`,
    body: { version },
  });
  return data;
}

export async function changeAiEmployeeSponsor(
  client: ApiClient,
  organizationSlug: string,
  id: string,
  version: number,
  sponsorMembershipId: string,
): Promise<AiEmployeeView> {
  const { data } = await client.request<AiEmployeeView>({
    method: 'POST',
    path: `${one(organizationSlug, id)}/sponsor`,
    body: { version, sponsorMembershipId },
  });
  return data;
}

export async function listAiEmployeeConnections(
  client: ApiClient,
  organizationSlug: string,
  id: string,
): Promise<AiEmployeeConnectionListView> {
  const { data } = await client.request<AiEmployeeConnectionListView>({
    path: `${one(organizationSlug, id)}/connections`,
  });
  return data;
}

export async function createAgentKey(
  client: ApiClient,
  organizationSlug: string,
  id: string,
  input: CreateAgentKeyInput,
): Promise<CreatedAgentKeyView> {
  const { data } = await client.request<CreatedAgentKeyView>({
    method: 'POST',
    path: `${one(organizationSlug, id)}/keys`,
    body: input,
  });
  return data;
}

/** A new key now; the old one keeps working for at most 24 hours. */
export async function rotateAgentKey(
  client: ApiClient,
  organizationSlug: string,
  id: string,
  keyId: string,
  input: CreateAgentKeyInput,
): Promise<CreatedAgentKeyView> {
  const { data } = await client.request<CreatedAgentKeyView>({
    method: 'POST',
    path: `${one(organizationSlug, id)}/keys/${encodeURIComponent(keyId)}/rotate`,
    body: input,
  });
  return data;
}

export async function revokeAgentKey(
  client: ApiClient,
  organizationSlug: string,
  id: string,
  keyId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${one(organizationSlug, id)}/keys/${encodeURIComponent(keyId)}`,
  });
}

/** Stop a connector that works as this AI employee (its grant and tokens end now). */
export async function revokeAiEmployeeConnector(
  client: ApiClient,
  organizationSlug: string,
  id: string,
  grantId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${one(organizationSlug, id)}/connections/connectors/${encodeURIComponent(grantId)}`,
  });
}

export async function getAiEmployeeSettings(
  client: ApiClient,
  organizationSlug: string,
): Promise<AiEmployeeSettingsView> {
  const { data } = await client.request<AiEmployeeSettingsView>({
    path: `${base(organizationSlug)}/settings`,
  });
  return data;
}

export async function updateAiEmployeeSettings(
  client: ApiClient,
  organizationSlug: string,
  input: UpdateAiEmployeeSettingsInput,
): Promise<AiEmployeeSettingsView> {
  const { data } = await client.request<AiEmployeeSettingsView>({
    method: 'PUT',
    path: `${base(organizationSlug)}/settings`,
    body: input,
  });
  return data;
}

export async function listAiExcludedProjects(
  client: ApiClient,
  organizationSlug: string,
): Promise<AiExcludedProjectListView> {
  const { data } = await client.request<AiExcludedProjectListView>({
    path: `${base(organizationSlug)}/excluded-projects`,
  });
  return data;
}

export async function excludeProjectFromAi(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<AiExcludedProjectListView> {
  const { data } = await client.request<AiExcludedProjectListView>({
    method: 'PUT',
    path: `${base(organizationSlug)}/excluded-projects/${encodeURIComponent(projectId)}`,
  });
  return data;
}

/** Let AI employees read the project again (204; re-read the list after). */
export async function includeProjectForAi(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/excluded-projects/${encodeURIComponent(projectId)}`,
  });
}
