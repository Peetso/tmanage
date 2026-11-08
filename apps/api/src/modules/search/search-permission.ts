import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { mayDownloadFor } from '../files/purpose-policy.js';
import { CLIENT_HIDDEN_INVOICE_STATES } from './search-finance-files.repository.js';
import type { SearchReachScope } from './search-finance-files.repository.js';
import type { SearchAudience, SearchIndexHitRow } from './search-index.repository.js';

/**
 * 53-17 — the per-hit read rule for global search, one function for every kind.
 *
 * A search must never surface a row the row's own read would refuse. Each kind therefore asks
 * exactly what its own module asks:
 *
 * - **work item, document, meeting, decision, project** — `work.read` on the hit's project and
 *   audience (unchanged since SRCH-01).
 * - **message** — `conversation.read` (F22); channel membership is narrowed by the service.
 * - **invoice** — internal: `finance.view` (the client-invoices list gate). Client: a client admin
 *   or member, the invoice's client organization is its own, the invoice is neither draft nor void,
 *   and `client_projection.read` passes — the portal projection, nothing more.
 * - **quote** — internal only, `project.manage` (the quotes list gate).
 * - **expense** — internal only: the caller's own expense, or `finance.manage`, or
 *   `project.manage` on the expense's project (an approver).
 * - **file** — the purpose policy admits the caller's kind, a client must also reach the file
 *   through the files relation (resolved by the service, passed in `fileReach`), then
 *   `file.download` on the file's project, audience and client organization.
 */

const PORTAL_ROLES: ReadonlySet<string> = new Set(['client_admin', 'client_member']);

export interface HitReadFacts {
  /**
   * For a client principal: the audience each file hit is reachable under (by asset id), or null
   * when the files relation refused it. Unset entries are refused.
   */
  readonly fileReach?: ReadonlyMap<string, SearchAudience | null>;
}

function allows(
  principal: Principal,
  capability: Capability,
  projectId: string | null,
  audience: SearchAudience = 'internal',
  clientOrganizationId?: string | null,
): boolean {
  return authorize({
    principal,
    capability,
    resource: {
      organizationId: principal.organizationId,
      projectId,
      audience,
      ...(clientOrganizationId === undefined ? {} : { clientOrganizationId }),
      lifecycle: 'active',
    },
  }).allowed;
}

/** The scan scope: which of the 53-17 kinds are worth reading at all for this caller. */
export function reachScope(principal: Principal): SearchReachScope {
  const internal = principal.kind === 'internal';
  const clientOrg = principal.clientOrganizationId;
  return {
    principalKind: principal.kind,
    clientOrganizationId: clientOrg,
    membershipId: principal.membershipId,
    invoicesInternal: internal && allows(principal, 'finance.view', null),
    invoicesClient:
      principal.kind === 'client' &&
      clientOrg !== null &&
      PORTAL_ROLES.has(principal.role) &&
      allows(principal, 'client_projection.read', null, 'client_visible', clientOrg),
    quotes: internal && allows(principal, 'project.manage', null),
    expenses: internal,
    expensesAll: internal && allows(principal, 'finance.manage', null),
    projectIds: principal.hasOrgWideScope ? null : principal.projectIds,
  };
}

/** Whether this principal may read this hit — see the module comment for each kind's rule. */
export function mayReadHit(
  principal: Principal,
  hit: SearchIndexHitRow,
  facts: HitReadFacts = {},
): boolean {
  // Belt-and-braces to the tenant-scoped SQL: a row from another studio is never readable.
  if (hit.organizationId !== principal.organizationId) return false;
  const internal = principal.kind === 'internal';

  switch (hit.targetKind) {
    case 'message':
      return allows(principal, 'conversation.read', hit.projectId);

    case 'invoice': {
      if (internal) return allows(principal, 'finance.view', null);
      const own = principal.clientOrganizationId;
      return (
        principal.kind === 'client' &&
        own !== null &&
        PORTAL_ROLES.has(principal.role) &&
        hit.clientOrganizationId === own &&
        hit.state !== undefined &&
        !(CLIENT_HIDDEN_INVOICE_STATES as readonly string[]).includes(hit.state) &&
        allows(principal, 'client_projection.read', null, 'client_visible', own)
      );
    }

    case 'quote':
      return internal && allows(principal, 'project.manage', null);

    case 'expense':
      if (!internal) return false;
      if (hit.ownerMembershipId === principal.membershipId) return true;
      if (allows(principal, 'finance.manage', null)) return true;
      return hit.projectId !== null && allows(principal, 'project.manage', hit.projectId);

    case 'file': {
      const asset = hit.asset;
      if (asset === undefined || !mayDownloadFor(principal.kind, asset.purpose)) return false;
      let audience: SearchAudience = asset.audience;
      if (!internal) {
        const reached = facts.fileReach?.get(asset.id);
        if (reached === undefined || reached === null) return false;
        audience = reached;
      }
      return allows(
        principal,
        'file.download',
        asset.projectId,
        audience,
        asset.clientOrganizationId,
      );
    }

    default:
      return allows(principal, 'work.read', hit.projectId, hit.audience);
  }
}
