'use client';

import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  applyAgendaTemplate,
  createAgendaTemplate,
  deleteAgendaTemplate,
  listAgendaTemplates,
} from '../../lib/api/agenda-templates';
import type { ApplyAgendaTemplateResult } from '../../lib/api/agenda-templates';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { CalendarHeaderActions, CalendarSubnav } from './MeetingsScreen';
import '../../styles/screens/calendar.css';

export interface MeetingAgendaTemplatesViewProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **CAL agenda templates (x314).**
 *
 * `38-MODULE-MAP` §Calendar & meetings (agenda templates); `22-SCREEN` §Meeting detail. Complements
 * the per-meeting agenda (x127) with reuse: a member defines a reusable agenda template — a name and
 * an ordered list of items — and applies one to a meeting to seed its agenda items.
 *
 * ## What it draws, and what it cannot
 *
 * - **A tenant's templates** — a template is org-scoped (it names no project), so this reads the
 *   whole tenant's templates behind `meeting.read`, no project picker.
 * - **Creating a template** → `POST .../agenda-templates` behind `meeting.write`. The items are one
 *   title per line; the server assigns each item's position from its order and refuses an empty name
 *   or empty item list (400).
 * - **Deleting a template** → `DELETE .../agenda-templates/:id` behind `meeting.write` (204).
 * - **Applying a template to a meeting** → `POST .../meetings/:meetingId/apply-agenda-template`
 *   behind `meeting.write`. The seed is idempotent: an item whose title is already on the meeting is
 *   skipped, so the result reports how many were newly seeded versus skipped.
 *
 * Editing an existing template in place (the idempotent PUT) is served by the API but not surfaced
 * here — deleting and re-creating is the one edit path this screen draws.
 */
