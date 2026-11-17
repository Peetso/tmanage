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
import { switchLinks } from '../compare/compare-slugs';
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
const CLIENT_WORK: Bilingual = { en: 'Client work and billing', ar: 'العمل مع العملاء والفوترة' };
const CLIENT_PORTAL: Bilingual = { en: 'Client portal', ar: 'بوابة العملاء' };

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
  // SEOG (2026-11-17): the other products with a compare entry, Wrike, Teamwork, Notion and Jira
  // first (as in the index design). Slack and Microsoft Teams are left out: they are chat hubs,
  // and the page's "projects you keep" story does not fit them.
  {
    slug: 'wrike',
    category: WORK_MANAGEMENT,
    whyLede: {
      en: 'Wrike is strong at planning, and many teams stay with it. These are the cases where it stops fitting.',
      ar: `${RLM}Wrike قوي في التخطيط، وفرق كثيرة تبقى عليه. وهذه الحالات التي لا يعود مناسبًا فيها.`,
    },
    workWord: 'tasks',
  },
  {
    slug: 'teamwork',
    category: CLIENT_WORK,
    whyLede: {
      en: 'Teamwork.com is built for client work, and many teams stay with it. These are the cases where it stops fitting.',
      ar: `${RLM}Teamwork.com مصمَّم للعمل مع العملاء، وفرق كثيرة تبقى عليه. وهذه الحالات التي لا يعود مناسبًا فيها.`,
    },
    workWord: 'tasks',
  },
  {
    slug: 'notion',
    category: { en: 'Docs, wiki and projects', ar: 'مستندات وقاعدة معرفة ومشاريع' },
    whyLede: {
      en: 'Notion brings docs and projects together, and many teams stay with it. These are the cases where it stops fitting.',
      ar: `${RLM}Notion يجمع المستندات والمشاريع معًا، وفرق كثيرة تبقى عليه. وهذه الحالات التي لا يعود مناسبًا فيها.`,
    },
    workWord: 'tasks',
  },
  {
    slug: 'jira',
    category: { en: 'Planning and tracking', ar: 'التخطيط والمتابعة' },
    whyLede: {
      en: 'Jira is thorough at planning and reporting, and many teams stay with it. These are the cases where it stops fitting.',
      ar: `${RLM}Jira دقيق في التخطيط والتقارير، وفرق كثيرة تبقى عليه. وهذه الحالات التي لا يعود مناسبًا فيها.`,
    },
    workWord: 'work items',
  },
  {
    slug: 'zoho-projects',
    category: WORK_MANAGEMENT,
    whyLede: {
      en: 'Zoho Projects fits well with other Zoho apps, and many teams stay with it. These are the cases where it stops fitting.',
      ar: `${RLM}Zoho Projects يتكامل جيدًا مع تطبيقات Zoho${RLM} الأخرى، وفرق كثيرة تبقى عليه. وهذه الحالات التي لا يعود مناسبًا فيها.`,
    },
    workWord: 'tasks',
  },
  {
    slug: 'productive',
    category: CLIENT_WORK,
    whyLede: {
      en: 'Productive is built for agencies, and many teams stay with it. These are the cases where it stops fitting.',
      ar: `${RLM}Productive مصمَّم للوكالات، وفرق كثيرة تبقى عليه. وهذه الحالات التي لا يعود مناسبًا فيها.`,
    },
    workWord: 'tasks',
  },
  {
    slug: 'scoro',
    category: CLIENT_WORK,
    whyLede: {
      en: 'Scoro connects quotes, delivery and billing, and many teams stay with it. These are the cases where it stops fitting.',
      ar: `${RLM}Scoro يربط عروض الأسعار بالتنفيذ والفوترة، وفرق كثيرة تبقى عليه. وهذه الحالات التي لا يعود مناسبًا فيها.`,
    },
    workWord: 'tasks',
  },
  {
    slug: 'accelo',
    category: { en: 'Professional services', ar: 'الخدمات المهنية' },
    whyLede: {
      en: 'Accelo is built for professional services, and many teams stay with it. These are the cases where it stops fitting.',
      ar: `${RLM}Accelo مصمَّم للخدمات المهنية، وفرق كثيرة تبقى عليه. وهذه الحالات التي لا يعود مناسبًا فيها.`,
    },
    workWord: 'tasks',
  },
  {
    slug: 'bonsai',
    category: { en: 'Proposals to payment', ar: 'من العرض إلى الدفع' },
    whyLede: {
      en: 'Bonsai covers the path from proposal to payment, and many teams stay with it. These are the cases where it stops fitting.',
      ar: `${RLM}Bonsai يغطي الطريق من العرض إلى الدفع، وفرق كثيرة تبقى عليه. وهذه الحالات التي لا يعود مناسبًا فيها.`,
    },
    workWord: 'tasks',
  },
  {
    slug: 'plutio',
    category: CLIENT_PORTAL,
    whyLede: {
      en: 'Plutio puts a lot behind one client portal, and many teams stay with it. These are the cases where it stops fitting.',
      ar: `${RLM}Plutio يضع الكثير خلف بوابة واحدة للعملاء، وفرق كثيرة تبقى عليه. وهذه الحالات التي لا يعود مناسبًا فيها.`,
    },
    workWord: 'tasks',
  },
  {
    slug: 'suitedash',
    category: CLIENT_PORTAL,
    whyLede: {
      en: 'SuiteDash bundles a portal, a CRM and projects, and many teams stay with it. These are the cases where it stops fitting.',
      ar: `${RLM}SuiteDash يجمع بوابة وإدارة علاقات العملاء والمشاريع، وفرق كثيرة تبقى عليه. وهذه الحالات التي لا يعود مناسبًا فيها.`,
    },
    workWord: 'tasks',
  },
  {
    slug: 'moxo',
    category: { en: 'Client processes', ar: 'إجراءات العملاء' },
    whyLede: {
      en: 'Moxo is built for structured client processes, and many teams stay with it. These are the cases where it stops fitting.',
      ar: `${RLM}Moxo مصمَّم لإجراءات العملاء المنظّمة، وفرق كثيرة تبقى عليه. وهذه الحالات التي لا يعود مناسبًا فيها.`,
    },
    workWord: 'workflow steps',
  },
  {
    slug: 'assembly',
    category: CLIENT_PORTAL,
    whyLede: {
      en: 'Assembly gives each client a branded portal, and many teams stay with it. These are the cases where it stops fitting.',
      ar: `${RLM}Assembly يمنح كل عميل بوابة بعلامتك التجارية، وفرق كثيرة تبقى عليه. وهذه الحالات التي لا يعود مناسبًا فيها.`,
    },
    workWord: 'tasks',
  },
];

