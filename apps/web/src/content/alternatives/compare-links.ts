import { alternativeHref, type AlternativeSlug } from './alternative-slugs';
import type { CompareSlug } from '../compare/compare-slugs';

/**
 * SEOG (B19) — the small "Compare TManage" link group at the foot of the feature and solution
 * pages: at most three compare or alternative pages per page, chosen by the page's topic.
 *
 * Like `alternative-slugs.ts`, this module imports no compare entry, so the feature and solution
 * pages' bundles stay free of them. Its link words are the compare and alternative pages' own
 * titles; `alternative-pages.test.tsx` keeps them equal to `COMPARE_COPY` and `ALTERNATIVE_COPY`.
 */

type LinkLanguage = 'en' | 'ar';

/** U+200F RIGHT-TO-LEFT MARK, before a Latin product name in Arabic text. */
const RLM = '‏';

export const COMPARE_LINKS_COPY = {
  en: {
    label: 'Compare TManage',
    compare: (name: string) => `TManage vs ${name}`,
    alternative: (name: string) => `${name} alternative for agencies`,
  },
  ar: {
    label: `قارن ${RLM}TManage`,
    compare: (name: string) => `${RLM}TManage مقابل ${name}`,
    alternative: (name: string) => `بديل ${RLM}${name} للوكالات`,
  },
} satisfies Record<LinkLanguage, unknown>;

export type CompareLinkTopic =
  | 'features-work'
  | 'features-communication'
  | 'features-knowledge'
  | 'features-insights'
  | 'solutions-agencies'
  | 'solutions-consultancies'
  | 'solutions-in-house';

type CompareLinkTarget =
  | { readonly kind: 'compare'; readonly slug: CompareSlug; readonly name: string }
  | { readonly kind: 'alternative'; readonly slug: AlternativeSlug; readonly name: string };

const alternative = (slug: AlternativeSlug, name: string): CompareLinkTarget => ({
  kind: 'alternative',
  slug,
  name,
});
const compare = (slug: CompareSlug, name: string): CompareLinkTarget => ({
  kind: 'compare',
  slug,
  name,
});

export const TOPIC_LINKS: Readonly<Record<CompareLinkTopic, readonly CompareLinkTarget[]>> = {
  'features-work': [
    alternative('asana', 'Asana'),
    alternative('monday', 'monday.com'),
    compare('clickup', 'ClickUp'),
  ],
  'features-communication': [
    compare('slack', 'Slack'),
    compare('microsoft-teams', 'Microsoft Teams'),
    alternative('basecamp', 'Basecamp'),
  ],
  'features-knowledge': [
    alternative('notion', 'Notion'),
    compare('notion', 'Notion'),
    alternative('basecamp', 'Basecamp'),
  ],
  'features-insights': [
    alternative('wrike', 'Wrike'),
    alternative('teamwork', 'Teamwork.com'),
    compare('productive', 'Productive'),
  ],
  'solutions-agencies': [
    alternative('basecamp', 'Basecamp'),
    alternative('teamwork', 'Teamwork.com'),
    compare('productive', 'Productive'),
  ],
  'solutions-consultancies': [
    alternative('scoro', 'Scoro'),
    alternative('accelo', 'Accelo'),
    compare('zoho-projects', 'Zoho Projects'),
  ],
  'solutions-in-house': [
    alternative('asana', 'Asana'),
    alternative('jira', 'Jira'),
    alternative('wrike', 'Wrike'),
  ],
};

export interface CompareLink {
  readonly href: string;
  readonly label: string;
}

/** The links of `topic`, in `language`, with their addresses under `/ar` for Arabic. */
export function compareLinks(topic: CompareLinkTopic, language: LinkLanguage): CompareLink[] {
  const copy = COMPARE_LINKS_COPY[language];
  const prefix = language === 'ar' ? '/ar' : '';
  return TOPIC_LINKS[topic].map((target) =>
    target.kind === 'compare'
      ? { href: `${prefix}/compare/${target.slug}`, label: copy.compare(target.name) }
      : { href: alternativeHref(target.slug, language), label: copy.alternative(target.name) },
  );
}
