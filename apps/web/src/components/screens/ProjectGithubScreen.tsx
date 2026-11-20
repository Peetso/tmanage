'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton, StatusDot } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { useTOr } from '../../lib/i18n/use-t-or';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { browserApiClient } from '../../lib/api/browser-client';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import {
  REPO_FULL_NAME,
  hooksForProject,
  linkRepo,
  listRepoHooks,
  unlinkRepo,
} from '../../lib/api/github-repos';
import type { GithubRepoHookSecret } from '../../lib/api/github-repos';
import './pm-import.css';

export interface ProjectGithubScreenProps {
  organizationSlug: string;
  organizationName: string;
  projectId: string;
  client?: ApiClient;
}

/**
 * **Project settings · GitHub** (R45 L3, 54-10; Figma R45 L3 section) over the existing Phase 0
 * backend: the repositories whose webhook routes into this project, link (one webhook per
 * repository; the payload URL and secret are shown once) and unlink. Commits, branches and pull
 * requests that mention a work item key show on that item (`WorkItemCodeLinks`). Owner/admin
 * only on the server (`org.manage`); a member sees the API's refusal.
 */
export function ProjectGithubScreen({
  organizationSlug,
  organizationName,
  projectId,
  client,
}: ProjectGithubScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);
  const formatters = useDisplayFormatters();
  const describeError = useDescribeApiError();
  const queryClient = useQueryClient();
  const [repo, setRepo] = useState('');
  const [linked, setLinked] = useState<GithubRepoHookSecret | null>(null);
  const key = ['github-repo-hooks', organizationSlug];

  const hooks = useQuery({ queryKey: key, queryFn: () => listRepoHooks(api, organizationSlug) });
  const link = useMutation({
    mutationFn: () => linkRepo(api, organizationSlug, repo.trim(), projectId),
    onSuccess: (created) => {
      setLinked(created);
      setRepo('');
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const unlink = useMutation({
    mutationFn: (hookId: string) => unlinkRepo(api, organizationSlug, hookId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });

  const rows = hooksForProject(hooks.data ?? [], projectId);
  const repoValid = REPO_FULL_NAME.test(repo.trim());

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title={tOr('ProjectGithubScreen.title', 'GitHub')}
      description={tOr('ProjectGithubScreen.description', 'Project settings')}
    >
      <div className="tm-pmi">
        <section className="tm-pmi__panel" aria-labelledby="tm-gh-repos">
          <h2 className="tm-pmi__title" id="tm-gh-repos">
            {tOr('ProjectGithubScreen.reposTitle', 'GitHub repositories')}
          </h2>
          <p className="tm-pmi__muted">
            {tOr(
              'ProjectGithubScreen.reposBody',
              'Commits and pull requests that mention a work item key, like WEB-12, show up on that item.',
            )}
          </p>
          {hooks.isError ? (
            <InlineAlert
              tone="danger"
              title={tOr('ProjectGithubScreen.loadError', 'Could not load the repositories')}
              live
            >
              {describeError(hooks.error)}
            </InlineAlert>
          ) : null}
          {hooks.isPending ? (
            <LoadingRegion label={tOr('ProjectGithubScreen.loading', 'Loading repositories')}>
              <Skeleton />
            </LoadingRegion>
          ) : rows.length === 0 && !hooks.isError ? (
            <TeachingEmptyState
              title={tOr('teachEmpty.projectGithubTitle', 'No repository linked yet')}
              explanation={tOr(
                'teachEmpty.projectGithubBody',
                "Link this project's GitHub repository, and your team sees each task's commits and pull requests right on the task.",
              )}
              action={
                canUse('org.manage') ? (
                  <Button
                    tone="lime"
                    size="accessible"
                    onClick={() => focusFirstField(firstStep.current)}
                  >
                    {tOr('teachEmpty.projectGithubAction', 'Link a repository')}
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ul
              className="tm-pmi__list"
              aria-label={tOr('ProjectGithubScreen.listLabel', 'Linked repositories')}
            >
              {rows.map((hook) => (
                <li key={hook.id} className="tm-pmi__repo">
                  <div className="tm-pmi__repo-head">
                    <span className="tm-pmi__mono" dir="ltr">
                      {hook.repoFullName}
                    </span>
                    <Button
                      tone="text"
                      loading={unlink.isPending && unlink.variables === hook.id}
                      loadingLabel={tOr('ProjectGithubScreen.unlinking', 'Unlinking')}
                      aria-label={`${tOr('ProjectGithubScreen.unlink', 'Unlink')} ${hook.repoFullName}`}
                      onClick={() => unlink.mutate(hook.id)}
                    >
                      {tOr('ProjectGithubScreen.unlink', 'Unlink')}
                    </Button>
                  </div>
                  {hook.lastEventAt === null ? (
                    <StatusDot tone="neutral">
                      {tOr('ProjectGithubScreen.noEvents', 'No events yet')}
                    </StatusDot>
                  ) : (
                    <StatusDot tone="success">
                      {`${tOr('ProjectGithubScreen.active', 'Active · last event')} ${formatters.dateTime(hook.lastEventAt)}`}
                    </StatusDot>
                  )}
                </li>
              ))}
            </ul>
          )}
          {unlink.isError ? (
            <InlineAlert
              tone="danger"
              title={tOr('ProjectGithubScreen.unlinkError', 'Could not unlink')}
              live
            >
              {describeError(unlink.error)}
            </InlineAlert>
          ) : null}
          <form
            noValidate
            ref={firstStep}
            className="tm-pmi__list"
            onSubmit={(event) => {
              event.preventDefault();
              if (repoValid && !link.isPending) link.mutate();
            }}
          >
            <Field
              label={tOr('ProjectGithubScreen.repo', 'Repository')}
              hint={tOr('ProjectGithubScreen.repoHint', 'One webhook per repository.')}
              placeholder="owner/name"
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              value={repo}
              onChange={(event) => setRepo(event.currentTarget.value)}
            />
            {link.isError ? (
              <InlineAlert
                tone="danger"
                title={tOr('ProjectGithubScreen.linkError', 'Could not link the repository')}
                live
              >
                {describeError(link.error)}
              </InlineAlert>
            ) : null}
            <div className="tm-pmi__row">
              <Button
                tone="ink"
                size="compact"
                type="submit"
                disabled={!repoValid}
                loading={link.isPending}
                loadingLabel={tOr('ProjectGithubScreen.linking', 'Linking')}
              >
                {tOr('ProjectGithubScreen.link', 'Link repository')}
              </Button>
            </div>
          </form>
        </section>

        {linked !== null ? (
          <section className="tm-pmi__panel" aria-labelledby="tm-gh-linked">
            <h2 className="tm-pmi__title" id="tm-gh-linked">
              {tOr('ProjectGithubScreen.linkedTitle', 'Repository linked')}
            </h2>
            <InlineAlert tone="warning" title={tOr('ProjectGithubScreen.onceTitle', 'Shown once')}>
              {tOr('ProjectGithubScreen.once', 'Copy these now. The secret is shown only once.')}
            </InlineAlert>
            <SecretRow
              label={tOr('ProjectGithubScreen.payloadUrl', 'Payload URL')}
              value={linked.webhookUrl}
            />
            <SecretRow label={tOr('ProjectGithubScreen.secret', 'Secret')} value={linked.secret} />
            <div className="tm-pmi__row">
              <Button tone="ink" size="compact" onClick={() => setLinked(null)}>
                {tOr('ProjectGithubScreen.done', 'Done')}
              </Button>
            </div>
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}

function SecretRow({ label, value }: { label: string; value: string }) {
  const tOr = useTOr();
  return (
    <>
      <h3 className="tm-pmi__eyebrow">{label}</h3>
      <div className="tm-pmi__secret">
        <code className="tm-pmi__mono" dir="ltr">
          {value}
        </code>
        <Button
          tone="outline"
          size="compact"
          aria-label={`${tOr('ProjectGithubScreen.copy', 'Copy')} ${label}`}
          onClick={() => void navigator.clipboard?.writeText(value)}
        >
          {tOr('ProjectGithubScreen.copy', 'Copy')}
        </Button>
      </div>
    </>
  );
}