/**
 * What the page may say about how the other product compares, read from its compare entry and the
 * switch-page list (SEOG): a page without a switch guide does not promise one, and a page never
 * implies the other product lacks Arabic or client access when its entry does not say so.
 */
export interface AlternativeFit {
  /** A "switch from X" page exists. */
  readonly hasSwitchPage: boolean;
  /** Their compare entry confirms an Arabic interface. */
  readonly theyHaveArabic: boolean;
  /** Their compare entry has a sourced client-access cell. */
  readonly theyListClients: boolean;
}

/** An alternative entry with the compare entry its facts come from. */
export interface AlternativePage {
  readonly entry: AlternativeEntry;
  readonly rival: CompareEntry;
  readonly fit: AlternativeFit;
}

function fitOf(rival: CompareEntry): AlternativeFit {
  return {
    hasSwitchPage: switchLinks(rival.slug) !== undefined,
    theyHaveArabic: rival.rows.arabic?.tone === 'yes',
    theyListClients: rival.rows.clients !== undefined,
  };
}

function rivalOf(slug: AlternativeSlug): CompareEntry {
  const rival = COMPARE_ENTRIES.find((candidate) => candidate.slug === slug);
  if (rival === undefined) throw new Error(`No compare entry for the alternative page ${slug}`);
  return rival;
}

/** Every alternative page, in the index's order. */
export const ALTERNATIVE_PAGES: readonly AlternativePage[] = ALTERNATIVE_ENTRIES.map((entry) => {
  const rival = rivalOf(entry.slug);
  return { entry, rival, fit: fitOf(rival) };
});

/** The alternative page `slug`, or `undefined`. */
export function findAlternativePage(slug: string): AlternativePage | undefined {
  return ALTERNATIVE_PAGES.find((page) => page.entry.slug === slug);
}
