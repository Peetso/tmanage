import { describe, expect, it } from 'vitest';
import {
  parseFlagLockList,
  percentageBucketOfDigest,
  resolveFlagChain,
  rolloutIncludesBucket,
} from './flag-chain.js';
import type { FlagChainInput, PlatformFlagLayer } from './flag-chain.js';

const layer = (patch: Partial<PlatformFlagLayer>): PlatformFlagLayer => ({
  enabled: true,
  rollout: 'everyone',
  percentage: null,
  allowlist: [],
  ...patch,
});

const base: FlagChainInput = {
  organizationId: 'org-1',
  lock: undefined,
  override: undefined,
  orgRow: undefined,
  layer: undefined,
  bucket: () => 50,
  codeDefault: false,
};

describe('flag chain', () => {
  it('lock → override → org row → platform rollout → code default', () => {
    expect(resolveFlagChain({ ...base, lock: false, override: true, orgRow: true })).toBe(false);
    expect(resolveFlagChain({ ...base, override: true, orgRow: false })).toBe(true);
    expect(resolveFlagChain({ ...base, orgRow: true, layer: layer({ enabled: false }) })).toBe(
      true,
    );
    expect(resolveFlagChain({ ...base, layer: layer({}) })).toBe(true);
    expect(resolveFlagChain(base)).toBe(false);
  });

  it('a rollout that misses the organization leaves the code default', () => {
    const allowlist = layer({ rollout: 'allowlist', allowlist: ['org-2'] });
    expect(resolveFlagChain({ ...base, layer: allowlist })).toBe(false);
    expect(rolloutIncludesBucket(allowlist, 0, 'org-2')).toBe(true);
    const percent = layer({ rollout: 'percentage', percentage: 50 });
    expect(rolloutIncludesBucket(percent, 49, 'org-1')).toBe(true);
    expect(rolloutIncludesBucket(percent, 50, 'org-1')).toBe(false);
  });

  it('bucket = first four digest bytes big-endian mod 100', () => {
    expect(percentageBucketOfDigest(new Uint8Array([0, 0, 0, 199, 9]))).toBe(99);
    expect(percentageBucketOfDigest(new Uint8Array([255, 255, 255, 255]))).toBe(4294967295 % 100);
  });

  it('parses locks, ignoring unknown keys and junk', () => {
    const isKey = (value: unknown): value is 'a' | 'b' => value === 'a' || value === 'b';
    expect(parseFlagLockList('a=on, b=OFF, c=on, junk', isKey)).toEqual({ a: true, b: false });
    expect(parseFlagLockList(undefined, isKey)).toEqual({});
  });
});
