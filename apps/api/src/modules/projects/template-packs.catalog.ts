import type {
  ProjectTemplateMilestone,
  ProjectTemplateWorkItem,
} from '../../common/database/schema.js';

/**
 * 54-22. The built-in template packs. A pack is a bundle of project templates plus the docs and
 * automations that go with them. The packs live in code, not in the database, so shipping or
 * changing one is a deploy and never a data change; `template_packs` (0325) only records which
 * packs a workspace installed.
 *
 * Installing a pack creates its project templates. The pack's docs and automations are written
 * into each template's description as setup steps, so the person starting a project from the
 * template sees what to add; nothing is switched on behind their back.
 */

export interface TemplatePackTemplate {
  readonly name: string;
  readonly description: string;
  readonly defaultObjectives?: readonly string[];
  readonly milestones?: readonly ProjectTemplateMilestone[];
  readonly workItems?: readonly ProjectTemplateWorkItem[];
  readonly clientPortalOn?: boolean;
  readonly repeatInterval?: 'monthly';
}

export interface TemplatePack {
  /** Stable catalog key, stored in `template_packs.pack_key`. */
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly templates: readonly TemplatePackTemplate[];
  /** Titles of the docs the pack suggests. */
  readonly docs: readonly string[];
  /** Plain descriptions of the automations the pack suggests. */
  readonly automations: readonly string[];
}

export const TEMPLATE_PACKS: readonly TemplatePack[] = [
  {
    key: 'agency-client-launch',
    name: 'Agency client launch',
    description: 'Kick-off, brand sprint and website launch for a new client.',
    templates: [
      {
        name: 'Client kick-off',
        description: 'Welcome a new client and agree the brief.',
        milestones: [
          { title: 'Kick-off meeting', offsetDays: 0 },
          { title: 'Brief signed off', offsetDays: 7, clientVisible: true },
        ],
        workItems: [
          { title: 'Send the welcome pack', offsetDays: 0 },
          { title: 'Book the kick-off call', offsetDays: 1 },
          { title: 'Collect brand assets', offsetDays: 3 },
        ],
        clientPortalOn: true,
      },
      {
        name: 'Brand sprint',
        description: 'Two weeks from moodboards to an approved brand direction.',
        milestones: [
          { title: 'Moodboards shared', offsetDays: 5, clientVisible: true },
          { title: 'Brand direction approved', offsetDays: 14, clientVisible: true },
        ],
        workItems: [
          { title: 'Research the market', offsetDays: 2 },
          { title: 'Prepare three moodboards', offsetDays: 5 },
          { title: 'Present the brand direction', offsetDays: 12 },
        ],
        clientPortalOn: true,
      },
      {
        name: 'Website launch',
        description: 'Sitemap, design and build through to a live site.',
        milestones: [
          { title: 'Sitemap approved', offsetDays: 7, clientVisible: true },
          { title: 'Design approved', offsetDays: 21, clientVisible: true },
          { title: 'Site live', offsetDays: 42, clientVisible: true },
        ],
        workItems: [
          { title: 'Draft the sitemap', offsetDays: 3 },
          { title: 'Design the key pages', offsetDays: 18 },
          { title: 'Build and test', offsetDays: 38 },
        ],
        clientPortalOn: true,
      },
    ],
    docs: ['Client onboarding guide', 'Creative brief'],
    automations: [
      'Tell the client when a milestone is done',
      'Remind the lead two days before a due date',
    ],
  },
  {
    key: 'monthly-retainer',
    name: 'Monthly retainer',
    description: 'A repeating month of client work with a report at the end.',
    templates: [
      {
        name: 'Monthly retainer',
        description: 'One month of agreed client work that repeats every month.',
        workItems: [
          { title: 'Plan the month with the client', offsetDays: 0 },
          { title: 'Mid-month check-in', offsetDays: 14 },
          { title: 'Send the month-end report', offsetDays: 27 },
        ],
        clientPortalOn: true,
        repeatInterval: 'monthly',
      },
      {
        name: 'Quarterly review',
        description: 'Look back on the quarter with the client and agree the next one.',
        milestones: [{ title: 'Quarterly review meeting', offsetDays: 0, clientVisible: true }],
        workItems: [
          { title: 'Gather the quarter’s results', offsetDays: 0 },
          { title: 'Agree next quarter’s goals', offsetDays: 3 },
        ],
      },
    ],
    docs: ['Monthly report outline'],
    automations: ['Start the next month’s retainer on the first of the month'],
  },
  {
    key: 'product-sprint-kit',
    name: 'Product sprint kit',
    description: 'Discovery, a two-week build sprint and a release checklist.',
    templates: [
      {
        name: 'Discovery',
        description: 'Understand the problem before building anything.',
        defaultObjectives: ['Agree the problem we are solving'],
        milestones: [{ title: 'Problem statement agreed', offsetDays: 5 }],
        workItems: [
          { title: 'Interview five users', offsetDays: 3 },
          { title: 'Write the problem statement', offsetDays: 5 },
        ],
      },
      {
        name: 'Two-week build sprint',
        description: 'Plan, build and demo in two weeks.',
        milestones: [
          { title: 'Sprint planned', offsetDays: 0 },
          { title: 'Sprint demo', offsetDays: 13 },
        ],
        workItems: [
          { title: 'Sprint planning', offsetDays: 0 },
          { title: 'Daily stand-ups', offsetDays: 1 },
          { title: 'Sprint review and retro', offsetDays: 13 },
        ],
      },
    ],
    docs: ['Problem statement', 'Release checklist'],
    automations: ['Post a sprint summary in the project chat'],
  },
];

export function findTemplatePack(key: string): TemplatePack | undefined {
  return TEMPLATE_PACKS.find((pack) => pack.key === key);
}

/** The template description with the pack's docs and automations appended as setup steps. */
export function packTemplateDescription(
  pack: TemplatePack,
  template: TemplatePackTemplate,
): string {
  const lines = [template.description];
  if (pack.docs.length > 0) lines.push(`Docs from the ${pack.name} pack: ${pack.docs.join(', ')}.`);
  if (pack.automations.length > 0) {
    lines.push(`Suggested automations: ${pack.automations.join('; ')}.`);
  }
  return lines.join('\n');
}
