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
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

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

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

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
  const queries = useQueryClient();
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
        Skills
      </h2>

      {skills.isPending ? (
        <LoadingRegion label="Loading this member’s skills.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {skills.isError ? (
        <InlineAlert tone="danger" title="Could not load the skills" live>
          {describe(skills.error)}
        </InlineAlert>
      ) : null}

      {failure ? (
        <InlineAlert tone="danger" title="That did not go through" live>
          {failure}
        </InlineAlert>
      ) : null}

      {skills.data ? (
        items.length === 0 ? (
          <p className="tm-prose">No skills yet. Add the first one below.</p>
        ) : (
          <ul className="tm-list" aria-label="Member skills">
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
                  loadingLabel="Removing"
                  onClick={() => remove.mutate(skill)}
                >
                  Remove <span className="tm-visually-hidden">the {skill.label} skill</span>
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : null}

      <form className="tm-stack" noValidate onSubmit={submit}>
        <Field
          label="Add a skill"
          name="skillLabel"
          value={label}
          maxLength={80}
          onChange={(event) => setLabel(event.target.value)}
          hint="A short skill or tag, e.g. TypeScript or Copywriting."
        />
        <Select
          label="Level"
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
            loadingLabel="Adding"
            disabled={label.trim() === ''}
          >
            Add skill
          </Button>
        </div>
      </form>
    </section>
  );
}
