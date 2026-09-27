'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { cloneWorkflowTemplate, type WorkflowTemplateSummary } from '../../lib/api/automations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface AutomationTemplateCloneControlProps {
  organizationSlug: string;
  /** The template being duplicated. Its trigger/action/config are copied server-side. */
  template: WorkflowTemplateSummary;
  client?: ApiClient;
}

/**
 * **Automations & integrations (module 17, x219) — clone a workflow template.**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Automations & integrations. Define (x162) and edit
 * (x189) exist; this control adds the missing duplicate step — the starting point for a variant of an
 * existing automation. A distinct file from the edit screen: it is a small inline control that lives
 * alongside a listed template, not a full-page form.
 *
 * The server does the real work and enforces the rules this control cannot: `org.manage` (a caller
 * without it is a 403), the source id is tenant-scoped before any write (a cross-tenant id is a 404),
 * and a duplicate name is a 409. The clone copies only the source's behaviour into a fresh row and
 * always comes back **disabled** — so a duplicated automation never begins firing on creation; the
 * operator enables it deliberately afterwards via the edit screen. This control simply collects the
 * new name, defaulting it to `"<source name> (copy)"`, and surfaces the server's refusals.
 */
export function AutomationTemplateCloneControl({
  organizationSlug,
  template,
  client,
}: AutomationTemplateCloneControlProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const [name, setName] = useState(`${template.name} (copy)`);

  const clone = useMutation({
    mutationFn: () =>
      cloneWorkflowTemplate(api, organizationSlug, template.id, { name: name.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['workflow-templates', organizationSlug] });
    },
  });

  const canClone = name.trim() !== '' && !clone.isPending;

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-automation-clone-heading">
      <h2 id="tm-automation-clone-heading" className="tm-eyebrow">
        Duplicate template
      </h2>
      <p className="tm-muted">
        Create a disabled copy of <strong>{template.name}</strong>. Enable it from the edit screen
        once you have adjusted it.
      </p>
      <form
        className="tm-stack"
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (canClone) clone.mutate();
        }}
      >
        <Field
          label="New template name"
          name="cloneName"
          value={name}
          onChange={(event) => setName(event.target.value)}
          hint="Must be unique within the organization."
          required
        />

        {clone.isError ? (
          <InlineAlert tone="danger" title="Could not clone the template" live>
            {describeError(clone.error)}
          </InlineAlert>
        ) : null}

        {clone.isSuccess ? (
          <InlineAlert tone="success" title="Template duplicated" live>
            The copy was created and is disabled. Enable it from the edit screen when it is ready.
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={clone.isPending}
            loadingLabel="Cloning"
            disabled={!canClone}
          >
            Duplicate
          </Button>
        </div>
      </form>
    </section>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
