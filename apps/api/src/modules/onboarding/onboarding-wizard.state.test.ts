import { describe, expect, it } from 'vitest';
import {
  dismissWizard,
  emptyWizardState,
  parseWizardState,
  recordStep,
  resumeStep,
  serializeWizardState,
  validateWizardStateValue,
} from './onboarding-wizard.state.js';
import type { WizardState } from './onboarding-wizard.state.js';

function record(state: WizardState, ...steps: Parameters<typeof recordStep>[1][]): WizardState {
  return steps.reduce((acc, step) => {
    const next = recordStep(acc, step, 'done');
    if ('error' in next) throw new Error(next.error);
    return next;
  }, state);
}

describe('onboarding wizard state (55-01)', () => {
  it('a fresh wizard starts at the company step', () => {
    expect(resumeStep(emptyWizardState())).toBe('company');
    expect(serializeWizardState(emptyWizardState())).toBe('v1;active;');
  });

  it('resumes at the first step without an outcome, after a round trip through storage', () => {
    const skipped = recordStep(
      record(emptyWizardState(), 'company', 'work_type'),
      'invite',
      'skipped',
    );
    if ('error' in skipped) throw new Error('unexpected');
    const stored = serializeWizardState(skipped);
    expect(stored).toBe('v1;active;company=d,work_type=d,invite=s');
    expect(resumeStep(parseWizardState(stored))).toBe('storage');
  });

  it('finish completes the wizard and cannot be skipped', () => {
    expect(recordStep(emptyWizardState(), 'finish', 'skipped')).toEqual({
      error: 'finish_cannot_be_skipped',
    });
    expect(record(emptyWizardState(), 'finish').status).toBe('completed');
  });

  it('dismiss keeps progress, and recording a step reopens it', () => {
    const dismissed = dismissWizard(record(emptyWizardState(), 'company'));
    expect(dismissed.status).toBe('dismissed');
    expect(resumeStep(dismissed)).toBe('work_type');
    expect(record(dismissed, 'work_type').status).toBe('active');
    expect(dismissWizard(record(emptyWizardState(), 'finish')).status).toBe('completed');
  });

  it('a damaged row reads as a fresh wizard and is refused as a setting value', () => {
    for (const bad of ['', 'v2;active;', 'v1;bogus;', 'v1;active;company=x', 'v1;active;a=d']) {
      expect(parseWizardState(bad)).toEqual(emptyWizardState());
      expect(validateWizardStateValue(bad).ok).toBe(false);
    }
    expect(validateWizardStateValue(' v1;dismissed;storage=s ')).toEqual({
      ok: true,
      value: 'v1;dismissed;storage=s',
    });
  });
});
