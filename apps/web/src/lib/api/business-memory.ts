import type { ApiClient } from './client';

/**
 * Business Memory (plan 62-26) — the web side of `apps/api/src/modules/copilot/memory/`:
 *
 * - `GET …/business-memory/facts?status=all` (`ai.use`): the facts the member may read; other
 *   people's proposals only for approvers (`ai.manage`). At most 200.
 * - `POST facts` (`ai.use`): propose a fact; it waits for a person's approval.
 * - `PATCH facts/:id`, `POST facts/:id/approve|confirm|retire` (`ai.manage`): a person's decisions.
 *
 * The shapes mirror `business-memory.service.ts` field for field; the server decides who may read
 * or change a fact and which facts are stale (AR-9), the screen only draws what it is sent.
 */

export type BusinessFactEntityType = 'client' | 'project' | 'person' | 'process' | 'company';
export type BusinessFactAudience = 'internal' | 'client_visible' | 'finance' | 'hr';
export type BusinessFactStatus = 'proposed' | 'approved' | 'retired';

export const BUSINESS_FACT_AUDIENCES: readonly BusinessFactAudience[] = [
  'internal',
  'client_visible',
  'finance',
  'hr',
];

/** The API's own limit (`BUSINESS_FACT_MAX_CHARS`), counted in code points. */
export const BUSINESS_FACT_MAX_CHARS = 500;

export interface BusinessFactView {
  readonly id: string;
  readonly entityType: BusinessFactEntityType;
  readonly entityId: string | null;
  readonly fact: string;
  readonly category: string;
  readonly sourceHref: string | null;
  readonly audience: BusinessFactAudience;
  readonly status: BusinessFactStatus;
  readonly proposedVia: 'ai' | 'member';
  readonly ownerUserId: string;
  readonly proposedByUserId: string;
  readonly approvedByUserId: string | null;
  readonly approvedAt: string | null;
  readonly lastConfirmedAt: string | null;
  readonly retiredAt: string | null;
  readonly stale: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BusinessFactListView {
  readonly facts: readonly BusinessFactView[];
}

/** `POST facts`. `category` is required by the API; the screen has no field for it (gap). */
export interface BusinessFactProposal {
  readonly entityType: BusinessFactEntityType;
  readonly entityId: string | null;
  readonly fact: string;
  readonly category: string;
  readonly audience: BusinessFactAudience;
}

/** `PATCH facts/:id`: only the fields that changed, at least one. */
export interface BusinessFactEdit {
  readonly fact?: string;
  readonly audience?: BusinessFactAudience;
}

export type BusinessFactDecision = 'approve' | 'confirm' | 'retire';

const base = (slug: string) =>
  `/v1/organizations/${encodeURIComponent(slug)}/business-memory/facts`;

export async function listBusinessFacts(
  client: ApiClient,
  organizationSlug: string,
): Promise<BusinessFactListView> {
  const { data } = await client.request<BusinessFactListView>({
    path: `${base(organizationSlug)}?status=all`,
  });
  return data;
}

export async function proposeBusinessFact(
  client: ApiClient,
  organizationSlug: string,
  proposal: BusinessFactProposal,
): Promise<BusinessFactView> {
  const { data } = await client.request<BusinessFactView>({
    method: 'POST',
    path: base(organizationSlug),
    body: proposal,
  });
  return data;
}

export async function editBusinessFact(
  client: ApiClient,
  organizationSlug: string,
  factId: string,
  edit: BusinessFactEdit,
): Promise<BusinessFactView> {
  const { data } = await client.request<BusinessFactView>({
    method: 'PATCH',
    path: `${base(organizationSlug)}/${encodeURIComponent(factId)}`,
    body: edit,
  });
  return data;
}

export async function decideBusinessFact(
  client: ApiClient,
  organizationSlug: string,
  factId: string,
  decision: BusinessFactDecision,
): Promise<BusinessFactView> {
  const { data } = await client.request<BusinessFactView>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(factId)}/${decision}`,
  });
  return data;
}
