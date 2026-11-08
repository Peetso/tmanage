'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, StatusDot } from '@tmanage/ui';
import type { StatusTone } from '@tmanage/ui';
import { useTOr } from '../../lib/i18n/use-t-or';
import type { ApiClient } from '../../lib/api/client';
import { codeLinkLine, listCodeLinks, removeCodeLink } from '../../lib/api/github-repos';
import type { CodeLink } from '../../lib/api/github-repos';
import './pm-import.css';

export interface WorkItemCodeLinksProps {
  organizationSlug: string;
  workItemId: string;
  api: ApiClient;
}

function linkState(link: CodeLink): { tone: StatusTone; key: string; english: string } {
  if (link.kind === 'pr') {
    if (link.state === 'merged')
      return { tone: 'success', key: 'WorkItemCodeLinks.merged', english: 'Merged' };
    if (link.state === 'closed')
      return { tone: 'neutral', key: 'WorkItemCodeLinks.closed', english: 'Closed' };
    return { tone: 'neutral', key: 'WorkItemCodeLinks.open', english: 'Open' };
  }
  if (link.kind === 'commit')
    return { tone: 'neutral', key: 'WorkItemCodeLinks.commit', english: 'Commit' };
  return { tone: 'neutral', key: 'WorkItemCodeLinks.branch', english: 'Branch' };
}

/**
 * **Work item · Code** (R45 L3, 54-10; Figma "Work item · Code links"). The branches, commits and
 * pull requests GitHub linked to this item by its key (`GET …/work-items/:id/code-links`,
 * `work.read`); Remove drops one (`work.update`). Renders nothing while there is none, so an item
 * in a project without GitHub carries no empty panel.
 */
export function WorkItemCodeLinks({ organizationSlug, workItemId, api }: WorkItemCodeLinksProps) {
  const tOr = useTOr();
  const queryClient = useQueryClient();
  const key = ['work-item-code-links', organizationSlug, workItemId];
  const links = useQuery({
    queryKey: key,
    queryFn: () => listCodeLinks(api, organizationSlug, workItemId),
  });
  const remove = useMutation({
    mutationFn: (linkId: string) => removeCodeLink(api, organizationSlug, workItemId, linkId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
  const rows = links.data?.links ?? [];
  if (rows.length === 0) return null;
  const workKey = links.data?.workKey ?? null;

  return (
    <section className="tm-pmi__panel" aria-labelledby={`tm-code-${workItemId}`}>
      <h2 className="tm-pmi__title" id={`tm-code-${workItemId}`}>
        {tOr('WorkItemCodeLinks.title', 'Code')}
      </h2>
      {workKey !== null ? (
        <p className="tm-pmi__muted">
          {`${tOr('WorkItemCodeLinks.body', 'Branches, commits and pull requests that mention')} ${workKey}`}
        </p>
      ) : null}
      <ul className="tm-pmi__list">
        {rows.map((link) => {
          const state = linkState(link);
          return (
            <li key={link.id} className="tm-pmi__repo">
              <div className="tm-pmi__repo-head">
                <a
                  className="tm-pmi__mono tm-pmi__link"
                  href={link.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  dir="ltr"
                >
                  {codeLinkLine(link)}
                </a>
                <Button
                  tone="text"
                  loading={remove.isPending && remove.variables === link.id}
                  loadingLabel={tOr('WorkItemCodeLinks.removing', 'Removing')}
                  aria-label={`${tOr('WorkItemCodeLinks.remove', 'Remove')} ${codeLinkLine(link)}`}
                  onClick={() => remove.mutate(link.id)}
                >
                  {tOr('WorkItemCodeLinks.remove', 'Remove')}
                </Button>
              </div>
              <div className="tm-pmi__row">
                <StatusDot tone={state.tone}>{tOr(state.key, state.english)}</StatusDot>
                <span className="tm-pmi__mono tm-pmi__muted" dir="ltr">
                  {link.repo}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
