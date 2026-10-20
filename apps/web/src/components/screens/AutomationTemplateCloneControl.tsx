'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { cloneWorkflowTemplate, type WorkflowTemplateSummary } from '../../lib/api/automations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';

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
  const t = useT();

  const [name, setName] = useState(
    `${template.name} (${t('AutomationTemplateCloneControl.copySuffix')})`,
  );

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
        {t('AutomationTemplateCloneControl.heading')}
      </h2>
      <p className="tm-muted">
        {t('AutomationTemplateCloneControl.createCopyPrefix')} <strong>{template.name}</strong>
        {t('AutomationTemplateCloneControl.createCopySuffix')}
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
          label={t('AutomationTemplateCloneControl.nameLabel')}
          name="cloneName"
          value={name}
          onChange={(event) => setName(event.target.value)}
          hint={t('AutomationTemplateCloneControl.nameHint')}
          required
        />

        {clone.isError ? (
          <InlineAlert
            tone="danger"
            title={t('AutomationTemplateCloneControl.errorCloneTitle')}
            live
          >
            {describeError(t, clone.error)}
          </InlineAlert>
        ) : null}

        {clone.isSuccess ? (
          <InlineAlert tone="success" title={t('AutomationTemplateCloneControl.successTitle')} live>
            {t('AutomationTemplateCloneControl.successBody')}
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={clone.isPending}
            loadingLabel={t('AutomationTemplateCloneControl.cloning')}
            disabled={!canClone}
          >
            {t('AutomationTemplateCloneControl.duplicate')}
          </Button>
        </div>
      </form>
    </section>
  );
}

function describeError(t: ReturnType<typeof useT>, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('AutomationTemplateCloneControl.errorApiUnreachable');
  return t('AutomationTemplateCloneControl.errorGeneric');
}
