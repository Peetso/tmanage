'use client';

import { useId, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@tmanage/ui';
import { instantiateProjectTemplate } from '../../lib/api/project-templates';
import type { ProjectTemplateView } from '../../lib/api/project-templates';
import { createProject, listWorkspaces } from '../../lib/api/projects';
import type { ProjectSummary } from '../../lib/api/projects';
import { listClientOrganizationOptions, setProjectClient } from '../../lib/api/project-client';
import { listMembers } from '../../lib/api/members';
import type { ApiClient } from '../../lib/api/client';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import {
  ChipDate,
  ChipSelect,
  describeA9Error,
  orbInitials,
  shortDay,
  useEscape,
  type TOr,
} from './EditMilestoneDialog';
import './templates-milestones.css';
import { PROJECT_NAME_MAX } from '@tmanage/domain';

/** The "Blank project" choice: no template, a plain project. */
const BLANK = '';

/** "4 milestones · 18 work items · client portal on" / "Repeats every month · 6 work items". */
export function templateMeta(template: ProjectTemplateView, tOr: TOr): string {
  // Arabic counts take the plural for 3–10 and the singular from 11 on, so each count has two keys;
  // in English both read the same.
  const few = (n: number) => n >= 3 && n <= 10;
  const parts: string[] = [];
  if (template.repeatInterval === 'monthly') {
    parts.push(tOr('NewFromTemplate.repeatsMonthly', 'Repeats every month'));
  } else {
    const n = template.milestoneCount;
    parts.push(
      (few(n)
        ? tOr('NewFromTemplate.milestonesFew', '{n} milestones')
        : tOr('NewFromTemplate.milestones', '{n} milestones')
      ).replace('{n}', String(n)),
    );
  }
  const items = template.workItemCount;
  parts.push(
    (few(items)
      ? tOr('NewFromTemplate.workItemsFew', '{n} work items')
      : tOr('NewFromTemplate.workItems', '{n} work items')
    ).replace('{n}', String(items)),
  );
  if (template.clientPortalOn) {
    parts.push(tOr('NewFromTemplate.portalOn', 'client portal on'));
  }
  return parts.join(' · ');
}

/** Today as 'YYYY-MM-DD' in the reader's own calendar. */
function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface NewProjectFromTemplateDialogProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly templates: readonly ProjectTemplateView[];
  /** The template picked when the dialog opens; the first one when absent. */
  readonly initialTemplateId?: string;
  readonly onClose: () => void;
  /** Called with the new project; the default opens it. */
  readonly onCreated?: (project: ProjectSummary) => void;
}

/**
 * **New project from a template** (Figma `fq6-new-from-template`): the organization's templates as
 * choices (name, "4 milestones · 18 work items · client portal on" / "Repeats every month"), plus
 * "Blank project / Start with nothing"; Project name; Client, Start date and Lead chips; Cancel /
 * Create project. Milestones, work items and client settings are copied and their dates move to the
 * start date — the API does that in one transaction.
 */