export function MeetingAgendaTemplatesView({
  organizationSlug,
  organizationName,
  client,
}: MeetingAgendaTemplatesViewProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const [name, setName] = useState('');
  const [itemsText, setItemsText] = useState('');

  const [applyTemplateId, setApplyTemplateId] = useState('');
  const [applyMeetingId, setApplyMeetingId] = useState('');
  const [applyResult, setApplyResult] = useState<ApplyAgendaTemplateResult | null>(null);

  const templates = useQuery({
    queryKey: ['agenda-templates', organizationSlug],
    queryFn: () => listAgendaTemplates(api, organizationSlug),
  });

  const parsedItems = useMemo(() => parseItems(itemsText), [itemsText]);

  const create = useMutation({
    mutationFn: () =>
      createAgendaTemplate(api, organizationSlug, {
        name: name.trim(),
        items: parsedItems.map((title) => ({ title })),
      }),
    onSuccess: () => {
      setName('');
      setItemsText('');
      void queries.invalidateQueries({ queryKey: ['agenda-templates', organizationSlug] });
    },
  });

  const remove = useMutation({
    mutationFn: (templateId: string) => deleteAgendaTemplate(api, organizationSlug, templateId),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['agenda-templates', organizationSlug] });
    },
  });

  const apply = useMutation({
    mutationFn: () =>
      applyAgendaTemplate(api, organizationSlug, applyMeetingId.trim(), applyTemplateId),
    onSuccess: (result) => {
      setApplyResult(result);
    },
  });

  const rows = useMemo(() => templates.data?.templates ?? [], [templates.data]);
  const canCreate = name.trim() !== '' && parsedItems.length > 0;
  const canApply = applyTemplateId !== '' && applyMeetingId.trim() !== '';

  function submitCreate(event: FormEvent) {
    event.preventDefault();
    if (!canCreate) return;
    create.mutate();
  }

  function submitApply(event: FormEvent) {
    event.preventDefault();
    if (!canApply) return;
    setApplyResult(null);
    apply.mutate();
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="calendar"
      title="Agenda templates"
      eyebrow="Calendar · Meeting templates"
      actions={<CalendarHeaderActions organizationSlug={organizationSlug} current="none" />}
    >
      <div className="tm-cal">
        <CalendarSubnav organizationSlug={organizationSlug} current="agenda-templates" />

        <div className="tm-cal-body">
          <div className="tm-cal-main">
            {templates.isError ? (
              <InlineAlert tone="danger" title="Could not load the templates" live>
                {describeError(templates.error)}
              </InlineAlert>
            ) : null}

            {templates.isPending ? (
              <LoadingRegion label="Loading the templates.">
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {!templates.isPending && !templates.isError && rows.length === 0 ? (
              <InlineAlert tone="neutral" title="No templates yet">
                You have no agenda templates. Create one beside the list.
              </InlineAlert>
            ) : null}

            {rows.length > 0 ? (
              <ul className="tm-cal-templates" aria-label="Agenda templates">
                {rows.map((row) => (
                  <li key={row.id} className="tm-cal-card">
                    <div className="tm-cal-template__head">
                      <h2 className="tm-cal-template__name">{row.name}</h2>
                      <Button
                        type="button"
                        tone="destructive"
                        size="compact"
                        loading={remove.isPending && remove.variables === row.id}
                        loadingLabel="Removing"
                        onClick={() => remove.mutate(row.id)}
                        aria-label={`Delete ${row.name}`}
                      >
                        Delete
                      </Button>
                    </div>
                    <p className="tm-cal-eyebrow">Agenda sections · {row.items.length}</p>
                    <ol className="tm-cal-items">
                      {row.items.map((item, index) => (
                        <li key={`${row.id}-${index}`} className="tm-cal-item">
                          <span className="tm-cal-orb" aria-hidden="true">
                            {index + 1}
                          </span>
                          <span className="tm-cal-item__body">
                            <span className="tm-cal-item__title">{item.title}</span>
                          </span>
                        </li>
                      ))}
                    </ol>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="tm-cal-side">
            <section className="tm-cal-card" aria-labelledby="tm-agenda-template-create">
              <h2 id="tm-agenda-template-create" className="tm-cal-eyebrow">
                Create a template
              </h2>
              <form className="tm-cal-form" onSubmit={submitCreate}>
                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="tm-agenda-template-name">
                    Name
                  </label>
                  <input
                    id="tm-agenda-template-name"
                    className="tm-field__control"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={300}
                    required
                  />
                </div>
                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="tm-agenda-template-items">
                    Agenda items
                  </label>
                  <textarea
                    id="tm-agenda-template-items"
                    className="tm-field__control"
                    value={itemsText}
                    onChange={(event) => setItemsText(event.target.value)}
                    rows={5}
                  />
                  <span className="tm-field__hint">
                    One item per line, in order. Blank lines are ignored.
                  </span>
                </div>

                {create.isError ? (
                  <InlineAlert tone="danger" title="Could not create the template" live>
                    {create.error instanceof ApiRequestError
                      ? create.error.message
                      : 'The API did not answer. Try again.'}
                  </InlineAlert>
                ) : null}

                <Button
                  type="submit"
                  tone="ink"
                  size="accessible"
                  loading={create.isPending}
                  loadingLabel="Creating"
                  disabled={!canCreate}
                >
                  Create template
                </Button>
              </form>
            </section>

            {rows.length > 0 ? (
              <section className="tm-cal-card" aria-labelledby="tm-agenda-template-apply">
                <h2 id="tm-agenda-template-apply" className="tm-cal-eyebrow">
                  Apply to a meeting
                </h2>
                <form className="tm-cal-form" onSubmit={submitApply}>
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-agenda-template-apply-template">
                      Template
                    </label>
                    <select
                      id="tm-agenda-template-apply-template"
                      className="tm-field__control"
                      value={applyTemplateId}
                      onChange={(event) => setApplyTemplateId(event.target.value)}
                    >
                      <option value="">Choose a template…</option>
                      {rows.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-agenda-template-apply-meeting">
                      Meeting ID
                    </label>
                    <input
                      id="tm-agenda-template-apply-meeting"
                      className="tm-field__control"
                      value={applyMeetingId}
                      onChange={(event) => setApplyMeetingId(event.target.value)}
                    />
                    <span className="tm-field__hint">
                      Applying seeds the meeting&rsquo;s agenda items. Items already present are
                      skipped.
                    </span>
                  </div>

                  {apply.isError ? (
                    <InlineAlert tone="danger" title="Could not apply the template" live>
                      {describeError(apply.error)}
                    </InlineAlert>
                  ) : null}

                  {applyResult ? (
                    <InlineAlert tone="success" title="Template applied" live>
                      Seeded {applyResult.seeded} new item{applyResult.seeded === 1 ? '' : 's'};
                      skipped {applyResult.skipped} already present.
                    </InlineAlert>
                  ) : null}

                  <Button
                    type="submit"
                    tone="ink"
                    size="accessible"
                    loading={apply.isPending}
                    loadingLabel="Applying"
                    disabled={!canApply}
                  >
                    Apply template
                  </Button>
                </form>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function parseItems(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
