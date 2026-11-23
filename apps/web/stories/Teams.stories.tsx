import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TeamsScreen } from '../src/components/screens/TeamsScreen';
import { ARABIC_STORY } from './support/arabic';
import { teamsClient } from './support/teams-fixtures';
import { PHONE_VIEWPORT } from '../.storybook/vr-viewport';

/**
 * The shell reads the person's role through its own browser client, which has no API in
 * Storybook; seed it as an owner (who may manage teams) so the page draws its write controls.
 */
const asOwner: Decorator = (Story) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['shell', 'organizations'], [{ slug: 'northstar', role: 'owner' }]);
  return (
    <QueryClientProvider client={client}>
      <Story />
    </QueryClientProvider>
  );
};

/**
 * **Work area v2 — Teams** (W-WEB-4; Figma `WV2-05` teams `936:98514`, AR `936:98752`, phone
 * `936:98842`; `WV2-06` New team `936:98934` and the phone team page `936:99481`; `WV2-09` no
 * teams yet `939:99993`, team with no members `939:100244`, delete-team confirm `939:100915`).
 * People's own menu, the team list with faces, and the chosen team edited in place.
 */
const meta = {
  title: 'People/Teams',
  component: TeamsScreen,
  tags: ['vr'],
  decorators: [asOwner],
  args: {
    organizationSlug: 'northstar',
    organizationName: 'Northstar Studio',
    client: teamsClient(),
  },
} satisfies Meta<typeof TeamsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Four teams; Design open with its five people. */
export const Filled: Story = {};

/** The same page in real Arabic. */
export const FilledArabic: Story = {
  ...ARABIC_STORY,
  args: { client: teamsClient({ arabic: true }) },
};

/** Phone: the team list as its own page. */
export const Phone: Story = {
  globals: { viewport: { value: PHONE_VIEWPORT } },
};

/** Phone: one team as its own page, with "‹ Teams". */
export const PhoneTeam: Story = {
  globals: { viewport: { value: PHONE_VIEWPORT } },
  args: { initialTeamId: 'team-1' },
};

/** New team, with a name and three people chosen. */
export const NewTeam: Story = {
  tags: ['vr-fullpage'],
  args: {
    initialDialog: 'new',
    initialDraft: {
      name: 'Brand studio',
      people: [
        { membershipId: 'm-sara', userId: 'u-sara', displayName: 'Sara Adel' },
        { membershipId: 'm-mona', userId: 'u-mona', displayName: 'Mona Rashad' },
        { membershipId: 'm-youssef', userId: 'u-youssef', displayName: 'Youssef Tarek' },
      ],
    },
  },
};

/** Delete the team: the people stay, only the team goes. */
export const DeleteTeam: Story = {
  tags: ['vr-fullpage'],
  args: { initialDialog: 'delete' },
};

/** No team yet: what teams are for, and New team. */
export const NoTeams: Story = {
  args: { client: teamsClient({ empty: true }) },
};

/** A team with nobody in it yet. */
export const NoMembers: Story = {
  args: { client: teamsClient({ designEmpty: true }) },
};
