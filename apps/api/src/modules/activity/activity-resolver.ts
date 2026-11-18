import { authorize, type ActivitySource, type Capability, type Principal } from '@tmanage/domain';
import type { ActivitySourceFacts, FactSource } from './activity.repository.js';

/**
 * 62-A2 (B02) — the one place an activity entry's source is turned into a read decision.
 *
 * The feed's parent (the project or the client) is authorised first by the service. This file then
 * answers, per entry, the question the source's own screen would answer: may this person read the
 * row the entry is about, as it is now? Each source names the capability its read route and service
 * use, and the resource is built from the row's current project, audience and client — so an entry
 * about an internal task is invisible to a guest without that task's project, exactly as the task
 * is. A finance entry also needs `finance.view` (52-23 §10), whatever its source.
 *
 * Lifecycle is not passed: deleted rows never reach here (the fact reads exclude them, and a missing
 * row drops its entry), and an archived row is readable history for an internal reader.
 */

/** The capability each source's read path checks (controller + service), mirrored here. */
export const SOURCE_READ_CAPABILITY: Readonly<Record<ActivitySource, Capability>> = {
  project: 'work.read',
  project_membership: 'work.read',
  work_item: 'work.read',
  time_log: 'work.read',
  file_asset: 'file.download',
  deliverable: 'work.read',
  approval: 'approval.read',
  project_milestone: 'work.read',
  client_request: 'client_request.triage',
  client_invoice: 'finance.view',
  quote: 'finance.view',
  expense: 'finance.view',
};

export const FINANCE_READ_CAPABILITY: Capability = 'finance.view';

/** Where an entry's read facts come from: a membership is read through its project's row. */
export function factSourceOf(source: ActivitySource): FactSource {
  return source === 'project_membership' ? 'project' : source;
}

/** The id to look the facts up by: the object, or the project for a membership. */
export function factKeyOf(
  source: ActivitySource,
  entry: { readonly objectId: string; readonly projectId: string | null },
): string | null {
  return source === 'project_membership' ? entry.projectId : entry.objectId;
}

export function mayReadEntry(
  principal: Principal,
  organizationId: string,
  source: ActivitySource,
  finance: boolean,
  facts: ActivitySourceFacts,
): boolean {
  const resource = {
    organizationId,
    projectId: facts.projectId,
    audience: facts.audience,
    ...(facts.clientOrganizationId === null
      ? {}
      : { clientOrganizationId: facts.clientOrganizationId }),
  };
  const allowed = (capability: Capability) =>
    authorize({ principal, capability, resource }).allowed;
  if (!allowed(SOURCE_READ_CAPABILITY[source])) return false;
  return !finance || allowed(FINANCE_READ_CAPABILITY);
}
