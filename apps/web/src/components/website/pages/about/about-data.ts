import type { WebIconName } from '../../WebIcon';

/** Copy for /about (SITE-SPEC "PAGE: About"). Titles are the spec's; bodies follow its voice. */

export const WHY_PARAGRAPHS: readonly string[] = [
  'Most service work is a story told across too many tools: the request in email, the plan in a spreadsheet, the file in a drive, the approval in a call. Context is retyped at every step, and something always falls out.',
  'We are building one system where the ask, the work and the sign-off are the same thread — so teams stop chasing and clients stop guessing.',
];

/** The scattered places the story used to live, in the "Why we exist" visual. */
export const SCATTERED: readonly { icon: WebIconName; label: string; where: string }[] = [
  { icon: 'mail', label: 'The request', where: 'in email' },
  { icon: 'grid', label: 'The plan', where: 'in a spreadsheet' },
  { icon: 'doc', label: 'The file', where: 'in a drive' },
  { icon: 'video', label: 'The approval', where: 'in a call' },
];

export interface Principle {
  icon: WebIconName;
  title: string;
  body: string;
}

export const PRINCIPLES: readonly Principle[] = [
  {
    icon: 'pulse',
    title: 'Calm over noisy.',
    body: 'Every notification carries a reason and an owner. Nothing pings just to be seen.',
  },
  {
    icon: 'chart',
    title: "Explain, don't score.",
    body: 'Workload shows commitments and constraints. TManage never ranks individual productivity.',
  },
  {
    icon: 'lock',
    title: 'Private by default.',
    body: 'Internal comments stay internal. Client visibility is always an explicit choice.',
  },
  {
    icon: 'portal',
    title: 'Clients deserve clarity.',
    body: 'Clients see progress, their actions and the exact version to review — in their language.',
  },
];

export const HOW_WE_BUILD: readonly { icon: WebIconName; title: string; body: string }[] = [
  {
    icon: 'layers',
    title: 'Designed in full, shipped in releases.',
    body: 'The whole product is designed before it is built, then shipped in releases you can try.',
  },
  {
    icon: 'globe',
    title: 'English and Arabic from day one.',
    body: 'Every screen is mirrored for right-to-left, not translated after the fact.',
  },
  {
    icon: 'check',
    title: 'Accessibility as a floor, not a feature.',
    body: 'Every state has a word and a shape as well as a colour, and works from the keyboard.',
  },
];

/** The same four moments, held in one thread, in the "Why we exist" visual. */
export const ONE_THREAD: readonly {
  label: string;
  state: 'done' | 'current' | 'client';
  status: string;
}[] = [
  { label: 'The request', state: 'done', status: 'Request created' },
  { label: 'The work', state: 'done', status: 'Committed' },
  { label: 'The version', state: 'current', status: 'v2 ready' },
  { label: 'The approval', state: 'client', status: 'Waiting for client' },
];

export type TeamTone = 'ink' | 'lime' | 'tint' | 'paper';

/**
 * Team placeholders: roles only, no invented people, until real photos and consent exist.
 * Two-word roles keep the avatar initials distinct; tones cycle through the brand surfaces.
 */
export const TEAM_ROLES: readonly { role: string; focus: string; tone: TeamTone }[] = [
  { role: 'Product & design', focus: 'Every screen, before it ships', tone: 'ink' },
  { role: 'Platform engineering', focus: 'Isolation, search and sync', tone: 'lime' },
  { role: 'Client delivery', focus: 'From both sides of the table', tone: 'tint' },
  { role: 'Security & privacy', focus: 'Scoping, audit and access', tone: 'paper' },
  { role: 'Arabic language', focus: 'Right-to-left, word by word', tone: 'lime' },
  { role: 'Customer support', focus: 'Answers within a business day', tone: 'ink' },
];
