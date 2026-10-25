'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import {
  addPersonSkill,
  listPersonSkills,
  removePersonSkill,
  type PersonSkillLevel,
  type PersonSkillSummary,
} from '../../lib/api/people-skills';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface PersonSkillsPanelProps {
  organizationSlug: string;
  membershipId: string;
  api: ApiClient;
}

const LEVELS: readonly { value: PersonSkillLevel; label: string }[] = [
  { value: 'basic', label: 'Basic' },
  { value: 'proficient', label: 'Proficient' },
  { value: 'expert', label: 'Expert' },
];

/**
 * **x172 — a member's declared skills / tags.** (People module 14; the audit's "People Missing →
 * skills".)
 *
 * The smallest useful unit of the skills the People profile named but had not built: add a labelled
 * skill at a proficiency level, see the member's skills in order, remove one. Skill-based matching
 * is a later slice; this panel does add / list / remove and keeps its own query so it neither
 * depends on nor changes the profile's own read. Every write invalidates that query so the list
 * reflects the server rather than an optimistic guess.
 */
export function PersonSkillsPanel({ organizationSlug, membershipId, api }: PersonSkillsPanelProps) {
  const describe = useDescribeApiError();
  const queries = useQueryClient();
  const t = useT();
  const queryKey = ['person-skills', organizationSlug, membershipId] as const;
  const [label, setLabel] = useState('');
  const [level, setLevel] = useState<PersonSkillLevel>('proficient');
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const skills = useQuery({
    queryKey,
    queryFn: () => listPersonSkills(api, organizationSlug, membershipId),
  });

  function refresh() {
    void queries.invalidateQueries({ queryKey });
  }

  const add = useMutation({
    mutationFn: (input: { label: string; level: PersonSkillLevel }) =>
      addPersonSkill(api, organizationSlug, membershipId, input),
    onSuccess: () => {
      setLabel('');
      setLevel('proficient');
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  const remove = useMutation({
    mutationFn: (skill: PersonSkillSummary) =>
      removePersonSkill(api, organizationSlug, membershipId, skill.id),
    onSuccess: () => {
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = label.trim();
    if (trimmed === '') return;
    add.mutate({ label: trimmed, level });
  }

  const items = skills.data ?? [];

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-person-skills">
      <h2 id="tm-person-skills" className="tm-eyebrow">
        {t('PersonSkillsPanel.heading')}
      </h2>

      {skills.isPending ? (
        <LoadingRegion label={t('PersonSkillsPanel.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {skills.isError ? (
        <InlineAlert tone="danger" title={t('PersonSkillsPanel.loadError')} live>
          {describe(skills.error)}
        </InlineAlert>
      ) : null}

      {failure ? (
        <InlineAlert tone="danger" title={t('PersonSkillsPanel.failureTitle')} live>
          {failure}
        </InlineAlert>
      ) : null}

      {skills.data ? (
        items.length === 0 ? (
          <p className="tm-prose">{t('PersonSkillsPanel.empty')}</p>
        ) : (
          <ul className="tm-list" aria-label={t('PersonSkillsPanel.listLabel')}>
            {items.map((skill) => (
              <li key={skill.id} className="tm-row">
                <span>
                  {skill.label} · {skill.level}
                </span>
                <Button
                  type="button"
                  tone="text"
                  size="accessible"
                  loading={remove.isPending && remove.variables?.id === skill.id}
                  loadingLabel={t('PersonSkillsPanel.removing')}
                  onClick={() => remove.mutate(skill)}
                >
                  {t('PersonSkillsPanel.remove')}{' '}
                  <span className="tm-visually-hidden">
                    {t('PersonSkillsPanel.removeSrPrefix')} {skill.label}{' '}
                    {t('PersonSkillsPanel.removeSrSuffix')}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : null}

      <form className="tm-stack" noValidate onSubmit={submit}>
        <Field
          label={t('PersonSkillsPanel.addSkillLabel')}
          name="skillLabel"
          value={label}
          maxLength={80}
          onChange={(event) => setLabel(event.target.value)}
          hint={t('PersonSkillsPanel.addSkillHint')}
        />
        <Select
          label={t('PersonSkillsPanel.levelLabel')}
          name="skillLevel"
          value={level}
          onChange={(event) => setLevel(event.target.value as PersonSkillLevel)}
        >
          {LEVELS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={add.isPending}
            loadingLabel={t('PersonSkillsPanel.adding')}
            disabled={label.trim() === ''}
          >
            {t('PersonSkillsPanel.addSkill')}
          </Button>
        </div>
      </form>
    </section>
  );
}
