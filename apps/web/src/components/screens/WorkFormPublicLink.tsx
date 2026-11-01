'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { publishWorkForm, unpublishWorkForm, type WorkFormSummary } from '../../lib/api/work-forms';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';
import '../../styles/screens/work-forms-public.css';

export interface WorkFormPublicLinkProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly form: WorkFormSummary;
}

/** The address a visitor opens. The origin is the page's own, so a copied link always works. */
export function publicFormUrl(slug: string): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}/f/${slug}`;
}

/**
 * 2026-10-31 live-test fix — share an intake form on a public link, copy it, open it, stop sharing.
 *
 * Figma: "Forms · Public link (2026-10-31 live-test fix)" 446:36140 — three states: shared
 * (446:36141), not shared (446:36171), link copied (446:36183). The API's publish/unpublish routes
 * existed (52-20) but nothing on screen reached them.
 */
export function WorkFormPublicLink({ api, organizationSlug, form }: WorkFormPublicLinkProps) {
  const t = useT();
  const describeError = useDescribeApiError();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const change = useMutation({
    mutationFn: (share: boolean) =>
      share
        ? publishWorkForm(api, organizationSlug, form.id)
        : unpublishWorkForm(api, organizationSlug, form.id),
    onSuccess: async () => {
      setCopied(false);
      await queryClient.invalidateQueries({ queryKey: ['work-forms', organizationSlug] });
    },
  });

  const shared = form.published && form.publicSlug !== null;
  const url = shared && form.publicSlug !== null ? publicFormUrl(form.publicSlug) : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // No clipboard permission: the link text is selectable (user-select: all) as the fallback.
      setCopied(false);
    }
  };

  return (
    <section className="wf-link" aria-labelledby="wf-link-title">
      <div className="wf-link__header">
        <h3 id="wf-link-title" className="wf-link__title">
          {t('WorkFormsPublic.title')}
        </h3>
        <Badge tone={shared ? 'client' : 'neutral'}>
          {shared ? t('WorkFormsPublic.shared') : t('WorkFormsPublic.notShared')}
        </Badge>
      </div>

      {shared ? (
        <>
          {copied ? null : <p className="wf-link__body">{t('WorkFormsPublic.sharedBody')}</p>}
          <div className="wf-link__url" aria-label={t('WorkFormsPublic.linkLabel')}>
            {url}
          </div>
          <div className="wf-link__actions">
            <Button tone="ink" size="compact" onClick={() => void copy()}>
              {copied ? t('WorkFormsPublic.copied') : t('WorkFormsPublic.copy')}
            </Button>
            <a
              className="tm-button tm-button--outline tm-button--default"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('WorkFormsPublic.open')}
            </a>
            <Button
              tone="text"
              loading={change.isPending}
              loadingLabel={t('WorkFormsPublic.stopping')}
              onClick={() => change.mutate(false)}
            >
              {t('WorkFormsPublic.stop')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="wf-link__body">{t('WorkFormsPublic.notSharedBody')}</p>
          <div className="wf-link__actions">
            <Button
              tone="ink"
              size="compact"
              loading={change.isPending}
              loadingLabel={t('WorkFormsPublic.sharing')}
              onClick={() => change.mutate(true)}
            >
              {t('WorkFormsPublic.share')}
            </Button>
          </div>
        </>
      )}

      {change.isError ? (
        <InlineAlert tone="danger" title={t('WorkFormsPublic.changeError')} live>
          {describeError(change.error)}
        </InlineAlert>
      ) : null}
    </section>
  );
}
