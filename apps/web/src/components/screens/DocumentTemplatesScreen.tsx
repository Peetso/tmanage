'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  applyDocumentTemplate,
  createDocumentTemplate,
  listDocumentTemplates,
} from '../../lib/api/document-templates';
import { listProjects } from '../../lib/api/projects';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { useHydrated } from '../../lib/use-hydrated';
import type { ApiClient } from '../../lib/api/client';

export interface DocumentTemplatesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **DOC-04 template gallery + ADM-06 document templates.**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Docs DOC-04 (template gallery/editor — purpose-led
 * previews) and §Administration ADM-06 (templates/workflows — document templates). This screen is
 * disjoint from the DOC-01 hub/read screens and the DOC-02/03 editor: it owns the org-scoped
 * templates a person creates once and reuses. It lists them with their purpose (the DOC-04
 * "purpose-led preview"), creates one, and applies one to a project — which creates a new document
 * seeded from the template body, from then on an ordinary document.
 *
 * ## What it does, and what it cannot
 *
 * - **Apply never edits the template.** The API reads the template and creates a fresh document; the
 *   template is unchanged and can be applied again. The screen links straight to the new document's
 *   editor so the applied copy can be worked on.
 * - **Variables/placeholders are not substituted.** DOC-04's advanced variable substitution and
 *   per-template permissions are deferred (NEXT-SCOPES-11); a template body is applied verbatim.
 * - **People are shown by id.** No endpoint resolves a member id to a display name here, the honesty
 *   the editor and workload screens apply to the same gap.
 */
export function DocumentTemplatesScreen({
  organizationSlug,
  organizationName,
  client,
}: DocumentTemplatesScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const templates = useQuery({
    queryKey: ['document-templates', organizationSlug],
    queryFn: () => listDocumentTemplates(api, organizationSlug),
  });

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  // The standing `useHydrated` barrier (see PolicySimulationScreen): these controlled inputs ship
  // disabled in the server render and enable once React is live, so text typed before hydration
  // cannot sit in the DOM while state stays empty and leaves Create template disabled for good.
  const hydrated = useHydrated();
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [body, setBody] = useState('');
  const [projectId, setProjectId] = useState('');
  const [applied, setApplied] = useState<{ id: string; title: string } | null>(null);

  const available = projects.data ?? [];
  const chosenProjectId = projectId !== '' ? projectId : (available[0]?.id ?? '');

  const create = useMutation({
    mutationFn: () =>
      createDocumentTemplate(api, organizationSlug, {
        name: name.trim(),
        purpose: purpose.trim(),
        body,
      }),
    onSuccess: async () => {
      setName('');
      setPurpose('');
      setBody('');
      await queryClient.invalidateQueries({
        queryKey: ['document-templates', organizationSlug],
      });
    },
  });

  const apply = useMutation({
    mutationFn: (templateId: string) =>
      applyDocumentTemplate(api, organizationSlug, templateId, { projectId: chosenProjectId }),
    onSuccess: (document) => {
      setApplied({ id: document.id, title: document.title });
    },
  });

  const rows = templates.data ?? [];
  const canCreate =
    name.trim() !== '' && purpose.trim() !== '' && body.trim() !== '' && !create.isPending;
  const canApply = chosenProjectId !== '';

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="docs"
      title="Document templates"
      description="Reusable starting points your team can apply to a project to create a new document."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-tpl-new-heading">
        <h2 id="tm-tpl-new-heading" className="tm-eyebrow">
          New template
        </h2>
        <form
          className="tm-stack"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (canCreate) create.mutate();
          }}
        >
          <fieldset className="tm-fieldset tm-stack" disabled={!hydrated}>
            <Field
              label="Name"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              hint="A short handle, such as Project kickoff brief."
              required
            />
            <Field
              label="Purpose"
              name="purpose"
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
              hint="One line saying what this template is for. Shown in the gallery."
              required
            />
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-tpl-body">
                Template body
                <span className="tm-field__required" aria-hidden="true">
                  *
                </span>
              </label>
              <textarea
                id="tm-tpl-body"
                name="body"
                className="tm-field__control tm-field__control--multiline"
                rows={10}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                aria-describedby="tm-tpl-body-hint"
                required
              />
              <span className="tm-field__hint" id="tm-tpl-body-hint">
                The text a new document starts from. Applying a template copies this into a fresh
                document; the template itself is never changed.
              </span>
            </div>

            {create.isError ? (
              <InlineAlert tone="danger" title="Could not create the template" live>
                {describeError(create.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-row">
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
            </div>
          </fieldset>
        </form>
      </section>

      <section
        className="tm-panel tm-panel--quiet tm-stack"
        aria-labelledby="tm-tpl-gallery-heading"
      >
        <h2 id="tm-tpl-gallery-heading" className="tm-eyebrow">
          Template gallery
        </h2>

        {applied ? (
          <InlineAlert tone="success" title="Document created from the template" live>
            <p className="tm-prose">
              <Link href={`/${organizationSlug}/docs/${applied.id}/edit`}>
                Open &ldquo;{applied.title}&rdquo;
              </Link>{' '}
              to edit the new document. The template is unchanged.
            </p>
          </InlineAlert>
        ) : null}

        {available.length > 0 ? (
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-tpl-project">
              Apply to project
            </label>
            <select
              id="tm-tpl-project"
              className="tm-field__control"
              value={chosenProjectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              {available.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <span className="tm-field__hint">
              Applying a template creates a new document in this project.
            </span>
          </div>
        ) : null}

        {templates.isError ? (
          <InlineAlert tone="danger" title="Could not load the templates" live>
            {describeError(templates.error)}
          </InlineAlert>
        ) : null}

        {apply.isError ? (
          <InlineAlert tone="danger" title="Could not apply that template" live>
            {describeError(apply.error)}
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
            Create a template above. Once you have one, you can apply it to a project to start a new
            document from it.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <div
            className="tm-table-scroll"
            // A scrollable region must be focusable or a keyboard cannot reach its overflow
            // columns (WCAG 2.2 2.1.1), matching the other screens' tables.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Document templates"
          >
            <table className="tm-table">
              <caption className="tm-visually-hidden">
                Your organization&rsquo;s document templates, {rows.length} shown.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Purpose</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((template) => (
                  <tr key={template.id}>
                    <th scope="row" className="tm-table__title">
                      {template.name}
                    </th>
                    <td>{template.purpose}</td>
                    <td>
                      <Button
                        type="button"
                        tone="outline"
                        size="accessible"
                        loading={apply.isPending && apply.variables === template.id}
                        loadingLabel="Applying"
                        disabled={!canApply}
                        onClick={() => apply.mutate(template.id)}
                      >
                        Apply
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {!projects.isPending && available.length === 0 ? (
          <InlineAlert tone="neutral" title="No projects yet">
            A template is applied to a project. Once a project exists, an Apply button appears on
            each template.
          </InlineAlert>
        ) : null}
      </section>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
