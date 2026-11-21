import { describe, expect, it } from 'vitest';
import { poolKey } from './copilot-chat.adapters.js';

describe('poolKey', () => {
  it('uses the pool key when it is set', () => {
    expect(
      poolKey(
        { AI_ANTHROPIC_KEY: ' own ', COPILOT_PROVIDER: 'anthropic', COPILOT_API_KEY: 'copilot' },
        'customers',
      ),
    ).toBe('own');
  });

  it('falls back to the Anthropic copilot key for the customers pool', () => {
    expect(
      poolKey({ COPILOT_PROVIDER: 'Anthropic', COPILOT_API_KEY: 'copilot' }, 'customers'),
    ).toBe('copilot');
  });

  it('never falls back to a key from another provider', () => {
    expect(poolKey({ COPILOT_PROVIDER: 'openai', COPILOT_API_KEY: 'copilot' }, 'customers')).toBe(
      '',
    );
  });

  it('never falls back for the testing pool', () => {
    expect(poolKey({ COPILOT_PROVIDER: 'anthropic', COPILOT_API_KEY: 'copilot' }, 'testing')).toBe(
      '',
    );
  });
});
