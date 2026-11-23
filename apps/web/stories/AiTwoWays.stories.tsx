import type { Meta, StoryObj } from '@storybook/react-vite';
import { ApiClient } from '../src/lib/api/client';
import type { AiSettingsView } from '../src/lib/api/ai-settings';
import { AiSettingsScreen } from '../src/components/ai-admin/AiSettingsScreen';
import { withStubbedNetwork } from './support/vr-fixtures';

/**
 * **Control Center › AI › Settings: the two directions (AI-TWO-WAYS, plan 62 §Decision).** One
 * story per state of the settings read, each with both cards side by side — "TManage AI for your
 * company" and "Your own AI" — for the side-by-side with Figma G1 (770:44997 on, 770:46185 off,
 * 770:47104 error; v2 787:50837 off, 787:52370 could not load). Not a VR baseline: a design-review
 * capture of every state, with the bodies of `tests/ai-settings-screen.test.tsx`.
 */

const VIEW: AiSettingsView = {
  aiEnabled: true,
  writeScope: 'read_write',
  runAtOnce: false,
  fileReading: true,
  memberSharePercent: 50,
  conversationRetentionDays: 30,
  blockedMembers: [
    {
      membershipId: '44444444-4444-4444-8444-444444444444',
      displayName: 'Karim Aziz',
      blockedAt: '2026-11-02T09:00:00Z',
    },
  ],
  credits: {
    workspaceCredits: 2000,
    memberCredits: 1000,
    shareChoices: [
      { percent: 25, memberCredits: 500 },
      { percent: 50, memberCredits: 1000 },
      { percent: 75, memberCredits: 1500 },
      { percent: 100, memberCredits: 2000 },
    ],
  },
  providers: ['anthropic'],
  updatedAt: '2026-11-20T09:00:00Z',
  readiness: 'ready',
};

const MY_CLAUDE = {
  owner: true,
  viewerName: 'Lina',
  aiAccessEnabled: true,
  apps: [
    {
      id: 'g1',
      clientName: 'Claude Desktop',
      verified: true,
      scopes: [],
      memberName: 'Lina',
      mine: true,
      connectedAt: '2026-11-20T09:00:00Z',
      lastUsedAt: null,
    },
  ],
};

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

const failure = (status: number, code: string): Reply => ({
  status,
  body: { error: { code, message: 'x', correlationId: 'c' } },
});

/** The settings read answers `settings`; the member's own MCP connection is Claude Desktop. */
function client(settings: Reply): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      const url = String(input);
      const reply = url.includes('/copilot/settings')
        ? settings
        : url.includes('/oauth/grants')
          ? { status: 200, body: MY_CLAUDE }
          : failure(404, 'not_found');
      return Promise.resolve(
        new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-story',
    newCorrelationId: () => 'correlation-story',
  });
}

const meta = {
  title: 'Design review/AI two ways',
  component: AiSettingsScreen,
  decorators: [withStubbedNetwork],
  args: {
    organizationSlug: 'northstar',
    organizationName: 'Northstar Studio',
    client: client({ status: 200, body: VIEW }),
  },
} satisfies Meta<typeof AiSettingsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const On: Story = {};

export const Off: Story = {
  args: { client: client({ status: 200, body: { ...VIEW, aiEnabled: false } }) },
};

export const NoKeyYet: Story = {
  args: { client: client({ status: 200, body: { ...VIEW, readiness: 'no_key' } }) },
};

export const NotOnTestList: Story = {
  args: { client: client(failure(404, 'not_found')) },
};

export const NotOwner: Story = {
  args: { client: client(failure(403, 'forbidden')) },
};

export const CouldNotLoad: Story = {
  args: { client: client(failure(500, 'internal_error')) },
};
