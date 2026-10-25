'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import {
  addItemLink,
  listItemLinks,
  removeItemLink,
  type WorkItemLink,
  type WorkItemLinkType,
} from '../../lib/api/work-items';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface WorkItemDependenciesScreenProps {
  organizationSlug: string;
  workItemId: string;
  api: ApiClient;
}

const LINK_TYPES: readonly { readonly value: WorkItemLinkType; readonly label: string }[] = [
  { value: 'blocks', label: 'Blocks' },
  { value: 'blocked_by', label: 'Blocked by' },
  { value: 'relates', label: 'Relates to' },
];

function labelForType(type: WorkItemLinkType): string {
  return LINK_TYPES.find((option) => option.value === type)?.label ?? type;
}

/**
 * **x204 — a work item's dependencies / typed links.** (Work module 7; the audit's "Work built; no
 * dependency model between items".)
 *
 * The relationship graph the detail screen needs: link this item to another as *blocks*, *blocked
 * by*, or *relates to*; see the links in order; remove one. Self-links, duplicates and blocking
 * cycles are refused by the server (400) and the refusal is shown plainly; the target must be a work
 * item the caller can see (a cross-tenant id is a 404).
 *
 * It is mounted additively beside the rest of the detail screen and reads its own query, so it
 * neither depends on nor changes the work item's own read. Every write invalidates that query.
 */
export function WorkItemDependenciesScreen({
  organizationSlug,
  workItemId,
  api,
}: WorkItemDependenciesScreenProps) {
  const describe = useDescribeApiError();
  const t = useT();
  const queries = useQueryClient();
  const queryKey = ['work-item-links', organizationSlug, workItemId] as const;
  const [toWorkItemId, setToWorkItemId] = useState('');
  const [linkType, setLinkType] = useState<WorkItemLinkType>('blocks');
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const links = useQuery({
    queryKey,
    queryFn: () => listItemLinks(api, organizationSlug, workItemId),
  });

  function refresh() {
    void queries.invalidateQueries({ queryKey });
  }

  const add = useMutation({
    mutationFn: (input: { toWorkItemId: string; linkType: WorkItemLinkType }) =>
      addItemLink(api, organizationSlug, workItemId, input),
    onSuccess: () => {
      setToWorkItemId('');
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  const remove = useMutation({
    mutationFn: (link: WorkItemLink) => removeItemLink(api, organizationSlug, workItemId, link.id),
    onSuccess: () => {
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = toWorkItemId.trim();
    if (trimmed === '') return;
    add.mutate({ toWorkItemId: trimmed, linkType });
  }

  const items = links.data ?? [];

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-work-links">
      <h2 id="tm-work-links" className="tm-eyebrow">
        {t('WorkItemDependenciesScreen.heading')}
      </h2>

      {links.isPending ? (
        <LoadingRegion label={t('WorkItemDependenciesScreen.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {links.isError ? (
        <InlineAlert tone="danger" title={t('WorkItemDependenciesScreen.loadError')} live>
          {describe(links.error)}
        </InlineAlert>
      ) : null}

      {failure ? (
        <InlineAlert tone="danger" title={t('WorkItemDependenciesScreen.failureTitle')} live>
          {failure}
        </InlineAlert>
      ) : null}

      {links.data ? (
        items.length === 0 ? (
          <p className="tm-prose">{t('WorkItemDependenciesScreen.empty')}</p>
        ) : (
          <ul className="tm-list" aria-label={t('WorkItemDependenciesScreen.listLabel')}>
            {items.map((link) => (
              <li key={link.id} className="tm-row tm-row--between">
                <span className="tm-prose">
                  <strong>{labelForType(link.linkType)}</strong> {link.toWorkItemTitle}{' '}
                  <span className="tm-muted">({link.toWorkItemState})</span>
                </span>
                <Button
                  tone="text"
                  size="accessible"
                  loading={remove.isPending}
                  loadingLabel={t('WorkItemDependenciesScreen.removing')}
                  onClick={() => remove.mutate(link)}
                >
                  {t('WorkItemDependenciesScreen.remove')}
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : null}

      <form className="tm-stack" noValidate onSubmit={submit}>
        <Select
          label={t('WorkItemDependenciesScreen.relationship')}
          name="linkType"
          value={linkType}
          onChange={(event) => setLinkType(event.target.value as WorkItemLinkType)}
          hint={t('WorkItemDependenciesScreen.relationshipHint')}
        >
          {LINK_TYPES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        <Field
          label={t('WorkItemDependenciesScreen.linkedId')}
          name="toWorkItemId"
          value={toWorkItemId}
          onChange={(event) => setToWorkItemId(event.target.value)}
          hint={t('WorkItemDependenciesScreen.linkedIdHint')}
        />
        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={add.isPending}
            loadingLabel={t('WorkItemDependenciesScreen.adding')}
            disabled={toWorkItemId.trim() === ''}
          >
            {t('WorkItemDependenciesScreen.addLink')}
          </Button>
        </div>
      </form>
    </section>
  );
}
