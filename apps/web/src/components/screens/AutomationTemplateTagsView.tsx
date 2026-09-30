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
        Tags
      </h2>
      <p className="tm-muted">
        Label this template so it can be grouped and found. A tag is added or removed, not edited.
      </p>

      <form
        className="tm-stack"
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (canAdd) add.mutate();
        }}
      >
        <Field
          label="Tag"
          name="label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          hint="A short label, such as onboarding or urgent."
          required
        />

        {add.isError ? (
          <InlineAlert tone="danger" title="Could not add the tag" live>
            {describeError(add.error)}
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={add.isPending}
            loadingLabel="Adding"
            disabled={!canAdd}
          >
            Add tag
          </Button>
        </div>
      </form>

      {tags.isError ? (
        <InlineAlert tone="danger" title="Could not load the tags" live>
          {describeError(tags.error)}
        </InlineAlert>
      ) : null}

      {tags.isPending ? (
        <LoadingRegion label="Loading the tags.">
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!tags.isPending && !tags.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="No tags yet">
          Add a tag above to categorise this template.
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <ul className="tm-chip-list" aria-label="Template tags">
          {rows.map((tag) => (
            <li key={tag.id} className="tm-chip">
              <span className="tm-chip__label">{tag.label}</span>
              <Button
                type="button"
                tone="text"
                size="compact"
                onClick={() => remove.mutate(tag.id)}
                loading={remove.isPending && remove.variables === tag.id}
                loadingLabel="Removing"
                aria-label={`Remove tag ${tag.label}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {remove.isError ? (
        <InlineAlert tone="danger" title="Could not remove the tag" live>
          {describeError(remove.error)}
        </InlineAlert>
      ) : null}

      <h3 className="tm-eyebrow">Filter templates by tag</h3>
      <form
        className="tm-stack"
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (canFilter) setFilterLabel(filterInput.trim());
        }}
      >
        <Field
          label="Tag to filter by"
          name="filter"
          value={filterInput}
          onChange={(event) => setFilterInput(event.target.value)}
          hint="Show every template carrying this label."
        />
        <div className="tm-row">
          <Button type="submit" tone="ink" size="accessible" disabled={!canFilter}>
            Filter
          </Button>
        </div>
      </form>

      {filter.isError ? (
        <InlineAlert tone="danger" title="Could not filter the templates" live>
          {describeError(filter.error)}
        </InlineAlert>
      ) : null}

      {filterLabel !== null &&
      !filter.isPending &&
      !filter.isError &&
      filteredTemplates.length === 0 ? (
        <InlineAlert tone="neutral" title="No templates with that tag">
          No template carries the label &ldquo;{filterLabel}&rdquo;.
        </InlineAlert>
      ) : null}

      {filteredTemplates.length > 0 ? (
        <ul className="tm-list" aria-label={`Templates tagged ${filterLabel ?? ''}`}>
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

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
