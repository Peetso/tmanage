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
import '../../styles/screens/work-planning.css';

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

  const previewColumns = columnsText
    .split(',')
    .map((column) => column.trim())
    .filter((column) => column !== '');

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title="Saved views"
      eyebrow="Work"
    >
      <section className="wp-stack" aria-labelledby="tm-saved-view-list">
        <h2 id="tm-saved-view-list" className="wp-views-title">
          Your saved views
        </h2>

        {savedViews.isError ? (
          <InlineAlert tone="danger" title="Could not load your saved views" live>
            {describeError(savedViews.error)}
          </InlineAlert>
        ) : null}

        {savedViews.isPending ? (
          <LoadingRegion label="Loading your saved views.">
            <Skeleton height="120px" />
          </LoadingRegion>
        ) : null}

        {!savedViews.isPending && !savedViews.isError && rows.length === 0 ? (
          <div className="wp-empty">
            <h3 className="wp-empty__title">No saved views yet</h3>
            <p className="wp-empty__body">
              Save a configuration below and it will appear here for you to re-apply.
            </p>
          </div>
        ) : null}

        {rows.length > 0 ? (
          <ul className="wp-views">
            {rows.map((view) => (
              <li
                key={view.id}
                className={`wp-view-card${view.id === editingId ? ' wp-view-card--lime' : ''}`}
              >
                <span className="wp-view-card__eyebrow">
                  {view.projectId === null
                    ? 'All projects'
                    : (projectNames.get(view.projectId) ?? 'One project')}
                  {view.shared ? ' · Shared' : ' · Private'}
                </span>
                <h3 className="wp-view-card__name">{view.name}</h3>
                <div className="wp-view-card__foot">
                  <span className="wp-view-card__count">{view.config.columns.length}</span>
                  <span className="wp-view-card__meta">
                    {view.config.columns.length > 0
                      ? `${view.config.columns.length === 1 ? 'column' : 'columns'} · ${view.config.columns.join(', ')}`
                      : 'No columns set'}
                    {view.config.grouping ? ` · grouped by ${view.config.grouping}` : ''}
                  </span>
                  <Button tone="outline" size="compact" onClick={() => loadIntoForm(view)}>
                    Load
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="wp-stack" aria-labelledby="tm-saved-view-editor">
        <h2 id="tm-saved-view-editor" className="wp-views-title">
          {editingId === null
            ? 'New saved view'
            : `Edit ${name.trim() === '' ? 'saved view' : name}`}
        </h2>

        <form
          className="wp-editor"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) save.mutate();
          }}
        >
          <div className="wp-editor__main">
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

            {save.isError ? (
              <InlineAlert tone="danger" title="Could not save the view" live>
                {describeError(save.error)}
              </InlineAlert>
            ) : null}
          </div>

          <div className="wp-editor__side">
            <p className="wp-mono-label" aria-hidden="true">
              Columns · {previewColumns.length}
            </p>
            <ul className="wp-colchips" aria-hidden="true">
              {previewColumns.length === 0 ? (
                <li className="wp-colchips__none">None yet</li>
              ) : (
                previewColumns.map((column, index) => <li key={`${column}-${index}`}>{column}</li>)
              )}
            </ul>
            <div className="tm-field">
              <label className="tm-visually-hidden" htmlFor="tm-saved-view-columns">
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

            <p className="wp-mono-label" aria-hidden="true">
              Sharing
            </p>
            <label className="wp-share">
              <input
                type="checkbox"
                checked={shared}
                onChange={(event) => setShared(event.target.checked)}
              />
              <span>Share with everyone in this studio</span>
            </label>

            <div className="wp-editor__buttons">
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
          </div>
        </form>
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
