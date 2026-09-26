'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Announce, Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { createSavedView, listSavedViews, updateSavedView } from '../../lib/api/work-views';
import type { SavedViewInput, SavedViewView } from '../../lib/api/work-views';
import { savedViewKeys } from '../../lib/query-keys';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface WorkSavedViewsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **WK-08 Saved view editor.**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Work WK-08: a person names, saves and re-applies a
 * filter/grouping/columns configuration over the Work views, and may share it with their studio.
 * This screen is the editor the plan names: a form to create or re-save a view, a list of the
 * views the caller may see (their own plus the studio's shared ones), and a "Load" action that
 * fills the form from a saved view so it can be re-applied or edited.
 *
 * ## What it persists, and what "apply" means here
 *
 * - **The configuration is the view.** A view remembers its columns (and, optionally, a group-by
 *   field); the server stores it verbatim as JSON and echoes it back. This slice adds no
 *   server-side filtering — apply is the client reading the config back to drive the existing
 *   Work list/board reads (WK-04/WK-06), which is why the form shows the config rather than a
 *   live grid.
 * - **Only the owner edits.** The list marks a shared view a colleague owns as read-only; loading
 *   it fills the form to *copy*, and the API refuses a save against a view the caller does not own.
 * - **Scope is optional.** A view is scoped to one project or is org-wide ("All projects").
 */
export function WorkSavedViewsScreen({
  organizationSlug,
  organizationName,
  client,
}: WorkSavedViewsScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [shared, setShared] = useState(false);
  const [columnsText, setColumnsText] = useState('');
  const [grouping, setGrouping] = useState('');

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  const savedViews = useQuery({
    queryKey: savedViewKeys.list(organizationSlug),
    queryFn: () => listSavedViews(api, organizationSlug),
  });

  const save = useMutation({
    mutationFn: async (): Promise<SavedViewView> => {
      const input: SavedViewInput = {
        projectId: projectId === '' ? null : projectId,
        name: name.trim(),
        shared,
        config: {
          filters: [],
          grouping: grouping.trim() === '' ? null : grouping.trim(),
          columns: columnsText
            .split(',')
            .map((column) => column.trim())
            .filter((column) => column !== ''),
        },
      };
      return editingId === null
        ? createSavedView(api, organizationSlug, input)
        : updateSavedView(api, organizationSlug, editingId, input);
    },
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: savedViewKeys.all(organizationSlug) });
      resetForm();
    },
  });

  const projectNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const project of projects.data ?? []) names.set(project.id, project.name);
    return names;
  }, [projects.data]);

  const rows = savedViews.data ?? [];
  const canSave = name.trim() !== '' && !save.isPending;

  function resetForm() {
    setEditingId(null);
    setName('');
    setProjectId('');
    setShared(false);
    setColumnsText('');
    setGrouping('');
  }

  function loadIntoForm(view: SavedViewView) {
    setEditingId(view.id);
    setName(view.name);
    setProjectId(view.projectId ?? '');
    setShared(view.shared);
    setColumnsText(view.config.columns.join(', '));
    setGrouping(view.config.grouping ?? '');
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title="Saved views"
      description="Name and re-apply a filter, grouping and columns configuration for your work."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-saved-view-editor">
        <h2 id="tm-saved-view-editor" className="tm-eyebrow">
          {editingId === null ? 'New saved view' : 'Edit saved view'}
        </h2>

        <form
          className="tm-stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) save.mutate();
          }}
        >
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-saved-view-name">
              Name
            </label>
            <input
              id="tm-saved-view-name"
              className="tm-field__control"
              value={name}
              maxLength={300}
              required
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-saved-view-project">
              Project
            </label>
            <select
              id="tm-saved-view-project"
              className="tm-field__control"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">All projects (org-wide)</option>
              {(projects.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <span className="tm-field__hint">
              Scope the view to one project, or leave it org-wide.
            </span>
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-saved-view-columns">
              Columns
            </label>
            <input
              id="tm-saved-view-columns"
              className="tm-field__control"
              value={columnsText}
              placeholder="title, state, due"
              onChange={(event) => setColumnsText(event.target.value)}
            />
            <span className="tm-field__hint">
              A comma-separated list of column names, in order.
            </span>
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-saved-view-grouping">
              Group by
            </label>
            <input
              id="tm-saved-view-grouping"
              className="tm-field__control"
              value={grouping}
              placeholder="Optional — e.g. state"
              onChange={(event) => setGrouping(event.target.value)}
            />
          </div>

          <label className="tm-choice tm-choice--inline">
            <input
              className="tm-choice__input"
              type="checkbox"
              checked={shared}
              onChange={(event) => setShared(event.target.checked)}
            />
            <span className="tm-choice__name">Share with everyone in this studio</span>
          </label>

          {save.isError ? (
            <InlineAlert tone="danger" title="Could not save the view" live>
              {describeError(save.error)}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              disabled={!canSave}
              loading={save.isPending}
              loadingLabel="Saving"
            >
              {editingId === null ? 'Save view' : 'Save changes'}
            </Button>
            {editingId !== null ? (
              <Button tone="outline" size="accessible" onClick={resetForm}>
                Cancel edit
              </Button>
            ) : null}
          </div>
        </form>
      </section>

      <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-saved-view-list">
        <h2 id="tm-saved-view-list" className="tm-eyebrow">
          Your saved views
        </h2>

        {savedViews.isError ? (
          <InlineAlert tone="danger" title="Could not load your saved views" live>
            {describeError(savedViews.error)}
          </InlineAlert>
        ) : null}

        {savedViews.isPending ? (
          <LoadingRegion label="Loading your saved views.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!savedViews.isPending && !savedViews.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title="No saved views yet">
            Save a configuration above and it will appear here for you to re-apply.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <ul className="tm-list tm-stack">
            {rows.map((view) => (
              <li key={view.id} className="tm-row tm-row--wrap">
                <div className="tm-stack tm-stack--tight">
                  <strong>{view.name}</strong>
                  <span className="tm-field__hint">
                    {view.projectId === null
                      ? 'All projects'
                      : (projectNames.get(view.projectId) ?? view.projectId)}
                    {view.shared ? ' · Shared' : ' · Private'}
                    {view.config.columns.length > 0
                      ? ` · ${view.config.columns.join(', ')}`
                      : ' · No columns set'}
                  </span>
                </div>
                <Button tone="outline" size="accessible" onClick={() => loadIntoForm(view)}>
                  Load
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <Announce message={save.isSuccess ? 'Saved view stored.' : ''} />
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
