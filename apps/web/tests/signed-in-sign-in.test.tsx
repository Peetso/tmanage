import { describe, expect, it } from 'vitest';
import type { OrganizationSummary } from '../src/lib/api/organizations';
import { destinationForSignedIn } from '../src/lib/signed-in-destination';

/**
 * Live check f30af1d0, lane E2: a signed-in person's Continue on `/sign-in` goes into the app —
 * their workspace home, or the picker when they have several — never to `/forbidden`, and
 * never to another host. The signed-in card itself: `session-check.test.tsx` (AUTHSTATE).
 */

function org(slug: string, audience: 'internal' | 'client' = 'internal'): OrganizationSummary {
  return {
    id: `id-${slug}`,
    slug,
    name: slug,
    audience,
    role: 'owner',
    clientOrganizationName: null,
  };
}

describe('destinationForSignedIn', () => {
  it('sends one internal workspace to its home and one client workspace to its portal', () => {
    expect(destinationForSignedIn([org('northstar')], null)).toBe('/northstar/home');
    expect(destinationForSignedIn([org('acme', 'client')], null)).toBe('/acme/portal');
  });

  it('sends several workspaces to the picker', () => {
    expect(destinationForSignedIn([org('a'), org('b')], null)).toBe('/organizations');
  });

  it('keeps the sign-in page when the person has no workspace', () => {
    expect(destinationForSignedIn([], null)).toBeUndefined();
  });

  it('honours an allowed ?next= and ignores a foreign or unknown one', () => {
    const invitation = `/invitations/${'a'.repeat(43)}`;
    expect(destinationForSignedIn([org('a')], invitation)).toBe(invitation);
    for (const next of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/forbidden',
    ]) {
      expect(destinationForSignedIn([org('a')], next)).toBe('/a/home');
    }
  });

  it('never builds a path from a slug that could leave the site', () => {
    expect(destinationForSignedIn([org('/evil.example')], null)).toBe('/organizations');
    expect(destinationForSignedIn([org('\\evil.example')], null)).toBe('/organizations');
  });
});
