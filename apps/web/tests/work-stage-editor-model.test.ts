import { describe, expect, it } from 'vitest';
import {
  addPosition,
  BUILT_IN_SET,
  canAddTo,
  checkSetName,
  checkStageName,
  copyOf,
  deleteBlock,
  editorSets,
  moveTargets,
  orderAfterDrop,
  orderAfterStep,
  startStages,
} from '../src/components/work/stages/stage-editor-model';
import type { StageSetView } from '../src/lib/api/work-stages';
import { stageSetsFixture } from '../stories/support/stage-fixtures';

/**
 * W-WEB-5 — the stages editor's rules, the same set rules the API holds
 * (`apps/api/src/modules/work/stages/stage-rules.ts` `checkSetRules`): ≥ 1 Not started, ≥ 1 In
 * progress, exactly one Done, a move stays inside its group, a deleted stage's works go to a
 * stage of the same state. Applying them on screen means no control is offered that could only
 * earn a 422.
 */

const [simple, design] = stageSetsFixture() as [StageSetView, StageSetView, StageSetView];
const stage = (id: string) => design.stages.find((s) => s.id === id)!;
const t = (key: string) => key.split('.').pop() ?? key;

describe('the stage set rules on screen', () => {
  it('never offers to delete the one Done stage, or the last Not started / In progress one', () => {
    expect(deleteBlock(design, stage('st-done'))).toBe('onlyDone');
    expect(deleteBlock(design, stage('st-empathize'))).toBe('lastNotStarted');
    expect(deleteBlock(simple, simple.stages[1]!)).toBe('lastInProgress');
    // Three In progress stages: any one of them may go; In review may be emptied.
    expect(deleteBlock(design, stage('st-ideate'))).toBeNull();
    expect(deleteBlock(design, stage('st-test'))).toBeNull();
  });

  it('offers a second stage in every group but Done', () => {
    expect(canAddTo(design, 'in_progress')).toBe(true);
    expect(canAddTo(design, 'in_review')).toBe(true);
    expect(canAddTo(design, 'done')).toBe(false);
  });

  it('adds a stage after the last stage of its group, in the whole set’s order', () => {
    expect(addPosition(design, 'not_started')).toBe(1);
    expect(addPosition(design, 'in_progress')).toBe(4);
    expect(addPosition(design, 'in_review')).toBe(5);
    const noReview = stageSetsFixture({ emptyReview: true })[1]!;
    expect(addPosition(noReview, 'in_review')).toBe(4);
  });

  it('moves a deleted stage’s works only to a stage of the same state (the API’s rule)', () => {
    expect(moveTargets(design, stage('st-ideate')).map((s) => s.id)).toEqual([
      'st-define',
      'st-prototype',
    ]);
    expect(moveTargets(design, stage('st-test'))).toEqual([]);
  });
});

describe('reordering', () => {
  it('steps a stage up or down inside its group and stops at the group’s edge', () => {
    expect(orderAfterStep(design, 'st-ideate', -1)).toEqual([
      'st-empathize',
      'st-ideate',
      'st-define',
      'st-prototype',
      'st-test',
      'st-done',
    ]);
    // Define is first of In progress: it does not climb into Not started.
    expect(orderAfterStep(design, 'st-define', -1)).toBeNull();
    expect(orderAfterStep(design, 'st-prototype', 1)).toBeNull();
  });

  it('drops a dragged stage after a later target and before an earlier one, never across groups', () => {
    expect(orderAfterDrop(design, 'st-define', 'st-prototype')).toEqual([
      'st-empathize',
      'st-ideate',
      'st-prototype',
      'st-define',
      'st-test',
      'st-done',
    ]);
    expect(orderAfterDrop(design, 'st-prototype', 'st-define')?.slice(1, 4)).toEqual([
      'st-prototype',
      'st-define',
      'st-ideate',
    ]);
    expect(orderAfterDrop(design, 'st-define', 'st-test')).toBeNull();
    expect(orderAfterDrop(design, 'st-define', 'st-define')).toBeNull();
  });
});

describe('names', () => {
  it('trims a stage name and refuses an empty, too long or repeated one', () => {
    expect(checkStageName('  Research ', design)).toEqual({ name: 'Research' });
    expect(checkStageName('   ', design)).toEqual({ error: 'empty' });
    expect(checkStageName('x'.repeat(121), design)).toEqual({ error: 'tooLong' });
    expect(checkStageName('Define', design)).toEqual({ error: 'taken' });
    // Renaming a stage to its own name is not a clash.
    expect(checkStageName('Define', design, 'st-define')).toEqual({ name: 'Define' });
  });

  it('refuses a set name another set has, ignoring the built-in stages', () => {
    const sets = editorSets(stageSetsFixture());
    expect(checkSetName('Simple', sets)).toEqual({ error: 'taken' });
    expect(checkSetName('Simple', sets, 'set-simple')).toEqual({ name: 'Simple' });
    expect(checkSetName('Default', [BUILT_IN_SET])).toEqual({ name: 'Default' });
  });

  it('copies a set under a name no set has yet', () => {
    const copy = copyOf(
      design,
      ['Design thinking copy', 'Design thinking copy 2'],
      'Design thinking copy',
      (s) => s.name,
    );
    expect(copy.name).toBe('Design thinking copy 3');
    expect(copy.stages.map((s) => [s.name, s.stateKey])).toEqual([
      ['Empathize', 'ready'],
      ['Define', 'in_progress'],
      ['Ideate', 'in_progress'],
      ['Prototype', 'in_progress'],
      ['Test', 'internal_review'],
      ['Done', 'done'],
    ]);
  });
});

describe('where a new set starts', () => {
  it('Design thinking is Empathize, Define, Ideate, Prototype, Test, Done in their states', () => {
    expect(startStages('designThinking', t)).toEqual([
      { name: 'empathize', stateKey: 'ready' },
      { name: 'define', stateKey: 'in_progress' },
      { name: 'ideate', stateKey: 'in_progress' },
      { name: 'prototype', stateKey: 'in_progress' },
      { name: 'test', stateKey: 'internal_review' },
      { name: 'done', stateKey: 'done' },
    ]);
  });

  it('every start meets the set rules (one Done, a Not started, an In progress)', () => {
    for (const start of ['simple', 'designThinking', 'empty'] as const) {
      const states = startStages(start, t).map((s) => s.stateKey);
      expect(states.filter((s) => s === 'done')).toHaveLength(1);
      expect(states.some((s) => s === 'ready' || s === 'backlog')).toBe(true);
      expect(states).toContain('in_progress');
    }
  });

  it('lists the built-in stages first only while no set is the workspace default', () => {
    expect(editorSets(stageSetsFixture())[0]?.id).toBe('set-simple');
    const none = stageSetsFixture().map((s) => ({ ...s, isDefault: false }));
    expect(editorSets(none)[0]).toBe(BUILT_IN_SET);
  });
});
