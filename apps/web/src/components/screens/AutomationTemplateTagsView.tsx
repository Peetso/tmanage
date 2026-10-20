'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  addAutomationTemplateTag,
  listAutomationTemplateTags,
  listTemplatesByTag,
  removeAutomationTemplateTag,
} from '../../lib/api/automation-template-tags';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';

export interface AutomationTemplateTagsViewProps {
  organizationSlug: string;
  templateId: string;
  client?: ApiClient;
}

/**
 * **Automations & integrations (module 17, x335).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Automations & integrations ("template organisation").
 * A **tag** is a short free-text label on a workflow template, so a studio can categorise its
 * automation templates and find them by label. This surface belongs on the template detail: it lists
 * a template's tags as chips, adds one, removes one, and offers a tag filter that lists the org's
 * templates carrying a label. Every route is gated on the server by `org.manage`, so a member without
 * the capability sees the API's refusal rather than a blank page.
 *
 * ## What it does, and what it cannot
 *
 * - **A tag is added and removed, never edited.** The API grants INSERT and DELETE only — a re-label
 *   is a remove and a re-add — so there is no edit control.
 * - **Duplicates and blanks are the server's answer.** A label already on the template is the API's
 *   409, an empty or over-length label its 400; the form surfaces those rather than pre-empting them.
 */
export function AutomationTemplateTagsView({
  organizationSlug,
  templateId,
  client,
}: AutomationTemplateTagsViewProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const tagsKey = ['automation-template-tags', organizationSlug, templateId];

  const tags = useQuery({
    queryKey: tagsKey,
    queryFn: () => listAutomationTemplateTags(api, organizationSlug, templateId),
  });

  const [label, setLabel] = useState('');
  const rows = tags.data ?? [];

  const add = useMutation({
    mutationFn: () =>
      addAutomationTemplateTag(api, organizationSlug, templateId, { label: label.trim() }),
    onSuccess: async () => {
      setLabel('');
      await queryClient.invalidateQueries({ queryKey: tagsKey });
    },
  });

  const remove = useMutation({
    mutationFn: (tagId: string) =>
      removeAutomationTemplateTag(api, organizationSlug, templateId, tagId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: tagsKey });
    },
  });

  const [filterInput, setFilterInput] = useState('');
  const [filterLabel, setFilterLabel] = useState<string | null>(null);
  const filter = useQuery({
    queryKey: ['automation-templates-by-tag', organizationSlug, filterLabel],
    queryFn: () => listTemplatesByTag(api, organizationSlug, filterLabel ?? ''),
    enabled: filterLabel !== null,
  });
  const filteredTemplates = filter.data ?? [];

  const canAdd = label.trim() !== '' && !add.isPending;
  const canFilter = filterInput.trim() !== '';

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-automation-template-tags-heading">
      <h2 id="tm-automation-template-tags-heading" className="tm-eyebrow">
        {t('AutomationTemplateTagsView.heading')}
      </h2>
      <p className="tm-muted">{t('AutomationTemplateTagsView.lede')}</p>

      <form
        className="tm-stack"
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (canAdd) add.mutate();
        }}
      >
        <Field
          label={t('AutomationTemplateTagsView.tagLabel')}
          name="label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          hint={t('AutomationTemplateTagsView.tagHint')}
          required
        />

        {add.isError ? (
          <InlineAlert tone="danger" title={t('AutomationTemplateTagsView.errorAddTitle')} live>
            {describeError(t, add.error)}
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={add.isPending}
            loadingLabel={t('AutomationTemplateTagsView.adding')}
            disabled={!canAdd}
          >
            {t('AutomationTemplateTagsView.addButton')}
          </Button>
        </div>
      </form>

      {tags.isError ? (
        <InlineAlert tone="danger" title={t('AutomationTemplateTagsView.errorLoadTitle')} live>
          {describeError(t, tags.error)}
        </InlineAlert>
      ) : null}

      {tags.isPending ? (
        <LoadingRegion label={t('AutomationTemplateTagsView.loadingLabel')}>
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!tags.isPending && !tags.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title={t('AutomationTemplateTagsView.emptyTitle')}>
          {t('AutomationTemplateTagsView.emptyBody')}
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <ul className="tm-chip-list" aria-label={t('AutomationTemplateTagsView.tagsListLabel')}>
          {rows.map((tag) => (
            <li key={tag.id} className="tm-chip">
              <span className="tm-chip__label">{tag.label}</span>
              <Button
                type="button"
                tone="text"
                size="compact"
                onClick={() => remove.mutate(tag.id)}
                loading={remove.isPending && remove.variables === tag.id}
                loadingLabel={t('AutomationTemplateTagsView.removing')}
                aria-label={`${t('AutomationTemplateTagsView.removeTag')} ${tag.label}`}
              >
                {t('AutomationTemplateTagsView.remove')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {remove.isError ? (
        <InlineAlert tone="danger" title={t('AutomationTemplateTagsView.errorRemoveTitle')} live>
          {describeError(t, remove.error)}
        </InlineAlert>
      ) : null}

      <h3 className="tm-eyebrow">{t('AutomationTemplateTagsView.filterHeading')}</h3>
      <form
        className="tm-stack"
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (canFilter) setFilterLabel(filterInput.trim());
        }}
      >
        <Field
          label={t('AutomationTemplateTagsView.filterFieldLabel')}
          name="filter"
          value={filterInput}
          onChange={(event) => setFilterInput(event.target.value)}
          hint={t('AutomationTemplateTagsView.filterFieldHint')}
        />
        <div className="tm-row">
          <Button type="submit" tone="ink" size="accessible" disabled={!canFilter}>
            {t('AutomationTemplateTagsView.filterButton')}
          </Button>
        </div>
      </form>

      {filter.isError ? (
        <InlineAlert tone="danger" title={t('AutomationTemplateTagsView.errorFilterTitle')} live>
          {describeError(t, filter.error)}
        </InlineAlert>
      ) : null}

      {filterLabel !== null &&
      !filter.isPending &&
      !filter.isError &&
      filteredTemplates.length === 0 ? (
        <InlineAlert tone="neutral" title={t('AutomationTemplateTagsView.noMatchTitle')}>
          {t('AutomationTemplateTagsView.noMatchPrefix')} &ldquo;{filterLabel}&rdquo;.
        </InlineAlert>
      ) : null}

      {filteredTemplates.length > 0 ? (
        <ul
          className="tm-list"
          aria-label={`${t('AutomationTemplateTagsView.templatesTagged')} ${filterLabel ?? ''}`}
        >
          {filteredTemplates.map((template) => (
            <li key={template.id} className="tm-list__item">
              {template.name}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function describeError(t: ReturnType<typeof useT>, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('AutomationTemplateTagsView.errorApiUnreachable');
  return t('AutomationTemplateTagsView.errorGeneric');
}
