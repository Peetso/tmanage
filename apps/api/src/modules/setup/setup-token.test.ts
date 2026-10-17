import { describe, expect, it } from 'vitest';
import { setupTokenMatches } from './setup-token.js';

const TOKEN = 'a'.repeat(40);

describe('setupTokenMatches', () => {
  it('accepts the configured token', () => {
    expect(setupTokenMatches(TOKEN, TOKEN)).toBe(true);
  });

  it('refuses a wrong, shorter, non-string or unconfigured token', () => {
    expect(setupTokenMatches(TOKEN, 'b'.repeat(40))).toBe(false);
    expect(setupTokenMatches(TOKEN, TOKEN.slice(1))).toBe(false);
    expect(setupTokenMatches(TOKEN, 42)).toBe(false);
    expect(setupTokenMatches(TOKEN, '')).toBe(false);
    expect(setupTokenMatches(null, TOKEN)).toBe(false);
    expect(setupTokenMatches(undefined, TOKEN)).toBe(false);
    expect(setupTokenMatches('', '')).toBe(false);
  });
});
