'use client';

import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { useT } from '../../lib/i18n/use-t';
import {
  searchSkills,
  type SkillLevel,
  type SkillSearchResult,
} from '../../lib/api/people-skill-search';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface SkillSearchScreenProps {
  organizationSlug: string;
  api: ApiClient;
}

/** The minimum-level options offered, in order. */
const LEVEL_VALUES: readonly ('' | SkillLevel)[] = ['', 'basic', 'proficient', 'expert'];

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
  const describe = useDescribeApiError();
  const t = useT();
  const [tags, setTags] = useState<readonly string[]>([]);
  const [draft, setDraft] = useState('');
  const [level, setLevel] = useState<'' | SkillLevel>('');

  const levelLabels: Readonly<Record<'' | SkillLevel, string>> = {
    '': t('SkillSearchScreen.levelAny'),
    basic: t('SkillSearchScreen.levelBasic'),
    proficient: t('SkillSearchScreen.levelProficient'),
    expert: t('SkillSearchScreen.levelExpert'),
  };

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
        {t('SkillSearchScreen.heading')}
      </h2>

      <form className="tm-stack" noValidate onSubmit={addTag}>
        <Field
          label={t('SkillSearchScreen.addTagLabel')}
          name="skillTag"
          value={draft}
          maxLength={80}
          onChange={(event) => setDraft(event.target.value)}
          hint={t('SkillSearchScreen.addTagHint')}
        />
        <Select
          label={t('SkillSearchScreen.minLevelLabel')}
          name="minLevel"
          value={level}
          onChange={(event) => setLevel(event.target.value as '' | SkillLevel)}
        >
          {LEVEL_VALUES.map((value) => (
            <option key={value} value={value}>
              {levelLabels[value]}
            </option>
          ))}
        </Select>
        <div className="tm-row">
          <Button type="submit" tone="ink" size="accessible" disabled={draft.trim() === ''}>
            {t('SkillSearchScreen.addSkill')}
          </Button>
        </div>
      </form>

      {tags.length > 0 ? (
        <ul className="tm-list" aria-label={t('SkillSearchScreen.selectedSkillsAria')}>
          {tags.map((tag) => (
            <li key={tag} className="tm-row">
              <span>{tag}</span>
              <Button type="button" tone="text" size="accessible" onClick={() => removeTag(tag)}>
                {t('SkillSearchScreen.remove')}{' '}
                <span className="tm-visually-hidden">
                  {t('SkillSearchScreen.theFilterBefore')}
                  {tag}
                  {t('SkillSearchScreen.theFilterAfter')}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="tm-prose">{t('SkillSearchScreen.emptyPrompt')}</p>
      )}

      {results.isPending && tags.length > 0 ? (
        <LoadingRegion label={t('SkillSearchScreen.searching')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {results.isError ? (
        <InlineAlert tone="danger" title={t('SkillSearchScreen.searchError')} live>
          {describe(results.error)}
        </InlineAlert>
      ) : null}

      {results.data ? (
        hits.length === 0 ? (
          <p className="tm-prose">{t('SkillSearchScreen.noMatches')}</p>
        ) : (
          <ul className="tm-list" aria-label={t('SkillSearchScreen.matchingAria')}>
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