export function NewProjectFromTemplateDialog({
  api,
  organizationSlug,
  templates,
  initialTemplateId,
  onClose,
  onCreated,
}: NewProjectFromTemplateDialogProps) {
  const tOr = useTOr();
  const locale = useActiveLocale();
  const titleId = useId();
  const nameId = useId();
  useEscape(onClose);

  const [templateId, setTemplateId] = useState(initialTemplateId ?? templates[0]?.id ?? BLANK);
  const [name, setName] = useState('');
  const [clientId, setClientId] = useState('');
  const [startDate, setStartDate] = useState(today);
  const [leadUserId, setLeadUserId] = useState('');

  const workspaces = useQuery({
    queryKey: ['workspaces', organizationSlug],
    queryFn: () => listWorkspaces(api, organizationSlug),
  });
  const clients = useQuery({
    queryKey: ['client-organization-options', organizationSlug],
    queryFn: () => listClientOrganizationOptions(api, organizationSlug),
  });
  const members = useQuery({
    queryKey: ['members', organizationSlug, 'a9'],
    queryFn: () => listMembers(api, organizationSlug, { limit: 200 }),
  });

  const workspaceId = workspaces.data?.[0]?.id;
  const chosenClient = clients.data?.find((option) => option.id === clientId);
  const lead = members.data?.members.find((member) => member.userId === leadUserId);

  const create = useMutation({
    mutationFn: async (): Promise<ProjectSummary> => {
      if (!workspaceId) throw new Error('no workspace');
      if (templateId !== BLANK) {
        return instantiateProjectTemplate(api, organizationSlug, templateId, {
          workspaceId,
          name: name.trim(),
          startDate,
          ...(clientId === '' ? {} : { clientOrganizationId: clientId }),
          ...(leadUserId === '' ? {} : { leadUserId }),
        });
      }
      const project = await createProject(api, organizationSlug, {
        workspaceId,
        name: name.trim(),
        ...(leadUserId === '' ? {} : { ownerUserId: leadUserId }),
      });
      if (clientId !== '') await setProjectClient(api, organizationSlug, project.id, clientId);
      return project;
    },
    onSuccess: (project) => {
      if (onCreated) onCreated(project);
      else
        window.location.assign(
          `/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(project.id)}`,
        );
    },
  });

  const canCreate = name.trim() !== '' && workspaceId !== undefined && !create.isPending;

  const choices: readonly { id: string; label: string; meta: string }[] = [
    ...templates.map((template) => ({
      id: template.id,
      label: template.name,
      meta: templateMeta(template, tOr),
    })),
    {
      id: BLANK,
      label: tOr('NewFromTemplate.blank', 'Blank project'),
      meta: tOr('NewFromTemplate.blankMeta', 'Start with nothing'),
    },
  ];

  return (
    <div className="tm-command-palette__backdrop">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="tm-a9-dialog">
        <h2 id={titleId} className="tm-a9-dialog__title">
          {tOr('NewFromTemplate.title', 'New project from a template')}
        </h2>
        <p className="tm-a9-dialog__lede">
          {tOr(
            'NewFromTemplate.lede',
            'Milestones, work items and client settings are copied. Dates move to your start date.',
          )}
        </p>

        <form
          className="tm-a9-form"
          aria-labelledby={titleId}
          onSubmit={(event) => {
            event.preventDefault();
            if (canCreate) create.mutate();
          }}
        >
          <fieldset className="tm-a9-choices">
            <legend className="tm-visually-hidden">
              {tOr('NewFromTemplate.templatesLegend', 'Template')}
            </legend>
            {choices.map((choice) => {
              const on = choice.id === templateId;
              return (
                <label
                  key={choice.id || 'blank'}
                  className={`tm-a9-choice${on ? ' tm-a9-choice--on' : ''}`}
                >
                  <input
                    type="radio"
                    name="template"
                    value={choice.id}
                    checked={on}
                    onChange={() => setTemplateId(choice.id)}
                  />
                  <span className="tm-a9-choice__text">
                    <span className="tm-a9-choice__name">{choice.label}</span>
                    <span className="tm-a9-choice__meta">{choice.meta}</span>
                  </span>
                  {on ? (
                    <span className="tm-a9-choice__check" aria-hidden="true">
                      ✓
                    </span>
                  ) : null}
                </label>
              );
            })}
          </fieldset>

          <div className="tm-a9-field">
            <label className="tm-a9-label" htmlFor={nameId}>
              {tOr('NewFromTemplate.projectName', 'Project name')}
            </label>
            <input
              id={nameId}
              className="tm-a9-input"
              name="name"
              value={name}
              maxLength={PROJECT_NAME_MAX}
              required
              dir="auto"
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="tm-a9-chips">
            <ChipSelect
              label={tOr('NewFromTemplate.client', 'Client')}
              value={clientId}
              display={chosenClient?.name ?? tOr('NewFromTemplate.noClient', 'No client')}
              onChange={setClientId}
            >
              <option value="">{tOr('NewFromTemplate.noClient', 'No client')}</option>
              {(clients.data ?? []).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </ChipSelect>
            <ChipDate
              label={tOr('NewFromTemplate.startDate', 'Start date')}
              value={startDate}
              display={shortDay(startDate, locale)}
              onChange={(value) => setStartDate(value === '' ? today() : value)}
            />
            <ChipSelect
              label={tOr('NewFromTemplate.lead', 'Lead')}
              value={leadUserId}
              display={lead?.displayName ?? tOr('NewFromTemplate.you', 'You')}
              orb={lead ? orbInitials(lead.displayName) : null}
              onChange={setLeadUserId}
            >
              <option value="">{tOr('NewFromTemplate.you', 'You')}</option>
              {(members.data?.members ?? []).map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.displayName}
                </option>
              ))}
            </ChipSelect>
          </div>

          {create.isError ? (
            <p className="tm-a9-error" role="alert">
              {describeA9Error(create.error, tOr)}
            </p>
          ) : null}

          <div className="tm-a9-footer">
            <Button
              type="button"
              tone="outline"
              size="feature"
              className="tm-a9-btn"
              onClick={onClose}
            >
              {tOr('NewFromTemplate.cancel', 'Cancel')}
            </Button>
            <Button
              type="submit"
              tone="ink"
              size="feature"
              className="tm-a9-btn"
              disabled={!canCreate}
              loading={create.isPending}
              loadingLabel={tOr('NewFromTemplate.creating', 'Creating…')}
            >
              {tOr('NewFromTemplate.create', 'Create project')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
