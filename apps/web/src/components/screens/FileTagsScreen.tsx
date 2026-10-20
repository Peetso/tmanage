'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { useT } from '../../lib/i18n/use-t';
import { browserApiClient } from '../../lib/api/browser-client';
import { defineFileTag, listFileTags } from '../../lib/api/file-tags';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface FileTagsScreenProps {
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
 * **x270 — file tags.** (Files module.)
 *
 * The org-scoped tag taxonomy the audit found missing: define a reusable tag once, then hang it on
 * files so the upload centre can list them by tag. This screen owns the definitions — list them and
 * define a new one; both routes are gated on the server by `file.upload` (define) and `file.download`
 * (list), so a member without the capability sees the API's refusal rather than a blank page.
 * Assigning a tag to a specific file (the tag chips on a file, the upload-centre filter) is the file
 * detail surface's job, via the `assignFileTag` / `removeFileTag` client calls.
 */
export function FileTagsScreen({
  organizationSlug,
  organizationName,
  client,
}: FileTagsScreenProps) {
  const t = useT();
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const queryKey = ['file-tags', organizationSlug] as const;

  const [name, setName] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const tags = useQuery({
    queryKey,
    queryFn: () => listFileTags(api, organizationSlug),
  });

  const define = useMutation({
    mutationFn: () => defineFileTag(api, organizationSlug, { name: name.trim() }),
    onSuccess: async () => {
      setName('');
      setFailure(undefined);
      await queries.invalidateQueries({ queryKey });
    },
    onError: (error) => setFailure(describe(error)),
  });

  const rows = tags.data ?? [];
  const canDefine = name.trim() !== '' && !define.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title={t('FileTagsScreen.title')}
      description={t('FileTagsScreen.description')}
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-file-tag-new-heading">
        <h2 id="tm-file-tag-new-heading" className="tm-eyebrow">
          {t('FileTagsScreen.newTagHeading')}
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
            label={t('FileTagsScreen.nameLabel')}
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            hint={t('FileTagsScreen.nameHint')}
            required
          />

          {failure ? (
            <InlineAlert tone="danger" title={t('FileTagsScreen.defineErrorTitle')} live>
              {failure}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={define.isPending}
              loadingLabel={t('FileTagsScreen.saving')}
              disabled={!canDefine}
            >
              {t('FileTagsScreen.defineButton')}
            </Button>
          </div>
        </form>
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-file-tag-list-heading">
        <h2 id="tm-file-tag-list-heading" className="tm-eyebrow">
          {t('FileTagsScreen.tagsHeading')}
        </h2>
        {tags.isPending ? (
          <LoadingRegion label={t('FileTagsScreen.loadingTags')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {tags.isError ? (
          <InlineAlert tone="danger" title={t('FileTagsScreen.loadErrorTitle')} live>
            {describe(tags.error)}
          </InlineAlert>
        ) : null}

        {tags.data ? (
          rows.length === 0 ? (
            <p className="tm-prose">{t('FileTagsScreen.empty')}</p>
          ) : (
            <ul
              className="tm-row tm-row--wrap"
              style={{ listStyle: 'none', padding: 0, margin: 0 }}
            >
              {rows.map((tag) => (
                <li key={tag.id} className="tm-badge">
                  {tag.name}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>
    </AppShell>
  );
}
