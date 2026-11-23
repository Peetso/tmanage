import { describe, expect, it } from 'vitest';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { aiReadiness, poolKey } from './copilot-chat.adapters.js';
import type { ChatStanding } from './copilot-chat.service.js';

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

describe('aiReadiness (AI-TWO-WAYS)', () => {
  const standing = (over: Partial<ChatStanding>) => async (): Promise<ChatStanding> => ({
    onTestList: true,
    copilotFlag: true,
    aiEnabled: true,
    fileReading: true,
    memberBlocked: false,
    writeScope: 'read',
    poolClass: 'testing',
    runAtOnce: false,
    ...over,
  });
  const context = {} as TenantContext;

  it('names the module flag first, then the missing key of the workspace pool', async () => {
    const keys = new Set(['customers']);
    const hasKey = (pool: string) => keys.has(pool);
    expect(await aiReadiness(standing({ copilotFlag: false }), hasKey)(context)).toBe('flag_off');
    expect(await aiReadiness(standing({ poolClass: 'testing' }), hasKey)(context)).toBe('no_key');
    expect(await aiReadiness(standing({ poolClass: 'customers' }), hasKey)(context)).toBe('ready');
  });
});
