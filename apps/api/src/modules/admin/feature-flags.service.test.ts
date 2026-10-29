import { describe, expect, it } from 'vitest';
import type { OrgFeatureFlagRow } from '../../common/database/schema.js';
import { parseFlagLocks, resolveFlag, resolveFlags } from './feature-flags.service.js';
import type { PlatformFlagContext } from './feature-flags.service.js';

/**
 * PA-10 · the org-side flag read chain: server lock → platform override → org row → platform
 * default (rollout applied) → code default.
 */

const ORG = '0199aa00-0000-7000-8000-0000000000c1';

function platform(over: Partial<PlatformFlagContext> = {}): PlatformFlagContext {
  return { organizationId: ORG, flags: {}, overrides: {}, locks: {}, ...over };
}

function row(flagKey: string, enabled: boolean): OrgFeatureFlagRow {
  return { flagKey, enabled } as OrgFeatureFlagRow;
}

describe('resolveFlag — the read chain', () => {
  it('code default when nothing is set (copilot off, chat on)', () => {
    expect(resolveFlag('copilot', undefined, platform())).toBe(false);
    expect(resolveFlag('chat', undefined, null)).toBe(true);
  });

  it('platform default applies when its rollout includes the organization', () => {
    const everyone = platform({
      flags: { copilot: { enabled: true, rollout: 'everyone', percentage: null, allowlist: [] } },
    });
    expect(resolveFlag('copilot', undefined, everyone)).toBe(true);
    const others = platform({
      flags: {
        copilot: { enabled: true, rollout: 'allowlist', percentage: null, allowlist: ['other'] },
      },
    });
    expect(resolveFlag('copilot', undefined, others)).toBe(false);
  });

  it('the organization’s own row beats the platform default', () => {
    const on = platform({
      flags: { copilot: { enabled: true, rollout: 'everyone', percentage: null, allowlist: [] } },
    });
    expect(resolveFlag('copilot', false, on)).toBe(false);
  });

  it('a platform override beats the organization’s own row', () => {
    expect(resolveFlag('chat', true, platform({ overrides: { chat: false } }))).toBe(false);
  });

  it('a server lock beats everything', () => {
    expect(
      resolveFlag('chat', true, platform({ overrides: { chat: true }, locks: { chat: false } })),
    ).toBe(false);
  });
});

describe('resolveFlags', () => {
  it('without a platform context the result is exactly the org-only fold', () => {
    const flags = resolveFlags([row('copilot', true), row('unknown', true)]);
    expect(flags.copilot).toBe(true);
    expect(flags.chat).toBe(true);
    expect(Object.keys(flags)).not.toContain('unknown');
  });

  it('applies the chain per key', () => {
    const flags = resolveFlags(
      [row('meetings', false)],
      platform({ overrides: { copilot: true } }),
    );
    expect(flags.copilot).toBe(true);
    expect(flags.meetings).toBe(false);
  });
});

describe('parseFlagLocks', () => {
  it('reads key=on|off pairs and ignores junk', () => {
    expect(parseFlagLocks('copilot=off, chat=on, nope=on, docs')).toEqual({
      copilot: false,
      chat: true,
    });
    expect(parseFlagLocks(undefined)).toEqual({});
  });
});
