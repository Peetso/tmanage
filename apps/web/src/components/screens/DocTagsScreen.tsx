'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { defineDocTag, listDocTags } from '../../lib/api/doc-tags';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface DocTagsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

/**
 * **x269 — document tags / labels.** (Docs module.)
 *
 * The org-defined tag taxonomy the module map calls for (durable context, findability — DOC-01 hub
 * filtering): define a reusable tag (a short name) once, then tag documents with it elsewhere. This
 * screen owns the definitions — list them and define a new one; both routes are gated on the server by
 * `doc.write` (define) and `doc.read` (list), so a member without the capability sees the API's
 * refusal rather than a blank page. It also offers the docs-hub tag filter: toggling the chips narrows
 * the hub to documents carrying the chosen tags. Assigning a tag to a specific document is the
 * document detail screen's job, via the paired `assignDocumentTag` helper.
 */
export function DocTagsScreen({ organizationSlug, organizationName, client }: DocTagsScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const queryKey = ['doc-tags', organizationSlug] as const;

  const [name, setName] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<readonly string[]>([]);

  const tags = useQuery({
    queryKey,
    queryFn: () => listDocTags(api, organizationSlug),
  });

  const define = useMutation({
    mutationFn: () => defineDocTag(api, organizationSlug, { name: name.trim() }),
    onSuccess: async () => {
      setName('');
      setFailure(undefined);
      await queries.invalidateQueries({ queryKey });
    },
    onError: (error) => setFailure(describe(error)),
  });

  const rows = useMemo(() => tags.data ?? [], [tags.data]);
  const canDefine = name.trim() !== '' && !define.isPending;

  function toggle(tagId: string): void {
    setSelected((current) =>
      current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId],
    );
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Document tags"
      description="Define reusable tags, then tag documents and filter the hub by them."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-doc-tag-new-heading">
        <h2 id="tm-doc-tag-new-heading" className="tm-eyebrow">
          New tag
        </h2>
        <form
          className="tm-stack"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (canDefine) define.mutate();
          }}
        >
          <Field
            label="Name"
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            hint="A short handle, such as Runbook or Onboarding."
            required
          />

          {failure ? (
            <InlineAlert tone="danger" title="Could not define the tag" live>
              {failure}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={define.isPending}
              loadingLabel="Saving"
              disabled={!canDefine}
            >
              Define tag
            </Button>
          </div>
        </form>
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-doc-tag-filter-heading">
        <h2 id="tm-doc-tag-filter-heading" className="tm-eyebrow">
          Filter documents by tag
        </h2>
        {tags.isPending ? (
          <LoadingRegion label="Loading this studio’s tags.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {tags.isError ? (
          <InlineAlert tone="danger" title="Could not load the tags" live>
            {describe(tags.error)}
          </InlineAlert>
        ) : null}

        {tags.data ? (
          rows.length === 0 ? (
            <p className="tm-prose">No tags defined yet.</p>
          ) : (
            <ul
              className="tm-row tm-row--wrap"
              style={{ listStyle: 'none', padding: 0, margin: 0 }}
            >
              {rows.map((tag) => {
                const active = selected.includes(tag.id);
                return (
                  <li key={tag.id}>
                    <button
                      type="button"
                      className="tm-badge"
                      aria-pressed={active}
                      data-active={active ? 'true' : undefined}
                      onClick={() => toggle(tag.id)}
                    >
                      {tag.name}
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        ) : null}
      </section>
    </AppShell>
  );
}
