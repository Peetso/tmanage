'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import { browserApiClient } from '../../lib/api/browser-client';
import { defineFileTag, listFileTags } from '../../lib/api/file-tags';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface FileTagsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
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
  const describe = useDescribeApiError();
  const t = useT();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);
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
          ref={firstStep}
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
            <TeachingEmptyState
              title={t('teachEmpty.fileTagsTitle')}
              explanation={t('teachEmpty.fileTagsBody')}
              action={
                canUse('file.upload') ? (
                  <Button
                    tone="lime"
                    size="accessible"
                    onClick={() => focusFirstField(firstStep.current)}
                  >
                    {t('teachEmpty.fileTagsAction')}
                  </Button>
                ) : undefined
              }
              helpSlug="upload-and-share-files"
              helpLabel={t('EmptyStates.howFilesWork')}
            />
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
