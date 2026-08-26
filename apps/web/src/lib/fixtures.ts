import type { InvitationDetails } from '../components/screens/InvitationScreen';

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
 * PROJ-002 made `ON-03` real and the owner became a statement rather than a picker.
 */

export const FIXTURE_SIGNED_IN_AS = 'omar@northstar.studio';

export const FIXTURE_ORGANIZATION_DOMAIN = 'northstar.studio';

export const FIXTURE_EXISTING_MEMBERS: readonly string[] = [
  'omar@northstar.studio',
  'karim@northstar.studio',
];

export const FIXTURE_INVITATION: InvitationDetails = {
  inviterName: 'Omar Adel',
  inviterEmail: 'omar@northstar.studio',
  invitedAt: '13 August',
  organizationName: 'Atlas Hospitality',
  projectName: 'Website relaunch',
  roleName: 'Client Reviewer',
  roleQualifier: 'approval authority',
  audience: 'client',
  willSee: [
    'Progress and milestones for one project',
    'Deliverables published to you',
    'Your own actions and requests',
    'Three named contacts at Northstar Studio',
  ],
  willNotSee: 'You will not see internal tasks, costs, internal comments or other clients.',
  expiresOn: '20 August',
};
