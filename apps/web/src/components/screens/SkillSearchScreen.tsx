'use client';

import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import {
  searchSkills,
  type SkillLevel,
  type SkillSearchResult,
} from '../../lib/api/people-skill-search';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface SkillSearchScreenProps {
  organizationSlug: string;
  api: ApiClient;
}

const LEVELS: readonly { value: '' | SkillLevel; label: string }[] = [
  { value: '', label: 'Any level' },
  { value: 'basic', label: 'Basic or above' },
  { value: 'proficient', label: 'Proficient or above' },
  { value: 'expert', label: 'Expert' },
];

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

/**
 * **x194 — find members by skill.** (People module 14; the audit's "People — no skill-based search".)
 *
 * A read-only directory search over the skills x172 stores: pick one or more skill tags and an
 * optional minimum level, and see the members who match. The query stays empty until a tag is added
 * (a blank query returns nothing, never the whole directory), and each search reads the server rather
 * than filtering a cached list. Distinct from x172's `PersonSkillsPanel`, which edits one member's
 * skills; this screen reads across members.
 */
export function SkillSearchScreen({ organizationSlug, api }: SkillSearchScreenProps) {
  const [tags, setTags] = useState<readonly string[]>([]);
  const [draft, setDraft] = useState('');
  const [level, setLevel] = useState<'' | SkillLevel>('');

  const queryKey = ['skill-search', organizationSlug, tags, level] as const;
  const results = useQuery({
    queryKey,
    queryFn: () => searchSkills(api, organizationSlug, tags, level ? { minLevel: level } : {}),
    enabled: tags.length > 0,
  });

  function addTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = draft.trim().replace(/\s+/g, ' ');
    if (trimmed === '' || tags.includes(trimmed)) {
      setDraft('');
      return;
    }
    setTags((current) => [...current, trimmed]);
    setDraft('');
  }

  function removeTag(tag: string) {
    setTags((current) => current.filter((t) => t !== tag));
  }

  const hits: readonly SkillSearchResult[] = results.data ?? [];

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-skill-search">
      <h2 id="tm-skill-search" className="tm-eyebrow">
        Find people by skill
      </h2>

      <form className="tm-stack" noValidate onSubmit={addTag}>
        <Field
          label="Add a skill tag"
          name="skillTag"
          value={draft}
          maxLength={80}
          onChange={(event) => setDraft(event.target.value)}
          hint="Add one or more skills to filter by, e.g. TypeScript."
        />
        <Select
          label="Minimum level"
          name="minLevel"
          value={level}
          onChange={(event) => setLevel(event.target.value as '' | SkillLevel)}
        >
          {LEVELS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        <div className="tm-row">
          <Button type="submit" tone="ink" size="accessible" disabled={draft.trim() === ''}>
            Add skill
          </Button>
        </div>
      </form>

      {tags.length > 0 ? (
        <ul className="tm-list" aria-label="Selected skills">
          {tags.map((tag) => (
            <li key={tag} className="tm-row">
              <span>{tag}</span>
              <Button type="button" tone="text" size="accessible" onClick={() => removeTag(tag)}>
                Remove <span className="tm-visually-hidden">the {tag} filter</span>
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="tm-prose">Add a skill above to search the directory.</p>
      )}

      {results.isPending && tags.length > 0 ? (
        <LoadingRegion label="Searching the directory.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {results.isError ? (
        <InlineAlert tone="danger" title="Could not run the search" live>
          {describe(results.error)}
        </InlineAlert>
      ) : null}

      {results.data ? (
        hits.length === 0 ? (
          <p className="tm-prose">No members match those skills.</p>
        ) : (
          <ul className="tm-list" aria-label="Matching members">
            {hits.map((hit) => (
              <li key={hit.membershipId} className="tm-row">
                <span>
                  {hit.role} · {hit.matched.map((s) => `${s.label} (${s.level})`).join(', ')}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
