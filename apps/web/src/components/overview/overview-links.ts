/**
 * ONEPAGE — the full screens each overview block opens. One place, so a block's "Open …" link
 * and the matching tab can never point at two different screens. Every id is encoded.
 */

const segment = encodeURIComponent;

export function projectHref(org: string, projectId: string): string {
  return `/${org}/projects/${segment(projectId)}`;
}

export function projectWorkHref(org: string, projectId: string): string {
  return `/${org}/work?project=${segment(projectId)}`;
}

export function projectDeliverablesHref(org: string, projectId: string): string {
  return `${projectHref(org, projectId)}/deliverables`;
}

export function deliverableHref(org: string, projectId: string, deliverableId: string): string {
  return `${projectDeliverablesHref(org, projectId)}/${segment(deliverableId)}`;
}

export function projectMilestonesHref(org: string, projectId: string): string {
  return `${projectHref(org, projectId)}/milestones`;
}

export function projectRiskRegisterHref(org: string, projectId: string): string {
  return `${projectHref(org, projectId)}/risk-register`;
}

export function projectFilesHref(org: string, projectId: string): string {
  return `/${org}/files?project=${segment(projectId)}`;
}

export function filesHref(org: string): string {
  return `/${org}/files`;
}

export function fileHref(org: string, fileId: string): string {
  return `/${org}/files/${segment(fileId)}`;
}

export function timesheetsHref(org: string): string {
  return `/${org}/finance/timesheets`;
}

export function invoicesHref(org: string): string {
  return `/${org}/finance/invoices`;
}

/** Files & approvals across projects (the More sheet's entry). */
export function approvalsInboxHref(org: string): string {
  return `/${org}/inbox`;
}

export function clientsHref(org: string): string {
  return `/${org}/clients`;
}

export function portfolioHref(org: string): string {
  return `/${org}/projects/portfolio`;
}

/** The client page's tabs live in `?view=`; `at-risk` narrows the Projects tab. */
export type ClientView = 'overview' | 'projects' | 'people';

export function clientViewHref(
  org: string,
  clientOrganizationId: string,
  view: ClientView,
  options: { atRisk?: boolean } = {},
): string {
  const base = `/${org}/clients/${segment(clientOrganizationId)}`;
  if (view === 'overview') return base;
  return `${base}?view=${view}${options.atRisk ? '&health=at-risk' : ''}`;
}

export function parseClientView(value: string | null | undefined): ClientView {
  return value === 'projects' || value === 'people' ? value : 'overview';
}
