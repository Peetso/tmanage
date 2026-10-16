import { describe, expect, it } from 'vitest';
import { findDeepLinkArg, resolveDeepLink } from '../src/deep-link';

const LOCAL = 'http://localhost:3000';

describe('resolveDeepLink', () => {
  it('routes a tmanage:// link to the matching web route on the app origin', () => {
    expect(resolveDeepLink('tmanage://acme/home', LOCAL)).toBe('http://localhost:3000/acme/home');
  });

  it('accepts the empty-authority (triple slash) form', () => {
    expect(resolveDeepLink('tmanage:///acme/home', LOCAL)).toBe('http://localhost:3000/acme/home');
  });

  it('folds the authority label back into the path, not an origin', () => {
    expect(resolveDeepLink('tmanage://open/acme/inbox', LOCAL)).toBe(
      'http://localhost:3000/open/acme/inbox',
    );
  });

  it('preserves query string and hash (deep-link state restoration)', () => {
    expect(resolveDeepLink('tmanage://acme/projects/42?tab=files#notes', LOCAL)).toBe(
      'http://localhost:3000/acme/projects/42?tab=files#notes',
    );
  });

  it('resolves against a remote https origin', () => {
    expect(resolveDeepLink('tmanage://acme/home', 'https://app.tmanage.example')).toBe(
      'https://app.tmanage.example/acme/home',
    );
  });

  it('is case-insensitive about the scheme', () => {
    expect(resolveDeepLink('TMANAGE://acme/home', LOCAL)).toBe('http://localhost:3000/acme/home');
  });

  it('never escapes the app origin even when the authority looks like a host', () => {
    const resolved = resolveDeepLink('tmanage://evil.example.com/steal', LOCAL);
    expect(resolved).not.toBeNull();
    expect(new URL(resolved as string).origin).toBe('http://localhost:3000');
  });

  it('rejects a non-tmanage scheme', () => {
    expect(resolveDeepLink('https://evil.example.com/x', LOCAL)).toBeNull();
    expect(resolveDeepLink('file:///etc/passwd', LOCAL)).toBeNull();
  });

  it('rejects non-deep-link junk', () => {
    expect(resolveDeepLink('not a url', LOCAL)).toBeNull();
    expect(resolveDeepLink('tmanage:acme', LOCAL)).toBeNull();
    expect(resolveDeepLink('', LOCAL)).toBeNull();
  });

  it('returns null when the app base URL is itself invalid', () => {
    expect(resolveDeepLink('tmanage://acme/home', 'not-a-url')).toBeNull();
  });
});

describe('findDeepLinkArg', () => {
  it('finds the first tmanage:// entry in an argv array', () => {
    const argv = ['C:/app/electron.exe', '--flag', 'tmanage://acme/home'];
    expect(findDeepLinkArg(argv)).toBe('tmanage://acme/home');
  });

  it('is case-insensitive', () => {
    expect(findDeepLinkArg(['TMANAGE://x'])).toBe('TMANAGE://x');
  });

  it('returns null when no deep link is present', () => {
    expect(findDeepLinkArg(['electron.exe', '.', '--foo'])).toBeNull();
    expect(findDeepLinkArg([])).toBeNull();
  });
});
