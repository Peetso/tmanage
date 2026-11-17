'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  WORK_LABEL_COLORS,
  defineWorkLabel,
  listWorkLabels,
  type WorkLabelColor,
} from '../../lib/api/work-labels';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface WorkLabelsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **x233 — work item labels / tags.** (Work module 7.)
 *
 * The org-scoped label taxonomy the audit found missing: define a reusable label (a name and a colour
 * from a fixed palette) once, then tag work items with it elsewhere. This screen owns the definitions
 * — list them and define a new one; both routes are gated on the server by `work.update` (define) and
 * `work.read` (list), so a member without the capability sees the API's refusal rather than a blank
 * page. Assigning a label to a specific item is the work-item detail screen's job, via
 * {@link WorkItemLabelChips}.
 */
export function WorkLabelsScreen({
  organizationSlug,
  organizationName,
  client,
}: WorkLabelsScreenProps) {
  const describe = useDescribeApiError();
  const t = useT();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const queryKey = ['work-labels', organizationSlug] as const;

  const [name, setName] = useState('');
  const [color, setColor] = useState<WorkLabelColor>(WORK_LABEL_COLORS[0]);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const labels = useQuery({
    queryKey,
    queryFn: () => listWorkLabels(api, organizationSlug),
  });

  const define = useMutation({
    mutationFn: () => defineWorkLabel(api, organizationSlug, { name: name.trim(), color }),
    onSuccess: async () => {
      setName('');
      setColor(WORK_LABEL_COLORS[0]);
      setFailure(undefined);
      await queries.invalidateQueries({ queryKey });
    },
    onError: (error) => setFailure(describe(error)),
  });

  const rows = labels.data ?? [];
  const canDefine = name.trim() !== '' && !define.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title={t('WorkLabelsScreen.title')}
      description={t('WorkLabelsScreen.description')}
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-work-label-new-heading">
        <h2 id="tm-work-label-new-heading" className="tm-eyebrow">
          {t('WorkLabelsScreen.newLabel')}
        </h2>
        <form
          ref={firstStep}
          className="tm-stack"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (canDefine) define.mutate();
          }}
        >
          <Field
            label={t('WorkLabelsScreen.nameLabel')}
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            hint={t('WorkLabelsScreen.nameHint')}
            required
          />

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-work-label-color">
              {t('WorkLabelsScreen.colourLabel')}
            </label>
            <select
              id="tm-work-label-color"
              className="tm-field__control"
              value={color}
              onChange={(event) => setColor(event.target.value as WorkLabelColor)}
            >
              {WORK_LABEL_COLORS.map((option) => (
                <option key={option} value={option}>
                  {option.charAt(0).toUpperCase() + option.slice(1)}
                </option>
              ))}
            </select>
          </div>

          {failure ? (
            <InlineAlert tone="danger" title={t('WorkLabelsScreen.defineError')} live>
              {failure}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={define.isPending}
              loadingLabel={t('WorkLabelsScreen.saving')}
              disabled={!canDefine}
            >
              {t('WorkLabelsScreen.defineLabel')}
            </Button>
          </div>
        </form>
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-work-label-list-heading">
        <h2 id="tm-work-label-list-heading" className="tm-eyebrow">
          {t('WorkLabelsScreen.labelsHeading')}
        </h2>
        {labels.isPending ? (
          <LoadingRegion label={t('WorkLabelsScreen.loading')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {labels.isError ? (
          <InlineAlert tone="danger" title={t('WorkLabelsScreen.loadError')} live>
            {describe(labels.error)}
          </InlineAlert>
        ) : null}

        {labels.data ? (
          rows.length === 0 ? (
            <TeachingEmptyState
              title={t('teachEmpty.workLabelsTitle')}
              explanation={t('teachEmpty.workLabelsBody')}
              action={
                canUse('work.update') ? (
                  <Button
                    tone="lime"
                    size="accessible"
                    onClick={() => focusFirstField(firstStep.current)}
                  >
                    {t('teachEmpty.workLabelsAction')}
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ul
              className="tm-row tm-row--wrap"
              style={{ listStyle: 'none', padding: 0, margin: 0 }}
            >
              {rows.map((label) => (
                <li key={label.id} data-color={label.color} className="tm-badge">
                  {label.name}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>
    </AppShell>
  );
}
