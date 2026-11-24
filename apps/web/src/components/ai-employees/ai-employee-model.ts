import type { PersonSummary } from '../../lib/api/people';
import type { AiEmployeeView } from '../../lib/api/ai-employees';

/**
 * Plan 60 slice 60-07, the pure rules of the People screens (S1, S3, S6): no React, no I/O, so
 * every rule here is proved by a unit test without a render.
 */

/** What the Status column says about one row (S1: dot + word). */
export type RowStatus = 'active' | 'notConnected' | 'paused' | 'retired';

/**
 * An AI employee's status as People shows it. "Not connected" is an active AI employee with no
 * live credential (`connection.live === 0`): he exists, but no agent can work as him yet.
 */
export function aiRowStatus(ai: Pick<AiEmployeeView, 'status' | 'connection'>): RowStatus {
  if (ai.status === 'retired') return 'retired';
  if (ai.status === 'paused') return 'paused';
  return ai.connection.live > 0 ? 'active' : 'notConnected';
}

/** The People tabs (S1). */
export type DirectoryTab = 'everyone' | 'people' | 'ai';

/** One row of the merged directory: a person from the people read, or an AI employee. */
export type DirectoryRow =
  | {
      readonly kind: 'person';
      readonly key: string;
      readonly name: string;
      readonly person: PersonSummary;
    }
  | {
      readonly kind: 'ai';
      readonly key: string;
      readonly name: string;
      readonly ai: AiEmployeeView;
    };

/**
 * The manager adds `jobTitle` to `PersonSummary` with this slice; until that deploy an older API
 * omits it, and the column says nothing rather than failing.
 */
