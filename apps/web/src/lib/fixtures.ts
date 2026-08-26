/**
 * Fixtures for the screens whose endpoints are not written.
 *
 * Every value here is invented, and it is gathered in one file so that it is obvious how
 * much of WEB-001 is not yet connected to anything. A screen renders a fixture only when the
 * page passes it one, and each of those screens carries a `BackendPending` notice naming the
 * ticket that replaces it. Nothing in `src/lib/api/` reads this file.
 *
 * The names are the design export's — Northstar Studio, Atlas Hospitality, Omar Adel — so
 * that a screen in the browser can be compared against the artboard it was built from
 * without a mental substitution.
 *
 * This file shrinks as tickets land. `FIXTURE_ORGANIZATIONS` left it when TEN-001's directory
 * endpoint arrived and `ID-04` began fetching its own list; `FIXTURE_OWNERS` left it when
 * PROJ-002 made `ON-03` real and the owner became a statement rather than a picker;
 * `FIXTURE_INVITATION` left when TEN-003 gave `ID-03` a token to resolve.
 */

export const FIXTURE_SIGNED_IN_AS = 'omar@northstar.studio';

export const FIXTURE_ORGANIZATION_DOMAIN = 'northstar.studio';

/**
 * The organization's display name, shown in the shell on every internal screen.
 *
 * A fixture because nothing returns one organization's profile by slug. `ID-04` fetches the
 * whole directory the session can act in, and reaching into that list from a work screen would
 * be a second request for a single string — so the name is invented here, once, and the
 * ticket that adds `GET /v1/organizations/:slug` removes it.
 */
export const FIXTURE_ORGANIZATION_NAME = 'Northstar Studio';

/**
 * The client organization's own name, shown to its own members in the portal header.
 *
 * A fixture for the same reason `FIXTURE_ORGANIZATION_NAME` is: nothing returns a client
 * organization's profile to the people inside it. `CLIENT-002`'s portal endpoints answer with
 * projects and work, not with who the reader is — the API knows, from the session, and has no
 * route that says so. Both names are cosmetic; every piece of data on the portal is real.
 */
export const FIXTURE_CLIENT_NAME = 'Atlas Hospitality';

export const FIXTURE_EXISTING_MEMBERS: readonly string[] = [
  'omar@northstar.studio',
  'karim@northstar.studio',
];
