import { describe, expect, it } from 'vitest';
import { deriveUpdateToastState } from '@/components/pwa/update-toast-state';

describe('deriveUpdateToastState (update-toast state machine)', () => {
  it('is hidden before any update — no worker is waiting', () => {
    expect(deriveUpdateToastState({ hasWaitingWorker: false, dismissed: false })).toBe('hidden');
  });

  it('is available once a worker is waiting and the offer stands', () => {
    expect(deriveUpdateToastState({ hasWaitingWorker: true, dismissed: false })).toBe('available');
  });

  it('is hidden again once the person dismisses the current offer', () => {
    expect(deriveUpdateToastState({ hasWaitingWorker: true, dismissed: true })).toBe('hidden');
  });

  it('stays hidden when dismissed with no waiting worker', () => {
    expect(deriveUpdateToastState({ hasWaitingWorker: false, dismissed: true })).toBe('hidden');
  });
});
