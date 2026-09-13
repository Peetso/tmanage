import { ApiClient } from '../../src/lib/api/client';

/**
 * `ApiClient`s for stories, none of which can reach a network.
 *
 * Every screen in `src/components/screens/` takes its transport through an injected
 * `ApiClient` and falls back to the browser client when none is passed. In a test that
 * fallback is harmless because jsdom has no network; in Storybook it is not — a person
 * pressing "Sign in" in a story would fire a real request at whatever origin
 * `public-config.ts` resolved at build time. So every story that mounts a screen with a
 * `client` prop passes one of these, and the `fetch` below is a function that returns a
 * response without ever calling `globalThis.fetch`.
 *
 * The bodies are the same ones `apps/web/tests/screens.test.tsx` uses, for the reason the
 * design system's stories give: two different fixtures for one screen means the story and
 * the test are looking at different screens, and only one of them is checked.
 */

const BASE: Pick<
  ConstructorParameters<typeof ApiClient>[0],
  'baseUrl' | 'csrfCookieName' | 'readCsrfToken' | 'newCorrelationId'
> = {
  baseUrl: 'https://api.example.test',
  csrfCookieName: 'tm_session_csrf',
  readCsrfToken: () => undefined,
  newCorrelationId: () => 'correlation-story',
};

function jsonClient(body: unknown, status = 200): ApiClient {
  return new ApiClient({
    ...BASE,
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof globalThis.fetch,
  });
}

/**
 * Answers the two directory reads the onboarding and selector screens make.
 *
 * `ID-04` asks for organizations and draws its empty state for `[]`; `ON-03` asks for
 * workspaces and cannot submit without one. One body carrying both keys is simpler than
 * routing on the URL, and neither screen reads the other's key.
 */
export function emptyDirectoryClient(): ApiClient {
  return jsonClient({
    organizations: [],
    workspaces: [{ id: 'ws-1', name: 'Northstar Studio', createdAt: '2026-08-26T00:00:00.000Z' }],
  });
}

/** Answers `ID-03`'s invitation preview with a resolved invitation. */
export function invitationPreviewClient(): ApiClient {
  return jsonClient({
    organizationName: 'Northstar Studio',
    inviterName: 'Omar Adel',
    inviterEmail: 'omar@northstar.studio',
    role: 'member',
    audience: 'internal',
    clientOrganizationName: null,
    invitedAt: '2026-08-26T00:00:00.000Z',
    expiresAt: '2026-09-09T00:00:00.000Z',
  });
}

/**
 * Refuses everything with a 503.
 *
 * The screens whose endpoints ID-002 and TEN-001 have not written yet are `disabled` and
 * never submit, but a story is a live screen and someone will press the control anyway. A
 * refusal is the honest answer — better than a hanging promise that leaves the screen in a
 * pending state it was never designed to hold.
 */
export function refusingClient(): ApiClient {
  return jsonClient(
    { type: 'about:blank', title: 'Not available', status: 503, detail: 'No API in Storybook.' },
    503,
  );
}

/** A 43-character token of the shape `ID-03`'s route produces. Not a real invitation. */
export const STORY_INVITATION_TOKEN = 'a'.repeat(43);
