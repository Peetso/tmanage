import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../src/lib/api/errors';
import {
  audienceFailureMessage,
  clientPickerMode,
  mayConfirmAudience,
  widenRequest,
} from '../src/lib/work-item-client-audience';

describe('R36 F1 — choosing which clients see a task', () => {
  it('shows the client picker for a client-facing task even when the project has one client', () => {
    expect(clientPickerMode('client_visible', undefined, true, 1)).toBe('picker');
    expect(clientPickerMode('internal', 'client_action_required', true, 1)).toBe('picker');
    expect(clientPickerMode('internal', undefined, true, 3)).toBe('hidden');
    expect(clientPickerMode('client_visible', undefined, false, 0)).toBe('hidden');
  });

  it('says the project has no client instead of showing nothing', () => {
    expect(clientPickerMode('internal', 'client_visible', true, 0)).toBe('no-client');
    expect(clientPickerMode('client_action_required', undefined, true, 0)).toBe('no-client');
  });

  it('sends the ticked clients in the same request that widens the task', () => {
    expect(widenRequest(4, 'client_action_required', ['c1'], 2)).toEqual({
      version: 4,
      audience: 'client_action_required',
      clientOrganizationIds: ['c1'],
    });
    expect(widenRequest(4, 'client_visible', [], 0)).toEqual({
      version: 4,
      audience: 'client_visible',
    });
  });

  it('does not offer "client action needed" on a project with no client', () => {
    expect(mayConfirmAudience('client_action_required', 0, 0)).toBe(false);
    expect(mayConfirmAudience('client_visible', 0, 0)).toBe(true);
    expect(mayConfirmAudience('client_action_required', 2, 1)).toBe(true);
    expect(mayConfirmAudience('client_action_required', 2, 0)).toBe(false);
  });

  it('shows the server refusal as the sentence a person can act on', () => {
    const refused = new ApiRequestError(422, 'validation_failed', 'No client', 'corr', [
      { field: 'audience', message: 'link a client to this project first' },
    ]);
    expect(audienceFailureMessage(refused, 'fallback')).toBe('link a client to this project first');
    expect(audienceFailureMessage(new Error('boom'), 'fallback')).toBe('fallback');
  });
});
