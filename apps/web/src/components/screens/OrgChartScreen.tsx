'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { getOrgChart, setReportingManager } from '../../lib/api/reporting-lines';
import type { ReportingLine } from '../../lib/api/reporting-lines';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/people.css';

export interface OrgChartScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** A node of the rendered tree: a member and the members who report to them. */
interface TreeNode {
  readonly membershipId: string;
  readonly reports: readonly TreeNode[];
}

// Defensive: the API rejects cycles before any write, so the edge set is a forest and this depth is
// never reached in practice. It bounds the client build the same way the API bounds its cycle walk.
const MAX_DEPTH = 100;

/**
 * Fold the flat reporting-line edges into a forest. Roots are members who manage someone but report to
 * no one (they never appear as the `membershipId` of a line). The build is bounded by `MAX_DEPTH` and a
 * visited set so a corrupt cycle in the data cannot loop forever.
 */
function buildForest(lines: readonly ReportingLine[]): readonly TreeNode[] {
  const managerOf = new Map<string, string>();
  const reportsTo = new Map<string, string[]>();
  const everyone = new Set<string>();

  for (const line of lines) {
    everyone.add(line.membershipId);
    if (line.managerMembershipId !== null) {
      everyone.add(line.managerMembershipId);
      managerOf.set(line.membershipId, line.managerMembershipId);
      const siblings = reportsTo.get(line.managerMembershipId) ?? [];
      siblings.push(line.membershipId);
      reportsTo.set(line.managerMembershipId, siblings);
    }
  }

  const build = (membershipId: string, depth: number, seen: ReadonlySet<string>): TreeNode => {
    if (depth >= MAX_DEPTH || seen.has(membershipId)) {
      return { membershipId, reports: [] };
    }
    const nextSeen = new Set(seen).add(membershipId);
    const reports = (reportsTo.get(membershipId) ?? [])
      .slice()
      .sort()
      .map((child) => build(child, depth + 1, nextSeen));
    return { membershipId, reports };
  };

  const roots = [...everyone].filter((id) => !managerOf.has(id)).sort();
  return roots.map((id) => build(id, 0, new Set<string>()));
}

/**
 * **Org chart** — PEOPLE / module 14 (x217).
 *
 * `38-MODULE-MAP` §People & capacity: the reporting structure the directory (x168) never recorded —
 * who reports to whom. It reads `GET …/people/org-chart` (gated on the server by `work.read`) and folds
 * the flat reporting-line edges into a tree. A compact form sets or clears one member's manager via
 * `PUT …/people/:membershipId/manager` (gated on `org.manage`); authorization is the API's, so a caller
 * without the capability sees the API's refusal rather than a guessed one.
 */
export function OrgChartScreen({
  organizationSlug,
  organizationName,
  client,
}: OrgChartScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const queryKey = ['org-chart', organizationSlug];

  const chart = useQuery({
    queryKey,
    queryFn: () => getOrgChart(api, organizationSlug),
  });

  const [memberId, setMemberId] = useState('');
  const [managerId, setManagerId] = useState('');

  const save = useMutation({
    mutationFn: (input: { member: string; manager: string | null }) =>
      setReportingManager(api, organizationSlug, input.member, input.manager),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
      setMemberId('');
      setManagerId('');
    },
  });

  const forest = useMemo(() => buildForest(chart.data ?? []), [chart.data]);
  const canSet =
    memberId.trim() !== '' && managerId.trim() !== '' && memberId.trim() !== managerId.trim();
  const canClear = memberId.trim() !== '';

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      eyebrow="People · Org chart"
      title="Org chart"
      description="Who reports to whom — the reporting tree, folded from each member's manager."
    >
      <div className="ppl-screen">
        <div className="ppl-body">
          <div className="ppl-main">
            {chart.isError ? (
              <InlineAlert tone="danger" title="Could not load the org chart" live>
                {describeError(chart.error)}
              </InlineAlert>
            ) : null}

            {chart.isPending ? (
              <LoadingRegion label="Loading the org chart.">
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {chart.data !== undefined && forest.length === 0 ? (
              <section className="ppl-card" aria-label="No reporting lines yet">
                <h2 className="ppl-card__title">No reporting lines yet</h2>
                <p className="ppl-dashed-note">
                  No one has a manager set. Add a reporting line to start the chart.
                </p>
              </section>
            ) : null}

            {forest.length > 0 ? (
              <section className="ppl-card" aria-labelledby="tm-orgchart-tree">
                <h2 id="tm-orgchart-tree" className="ppl-mono">
                  Reporting tree
                </h2>
                <ul className="ppl-tree">
                  {forest.map((node) => (
                    <TreeBranch key={node.membershipId} node={node} />
                  ))}
                </ul>
              </section>
            ) : null}
          </div>

          <div className="ppl-aside ppl-aside--352">
            <section className="ppl-card ppl-card--tight" aria-labelledby="tm-orgchart-set">
              <h2 id="tm-orgchart-set" className="ppl-card__title">
                Set a reporting line
              </h2>
              <form
                className="ppl-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!canSet) return;
                  save.mutate({ member: memberId.trim(), manager: managerId.trim() });
                }}
                noValidate
              >
                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="tm-orgchart-member">
                    Member
                  </label>
                  <input
                    id="tm-orgchart-member"
                    name="member"
                    className="tm-field__control"
                    value={memberId}
                    onChange={(event) => setMemberId(event.target.value)}
                    placeholder="membership id"
                    required
                  />
                </div>
                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="tm-orgchart-manager">
                    Manager
                  </label>
                  <input
                    id="tm-orgchart-manager"
                    name="manager"
                    className="tm-field__control"
                    value={managerId}
                    onChange={(event) => setManagerId(event.target.value)}
                    placeholder="membership id"
                  />
                </div>
                <div className="ppl-button-row">
                  <Button
                    type="submit"
                    tone="ink"
                    size="accessible"
                    disabled={!canSet || save.isPending}
                  >
                    Set manager
                  </Button>
                  <Button
                    type="button"
                    tone="outline"
                    size="accessible"
                    disabled={!canClear || save.isPending}
                    onClick={() => save.mutate({ member: memberId.trim(), manager: null })}
                  >
                    Clear manager
                  </Button>
                </div>
              </form>
              {save.isError ? (
                <InlineAlert tone="danger" title="Could not save the reporting line" live>
                  {describeError(save.error)}
                </InlineAlert>
              ) : null}
            </section>

            <section
              className="ppl-card ppl-card--tight ppl-card--ink"
              aria-labelledby="tm-orgchart-note"
            >
              <h2 id="tm-orgchart-note" className="ppl-mono">
                What a reporting line means
              </h2>
              <p className="ppl-note ppl-note--ink">
                A line records who someone reports to, set on record by someone who may manage the
                organization. Access and approval come from roles, not from the chart.
              </p>
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function TreeBranch({ node }: { node: TreeNode }) {
  return (
    <li>
      <span className="ppl-tree__node">{node.membershipId}</span>
      {node.reports.length > 0 ? (
        <ul>
          {node.reports.map((child) => (
            <TreeBranch key={child.membershipId} node={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