export function personJobTitle(person: PersonSummary): string | null {
  const value = person.jobTitle;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * People and AI employees in one list, by name in the reader's language (S1 "Everyone"). The
 * people read lists people only (`memberships.kind = 'human'`); a membership that is also in the
 * AI list is still shown once, as the AI employee.
 */
export function mergeDirectory(
  people: readonly PersonSummary[],
  aiEmployees: readonly AiEmployeeView[],
  locale: string,
): readonly DirectoryRow[] {
  const aiMemberships = new Set(aiEmployees.map((ai) => ai.membershipId));
  const rows: DirectoryRow[] = [
    ...people
      .filter((person) => !aiMemberships.has(person.membershipId))
      .map((person) => ({
        kind: 'person' as const,
        key: `p-${person.userId}`,
        name: person.displayName,
        person,
      })),
    ...aiEmployees.map((ai) => ({
      kind: 'ai' as const,
      key: `a-${ai.id}`,
      name: ai.displayName,
      ai,
    })),
  ];
  const collator = new Intl.Collator(locale, { sensitivity: 'base' });
  return rows.sort((left, right) => collator.compare(left.name, right.name));
}

/** The rows a tab shows. */
export function rowsForTab(
  rows: readonly DirectoryRow[],
  tab: DirectoryTab,
): readonly DirectoryRow[] {
  if (tab === 'people') return rows.filter((row) => row.kind === 'person');
  if (tab === 'ai') return rows.filter((row) => row.kind === 'ai');
  return rows;
}

/** "Search people": the name, job title or address holds the text, case and accents ignored. */
export function matchesQuery(row: DirectoryRow, query: string): boolean {
  const needle = fold(query.trim());
  if (needle === '') return true;
  const fields =
    row.kind === 'person'
      ? [row.person.displayName, personJobTitle(row.person) ?? '', row.person.email ?? '']
      : [row.ai.displayName, row.ai.jobTitle, row.ai.sponsor.displayName ?? ''];
  return fields.some((field) => fold(field).includes(needle));
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}

/** The first word of a name ("Peter Kamal" → "Peter"), for the phone's "Sponsor Peter". */
export function firstWord(name: string | null): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

/** S2b: the AI card is off when the server says so or the workspace is at its beta cap. */
export function hireBlocked(list: {
  readonly canHire: boolean;
  readonly live: number;
  readonly limit: number;
}): boolean {
  return !list.canHire || list.live >= list.limit;
}

/**
 * The department picker (plan 60 v2 §3.8, the first set). The API takes any lower-case key; these
 * are the keys the screens offer, each labelled in the reader's language.
 */
export const DEPARTMENT_KEYS = [
  'creative_design',
  'marketing',
  'content',
  'video',
  'development',
  'sales',
  'client_services',
  'operations',
  'finance',
  'people_hr',
  'strategy_research',
  'legal_admin',
] as const;

export type DepartmentKey = (typeof DEPARTMENT_KEYS)[number];

export const DEPARTMENT_ENGLISH: Readonly<Record<DepartmentKey, string>> = {
  creative_design: 'Creative and design',
  marketing: 'Marketing',
  content: 'Content and communications',
  video: 'Video and production',
  development: 'Web and software development',
  sales: 'Sales and business development',
  client_services: 'Account and client services',
  operations: 'Projects and operations',
  finance: 'Finance and accounting',
  people_hr: 'Human resources',
  strategy_research: 'Strategy and research',
  legal_admin: 'Administration and legal',
};

export function isDepartmentKey(value: string | null): value is DepartmentKey {
  return value !== null && (DEPARTMENT_KEYS as readonly string[]).includes(value);
}

/** "Runs on" (S3a): what the person says runs the agent. Free to choose, never checked. */
export const VENDOR_LABELS = ['Claude', 'ChatGPT', 'Other'] as const;

/** The agent key's life (S4b0): 30, 60 or 90 days; 90 is drawn as the default. */
export const KEY_LIFETIMES = [30, 60, 90] as const;
export type KeyLifetime = (typeof KEY_LIFETIMES)[number];

/** S4 test: how often the step re-reads the AI employee, and for how long before "not called". */
export const TEST_POLL_MS = 4_000;
export const TEST_WAIT_MS = 120_000;

/** The facts the test step can prove in Phase 1 (no sample task yet: that is Phase 3). */
export interface TestFacts {
  /** A credential that works as him exists. */
  readonly connected: boolean;
  /** He called TManage after the step opened. */
  readonly called: boolean;
}

export function testFacts(ai: Pick<AiEmployeeView, 'connection'>, openedAt: number): TestFacts {
  const last =
    ai.connection.lastCalledAt === null ? Number.NaN : Date.parse(ai.connection.lastCalledAt);
  return {
    connected: ai.connection.live > 0,
    called: !Number.isNaN(last) && last >= openedAt,
  };
}

/** The test step's state (S4c waiting, S4d ready, S4e not called). */
export type TestState = 'waiting' | 'ready' | 'notCalled';

export function testState(facts: TestFacts, elapsedMs: number): TestState {
  if (facts.connected && facts.called) return 'ready';
  return elapsedMs >= TEST_WAIT_MS ? 'notCalled' : 'waiting';
}

/** "0:48": the time the test has been waiting. */
export function clock(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The projects the wizard and the profile offer: open projects, minus the ones closed to AI and
 * the ones already chosen. A project with a client is marked, so the client alert can name it.
 */
export interface ProjectOption {
  readonly id: string;
  readonly name: string;
  readonly isClient: boolean;
}

export function offeredProjects(
  all: readonly ProjectOption[],
  closed: ReadonlySet<string>,
  chosen: readonly string[],
): readonly ProjectOption[] {
  const taken = new Set(chosen);
  return all.filter((project) => !closed.has(project.id) && !taken.has(project.id));
}

/** The roles an AI employee may be given: member, guest, and the custom roles listed. */
export const BUILT_IN_AI_ROLES = ['member', 'guest'] as const;

/**
 * A custom role the caller may hand out: one that grants nothing the caller lacks (an AI employee
 * never gets more rights than the person who sets them; the server enforces it again).
 */
export function grantableCustomRoles<T extends { readonly capabilities: readonly string[] }>(
  roles: readonly T[],
  mine: ReadonlySet<string>,
): readonly T[] {
  return roles.filter((role) => role.capabilities.every((capability) => mine.has(capability)));
}
