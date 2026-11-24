import type { Meta, StoryObj } from '@storybook/react-vite';
import { PHONE_VIEWPORT } from '../.storybook/vr-viewport';
import { ConsentScreen } from '../src/components/screens/ConsentScreen';
import { ApiClient } from '../src/lib/api/client';
import type { WorksAsOptionView } from '../src/lib/api/oauth-consent';
import { ARABIC_STORY } from './support/arabic';
import { withStubbedNetwork } from './support/vr-fixtures';

/**
 * **S5 consent, "This agent works as"** (plan 60 slice 60-07; design
 * `ai-employees-figma/AI-S5-consent-{EN,AR}-{desktop,phone}.png`). Peter Kamal, owner of Nile
 * Studio, connects Claude and may bind Mat and Nour; Rami is paused, so his row is dimmed with
 * the reason and cannot be chosen. Mat, the first available AI employee, is chosen, so the page
 * shows what Mat can and can never do. The design is drawn in the dark
 * theme; the VR harness shoots every story in light, dark and mirrored.
 */

const PARAMS = {
  client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
  resource: 'https://tmanage.example/mcp',
  state: 's1',
};

interface Cast {
  readonly person: string;
  readonly workspace: string;
  readonly aiEmployees: readonly WorksAsOptionView[];
}

function option(
  suffix: string,
  displayName: string,
  jobTitle: string,
  paused = false,
): WorksAsOptionView {
  return {
    id: `0190b8a0-0000-7000-8000-00000000000${suffix}`,
    displayName,
    jobTitle,
    available: !paused,
    unavailableReason: paused ? 'paused' : null,
  };
}

/** The English design's people. */
const ENGLISH: Cast = {
  person: 'Peter Kamal',
  workspace: 'Nile Studio',
  aiEmployees: [
    option('a', 'Mat', 'Social media designer'),
    option('b', 'Nour', 'Copywriter'),
    option('c', 'Rami', 'Research assistant', true),
  ],
};

/** The Arabic design names the same people in Arabic (names are data, not translated copy). */
const ARABIC: Cast = {
  person: 'بيتر كمال',
  workspace: 'نايل ستوديو',
  aiEmployees: [
    option('a', 'زياد', 'مصمم سوشيال ميديا'),
    option('b', 'نور', 'كاتبة محتوى'),
    option('c', 'رامي', 'مساعد أبحاث', true),
  ],
};

function respond(cast: Cast, url: string): unknown {
  if (url.includes('/v1/oauth/consent?')) {
    return {
      client: {
        name: 'Claude',
        verified: true,
        publisher: 'Anthropic',
        redirectHost: 'claude.ai',
        loopback: false,
      },
      requestedScopes: ['tmanage:read', 'tmanage:write'],
      platform: { offered: false, ready: false },
      ticket: '1000.ticket',
    };
  }
  if (url.endsWith('/v1/organizations')) {
    return {
      organizations: [
        {
          id: 'o1',
          slug: 'nile',
          name: cast.workspace,
          audience: 'internal',
          role: 'owner',
          clientOrganizationName: null,
        },
      ],
    };
  }
  if (url.endsWith('/oauth/consent/works-as')) return { aiEmployees: cast.aiEmployees };
  if (url.endsWith('/v1/sessions/current')) {
    return { account: { email: 'peter@example.test', displayName: cast.person } };
  }
  return {};
}

function castClient(cast: Cast): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-story',
    fetch: ((input: RequestInfo | URL) =>
      Promise.resolve(
        new Response(JSON.stringify(respond(cast, String(input))), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof globalThis.fetch,
  });
}

const meta = {
  title: 'Screens/Consent/Works as (S5)',
  component: ConsentScreen,
  tags: ['vr', 'vr-fullpage'],
  decorators: [withStubbedNetwork],
  args: { params: PARAMS, client: castClient(ENGLISH), navigate: () => {} },
} satisfies Meta<typeof ConsentScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = {};

export const Phone: Story = {
  globals: { viewport: { value: PHONE_VIEWPORT } },
};

export const DesktopArabic: Story = { ...ARABIC_STORY, args: { client: castClient(ARABIC) } };

export const PhoneArabic: Story = {
  ...ARABIC_STORY,
  args: { client: castClient(ARABIC) },
  globals: { direction: 'rtl', viewport: { value: PHONE_VIEWPORT } },
};
