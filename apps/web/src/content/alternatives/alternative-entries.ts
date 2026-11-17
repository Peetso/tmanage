/**
 * SEOF (backlog B1) — the "X alternative" pages, `/alternatives/<slug>` (Arabic at
 * `/ar/alternatives/<slug>`). Figma 685:13383 (Basecamp desktop 685:13384 / 685:13685, phone
 * 685:13974 / 685:14242; index 687:14643).
 *
 * An entry holds only the page's own words about the reader. Every fact about the other product
 * (its name, table cells, pricing page, sources and check date) is read from that product's compare
 * entry (`content/compare/compare-entries.ts`), never copied here, and no price is shown. Arabic is
 * Modern Standard Arabic; product names stay in Latin script.
 */

import {
  COMPARE_ENTRIES,
  RLM,
  type Bilingual,
  type CompareEntry,
} from '../compare/compare-entries';
import type { AlternativeSlug } from './alternative-slugs';

export interface AlternativeEntry {
  readonly slug: AlternativeSlug;
  /** The index card's hint: what kind of tool it is. */
  readonly category: Bilingual;
  /** The "Why teams look" lede: a fair word about the tool, then where it stops fitting. */
  readonly whyLede: Bilingual;
  /** What the tool calls a unit of work, in English ("to-dos", "cards"). */
  readonly workWord: string;
}

/** The day the alternative pages' words last changed (the "Last updated" line). */
export const ALTERNATIVES_UPDATED_ON = '2026-11-17';

const WORK_MANAGEMENT: Bilingual = { en: 'Work management', ar: 'إدارة العمل' };

export const ALTERNATIVE_ENTRIES: readonly AlternativeEntry[] = [
  {
    slug: 'basecamp',
    category: { en: 'Project and team communication', ar: 'المشاريع وتواصل الفريق' },
    whyLede: {
      en: 'Basecamp is calm and simple, and many teams stay with it. These are the cases where it stops fitting.',
      ar: `${RLM}Basecamp بسيط وهادئ، وفرق كثيرة تبقى عليه. وهذه الحالات التي لا يعود مناسبًا فيها.`,
    },
    workWord: 'to-dos',
  },
  {
    slug: 'monday',
    category: WORK_MANAGEMENT,
    whyLede: {
      en: 'monday.com is flexible and visual, and many teams stay with it. These are the cases where it stops fitting.',
      ar: `${RLM}monday.com مرن وواضح بصريًا، وفرق كثيرة تبقى عليه. وهذه الحالات التي لا يعود مناسبًا فيها.`,
    },
    workWord: 'items',
  },
  {
    slug: 'clickup',
    category: WORK_MANAGEMENT,
    whyLede: {
      en: 'ClickUp does a great deal in one place, and many teams stay with it. These are the cases where it stops fitting.',
      ar: `${RLM}ClickUp يجمع الكثير في مكان واحد، وفرق كثيرة تبقى عليه. وهذه الحالات التي لا يعود مناسبًا فيها.`,
    },
    workWord: 'tasks',
  },
  {
    slug: 'asana',
    category: WORK_MANAGEMENT,
    whyLede: {
      en: 'Asana is well organised, and many teams stay with it. These are the cases where it stops fitting.',
      ar: `${RLM}Asana منظّم جيدًا، وفرق كثيرة تبقى عليه. وهذه الحالات التي لا يعود مناسبًا فيها.`,
    },
    workWord: 'tasks',
  },
  {
    slug: 'trello',
    category: { en: 'Boards and lists', ar: 'لوحات وقوائم' },
    whyLede: {
      en: 'Trello is easy to start with, and many teams stay with it. These are the cases where it stops fitting.',
      ar: `${RLM}Trello سهل البداية، وفرق كثيرة تبقى عليه. وهذه الحالات التي لا يعود مناسبًا فيها.`,
    },
    workWord: 'cards',
  },
];

/** An alternative entry with the compare entry its facts come from. */
export interface AlternativePage {
  readonly entry: AlternativeEntry;
  readonly rival: CompareEntry;
}

function rivalOf(slug: AlternativeSlug): CompareEntry {
  const rival = COMPARE_ENTRIES.find((candidate) => candidate.slug === slug);
  if (rival === undefined) throw new Error(`No compare entry for the alternative page ${slug}`);
  return rival;
}

/** Every alternative page, in the index's order. */
export const ALTERNATIVE_PAGES: readonly AlternativePage[] = ALTERNATIVE_ENTRIES.map((entry) => ({
  entry,
  rival: rivalOf(entry.slug),
}));

/** The alternative page `slug`, or `undefined`. */
export function findAlternativePage(slug: string): AlternativePage | undefined {
  return ALTERNATIVE_PAGES.find((page) => page.entry.slug === slug);
}
