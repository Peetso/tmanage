import { describe, expect, it } from 'vitest';
import type { StageSetView, StageView } from '../src/lib/api/work-stages';
import { decisionFor } from '../src/components/work/detail/WorkDecision';
import { movedOrder } from '../src/components/work/detail/WorkSteps';
import {
  autoFacts,
  currentStage,
  effectiveSetForWork,
  groupOfState,
  movesTo,
  orderedStages,
  STAGE_TEMPLATES,
} from '../src/components/work/stages/stage-model';

/**
 * Work area v2 (W-WEB-1): the pure rules the stage control, the header decision and the steps
 * list share. The API's own stage rules are proved in its suite; these prove only what the
 * screens decide from what they read.
 */
function stage(id: string, stateKey: string, position: number): StageView {
  return {
    id,
    name: id,
    stateKey,
    group: groupOfState(stateKey) ?? 'not_started',
    colorKey: null,
    position,
  };
}

function set(id: string, stages: readonly StageView[]): StageSetView {
  return {
    id,
    name: id,
    scope: 'workspace',
    projectId: null,
    isDefault: false,
    isBuiltIn: false,
    version: 1,
    stages,
    createdAt: null,
    updatedAt: null,
  };
}

const DESIGN = set('design', [
  stage('empathize', 'ready', 0),
  stage('define', 'in_progress', 1),
  stage('ideate', 'in_progress', 2),
  stage('test', 'internal_review', 3),
  stage('shipped', 'done', 4),
]);
const PROJECT = set('project', [stage('todo', 'ready', 0), stage('doing', 'in_progress', 1)]);

describe('stage sets', () => {
  it('orders stages by position, then id', () => {
    const shuffled = [stage('b', 'ready', 1), stage('c', 'ready', 0), stage('a', 'ready', 1)];
    expect(orderedStages(shuffled).map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });

  it("uses the set that holds the work's stage, else the project's set", () => {
    expect(effectiveSetForWork('ideate', [PROJECT, DESIGN], PROJECT)?.id).toBe('design');
    expect(effectiveSetForWork('doing', [PROJECT, DESIGN], PROJECT)?.id).toBe('project');
    expect(effectiveSetForWork(null, [PROJECT, DESIGN], PROJECT)?.id).toBe('project');
    expect(effectiveSetForWork('gone', [DESIGN], null)).toBeNull();
  });

  it("finds the work's stage, else the first stage of its state", () => {
    expect(currentStage(DESIGN, 'ideate', 'in_progress')?.id).toBe('ideate');
    expect(currentStage(DESIGN, null, 'in_progress')?.id).toBe('define');
    expect(currentStage(DESIGN, null, 'blocked')).toBeNull();
    expect(currentStage(null, 'ideate', 'in_progress')).toBeNull();
  });

  it('ships the design-thinking template the owner named, in order, ending in Done', () => {
    expect(STAGE_TEMPLATES.designThinking.map((entry) => entry.nameKey)).toEqual([
      'WorkStages.template.empathize',
      'WorkStages.template.define',
      'WorkStages.template.ideate',
      'WorkStages.template.prototype',
      'WorkStages.template.test',
      'WorkStages.template.done',
    ]);
  });
});

describe('stage moves', () => {
  it('runs the fact-free moves first and names what the last one needs', () => {
    expect(movesTo('backlog', 'internal_review')).toEqual({
      before: ['in_progress'],
      needs: [],
    });
    expect(movesTo('in_progress', 'done')).toEqual({
      before: ['internal_review'],
      needs: ['ownerId', 'completedAt'],
    });
    expect(movesTo('ready', 'ready')).toEqual({ before: [], needs: [] });
  });

  it('never routes through blocked or archived', () => {
    const run = movesTo('ready', 'done');
    expect(run?.before).not.toContain('blocked');
    expect(run?.before).not.toContain('archived');
  });

  it('fills the owner and the time itself and asks for anything else', () => {
    const now = new Date('2026-11-23T10:00:00.000Z');
    expect(autoFacts(['ownerId', 'completedAt'], 'user-1', now)).toEqual({
      facts: { ownerId: 'user-1', completedAt: '2026-11-23T10:00:00.000Z' },
      ask: [],
    });
    expect(autoFacts(['ownerId', 'reopenReason'], null, now)).toEqual({
      facts: {},
      ask: ['ownerId', 'reopenReason'],
    });
  });
});

describe('the header decision (supervisor rule)', () => {
  it('lets a doer of a supervised work only send it for review', () => {
    expect(decisionFor('in_progress', ['boss'], 'doer', true)).toBe('review');
  });

  it('lets the supervisor approve a work waiting in review, and nobody else', () => {
    expect(decisionFor('internal_review', ['boss'], 'boss', true)).toBe('approve');
    expect(decisionFor('internal_review', ['boss'], 'doer', true)).toBeNull();
  });

  it('offers "Mark done" on an unsupervised work the reader may finish', () => {
    expect(decisionFor('in_progress', [], 'doer', true)).toBe('done');
    expect(decisionFor('in_progress', [], 'doer', false)).toBeNull();
  });

  it('offers nothing on a blocked, done or archived supervised work', () => {
    for (const state of ['blocked', 'done', 'archived'] as const) {
      expect(decisionFor(state, ['boss'], 'doer', true)).toBeNull();
    }
  });
});

describe('step order', () => {
  it('moves one step to a new place and keeps the rest in order', () => {
    expect(movedOrder(['a', 'b', 'c', 'd'], 'a', 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(movedOrder(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(movedOrder(['a', 'b'], 'b', 9)).toEqual(['a', 'b']);
    expect(movedOrder(['a', 'b'], 'x', 0)).toEqual(['a', 'b']);
  });
});
