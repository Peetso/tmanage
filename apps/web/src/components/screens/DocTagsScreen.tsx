'use client';

import { useRef, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { defineDocTag, listDocTags } from '../../lib/api/doc-tags';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface DocTagsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
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
  const describe = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);
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
      title={t('DocTagsScreen.title')}
      description={t('DocTagsScreen.description')}
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-doc-tag-new-heading">
        <h2 id="tm-doc-tag-new-heading" className="tm-eyebrow">
          {t('DocTagsScreen.newTag')}
        </h2>
        <form
          ref={firstStep}
          className="tm-stack"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (canDefine) define.mutate();
          }}
        >
          <Field
            label={t('DocTagsScreen.name')}
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            hint={t('DocTagsScreen.nameHint')}
            required
          />

          {failure ? (
            <InlineAlert tone="danger" title={t('DocTagsScreen.defineError')} live>
              {failure}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={define.isPending}
              loadingLabel={t('DocTagsScreen.saving')}
              disabled={!canDefine}
            >
              {t('DocTagsScreen.defineTag')}
            </Button>
          </div>
        </form>
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-doc-tag-filter-heading">
        <h2 id="tm-doc-tag-filter-heading" className="tm-eyebrow">
          {t('DocTagsScreen.filterHeading')}
        </h2>
        {tags.isPending ? (
          <LoadingRegion label={t('DocTagsScreen.loading')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {tags.isError ? (
          <InlineAlert tone="danger" title={t('DocTagsScreen.loadError')} live>
            {describe(tags.error)}
          </InlineAlert>
        ) : null}

        {tags.data ? (
          rows.length === 0 ? (
            <TeachingEmptyState
              title={t('teachEmpty.docTagsTitle')}
              explanation={t('teachEmpty.docTagsBody')}
              action={
                canUse('doc.write') ? (
                  <Button
                    tone="lime"
                    size="accessible"
                    onClick={() => focusFirstField(firstStep.current)}
                  >
                    {t('teachEmpty.docTagsAction')}
                  </Button>
                ) : undefined
              }
            />
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
