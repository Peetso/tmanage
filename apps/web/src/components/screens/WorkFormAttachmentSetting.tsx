'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { hasCapability, isInternalRole } from '@tmanage/domain';
import { Button, InlineAlert, Select, Switch } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import type { ProjectSummary } from '../../lib/api/projects';
import { setWorkFormAttachments, type WorkFormSummary } from '../../lib/api/work-forms';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useOrganizationSummary } from '../projects/NewProjectLink';
import { withIsolates } from '../../lib/i18n/with-isolates';
import { FeatureOn } from '../shell/FeatureOn';

/** The visitor limit the helper states; the API's `PUBLIC_FORM_UPLOAD_LIMITS` enforces it. */
const SIZE_EACH = '25 MB';

/** Who may change a form's settings: the role ceiling that holds `work.create`. The API decides. */
export function canEditWorkForms(role: string | undefined): boolean {
  return role !== undefined && isInternalRole(role) && hasCapability(role, 'work.create');
}

interface Setting {
  readonly enabled: boolean;
  /** `''` while no project is chosen (or the saved one is archived or out of this person's sight). */
  readonly projectId: string;
}

/**
 * The saved setting as the card opens: on/off from `attachmentProjectId`, the picker preselected
 * when that project is still one this person can choose, otherwise on with "Choose a project".
 */
export function savedSetting(
  form: Pick<WorkFormSummary, 'attachmentProjectId'>,
  choosable: readonly Pick<ProjectSummary, 'id'>[],
): Setting {
  const saved = form.attachmentProjectId;
  if (saved === null) return { enabled: false, projectId: '' };
  return {
    enabled: true,
    projectId: choosable.some((project) => project.id === saved) ? saved : '',
  };
}

/** True when Save may be pressed: off, or on with a project chosen. */
export function attachmentSettingReady(setting: Setting): boolean {
  return !setting.enabled || setting.projectId !== '';
}

export interface WorkFormAttachmentSettingProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly form: WorkFormSummary;
  readonly projects: readonly ProjectSummary[];
}

/**
 * 52-20a — the owner's "Let people attach files" switch for a form's public link.
 *
 * Figma: "Intake form attachments (2026-11-17)" 673:37507 — off (673:37508), on with a project
 * (673:37565), on without one (673:37631); AR 673:37701 / 673:37758 / 673:37826. Save sends
 * `PUT …/attachments` with the project, or `null` when off; the server re-checks the project.
 * Hidden while the `public_forms` rollout flag is off (52-24): the API refuses the route then.
 */
export function WorkFormAttachmentSetting(props: WorkFormAttachmentSettingProps) {
  return (
    <FeatureOn organizationSlug={props.organizationSlug} flag="public_forms">
      <WorkFormAttachmentCard {...props} />
    </FeatureOn>
  );
}

function WorkFormAttachmentCard({
  api,
  organizationSlug,
  form,
  projects,
}: WorkFormAttachmentSettingProps) {
  const t = useTOr();
  const describeError = useDescribeApiError();
  const queryClient = useQueryClient();
  const role = useOrganizationSummary(organizationSlug, api)?.role;
  const [draft, setDraft] = useState<Setting | null>(null);

  const save = useMutation({
    mutationFn: (setting: Setting) =>
      setWorkFormAttachments(
        api,
        organizationSlug,
        form.id,
        setting.enabled ? setting.projectId : null,
      ),
    onSuccess: async (reply) => {
      const listKey = ['work-forms', organizationSlug];
      queryClient.setQueryData<readonly WorkFormSummary[]>(listKey, (forms) =>
        forms?.map((row) =>
          row.id === form.id ? { ...row, attachmentProjectId: reply.attachmentProjectId } : row,
        ),
      );
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: listKey });
    },
  });

  if (!canEditWorkForms(role)) return null;

  const live = projects.filter((project) => project.archivedAt === null);
  const setting = draft ?? savedSetting(form, live);
  const change = (patch: Partial<Setting>) => {
    save.reset();
    setDraft({ ...setting, ...patch });
  };

  return (
    <section className="wf-link wf-files" aria-labelledby="wf-files-title">
      <h3 id="wf-files-title" className="wf-link__title">
        {t('WorkFormAttachments.title', 'Attachments')}
      </h3>
      <Switch
        label={t('WorkFormAttachments.toggle', 'Let people attach files')}
        checked={setting.enabled}
        onChange={(event) => change({ enabled: event.target.checked })}
      />
      <p className="wf-link__body">
        {withIsolates(
          t(
            'WorkFormAttachments.helper',
            'Up to 5 images or PDFs, {size} each. Every file is checked for viruses before you can open it.',
          ),
          { size: SIZE_EACH },
        )}
      </p>

      {setting.enabled ? (
        <>
          <Select
            label={t('WorkFormAttachments.saveTo', 'Save files to')}
            hint={
              setting.projectId === ''
                ? undefined
                : t('WorkFormAttachments.projectHint', 'The files appear in this project’s Files.')
            }
            value={setting.projectId}
            onChange={(event) => change({ projectId: event.target.value })}
          >
            <option value="" disabled>
              {t('WorkFormAttachments.choose', 'Choose a project')}
            </option>
            {live.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
          {setting.projectId === '' ? (
            <InlineAlert tone="neutral">
              {t(
                'WorkFormAttachments.needProject',
                'Choose a project so the files have a place to go.',
              )}
            </InlineAlert>
          ) : null}
        </>
      ) : null}

      {form.attachmentProjectId !== null && !form.published ? (
        <p className="wf-link__body">
          {t(
            'WorkFormAttachments.notShared',
            'People can attach files once the form has a public link.',
          )}
        </p>
      ) : null}

      <div className="wf-link__actions">
        <Button
          tone="ink"
          size="compact"
          loading={save.isPending}
          loadingLabel={t('WorkFormAttachments.saving', 'Saving')}
          disabled={!attachmentSettingReady(setting)}
          onClick={() => save.mutate(setting)}
        >
          {t('WorkFormAttachments.save', 'Save')}
        </Button>
      </div>

      {save.isSuccess ? (
        <InlineAlert tone="success" title={t('WorkFormAttachments.saved', 'Saved')} live>
          {setting.enabled
            ? t('WorkFormAttachments.savedOn', 'People can now attach files to this form.')
            : t('WorkFormAttachments.savedOff', 'People can no longer attach files to this form.')}
        </InlineAlert>
      ) : null}
      {save.isError ? (
        <InlineAlert
          tone="danger"
          title={t('WorkFormAttachments.saveError', 'Could not save the attachment setting')}
          live
        >
          {describeError(save.error)}
        </InlineAlert>
      ) : null}
    </section>
  );
}
