import type { ApiClient } from './client';

/**
 * 55-11 getting-started checklist and 55-22 Setup health.
 *
 * `GET …/getting-started` is the acting member's checklist (done by company data or by hand);
 * `POST …/steps/:step/complete` marks one step by hand; `POST …/dismiss` hides it for this member.
 * `GET …/getting-started/setup-health` is the owner's four checks (`org.manage`).
 */
export type ChecklistStep =
  | 'invite_teammate'
  | 'create_project'
  | 'add_client'
  | 'connect_storage'
  | 'set_working_hours'
  | 'try_ai_assistant';

export type SetupHealthCheck = 'storage' | 'sign_in_security' | 'backups' | 'domain_mail';

export interface GettingStartedView {
  readonly dismissed: boolean;
  readonly completedCount: number;
  readonly totalCount: number;
  readonly nextStep: ChecklistStep | null;
  readonly steps: readonly { readonly step: ChecklistStep; readonly done: boolean }[];
}

export interface SetupHealthView {
  readonly okCount: number;
  readonly checks: readonly { readonly check: SetupHealthCheck; readonly ok: boolean }[];
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/getting-started`;
}

export async function getGettingStarted(
  client: ApiClient,
  organizationSlug: string,
): Promise<GettingStartedView> {
  const { data } = await client.request<GettingStartedView>({ path: base(organizationSlug) });
  return data;
}

export async function completeGettingStartedStep(
  client: ApiClient,
  organizationSlug: string,
  step: ChecklistStep,
): Promise<GettingStartedView> {
  const { data } = await client.request<GettingStartedView>({
    method: 'POST',
    path: `${base(organizationSlug)}/steps/${encodeURIComponent(step)}/complete`,
  });
  return data;
}

export async function dismissGettingStarted(
  client: ApiClient,
  organizationSlug: string,
): Promise<GettingStartedView> {
  const { data } = await client.request<GettingStartedView>({
    method: 'POST',
    path: `${base(organizationSlug)}/dismiss`,
  });
  return data;
}

export async function getSetupHealth(
  client: ApiClient,
  organizationSlug: string,
): Promise<SetupHealthView> {
  const { data } = await client.request<SetupHealthView>({
    path: `${base(organizationSlug)}/setup-health`,
  });
  return data;
}

/** Where each checklist step is done, relative to `/{orgSlug}`. */
export const STEP_HREF: Readonly<Record<ChecklistStep, string>> = {
  invite_teammate: '/people',
  create_project: '/projects/new',
  add_client: '/clients',
  connect_storage: '/admin/storage',
  set_working_hours: '/admin/working-calendar',
  try_ai_assistant: '/settings/ai-assistant',
};

/** Where each Setup health check is fixed, relative to `/{orgSlug}`. */
export const HEALTH_FIX_HREF: Readonly<Record<SetupHealthCheck, string>> = {
  storage: '/admin/storage',
  sign_in_security: '/settings/organization',
  backups: '/admin/privacy',
  domain_mail: '/settings/inbound-mail',
};
