import type { Meta, StoryObj } from '@storybook/react-vite';
import { PeopleDirectoryScreen } from '../src/components/screens/PeopleDirectoryScreen';
import { peopleClient, withStubbedNetwork } from './support/vr-fixtures';

/**
 * **People & capacity (module 14).** The organization roster every member uses to see who is here:
 * each person with the role they hold and how many projects they are on. The search starts empty,
 * so the baseline is the full list the screen opens onto.
 */
const meta = {
  title: 'VR/People directory',
  component: PeopleDirectoryScreen,
  tags: ['vr'],
  decorators: [withStubbedNetwork],
  args: {
    organizationSlug: 'northstar',
    organizationName: 'Northstar Studio',
    client: peopleClient(),
  },
} satisfies Meta<typeof PeopleDirectoryScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Directory: Story = {};
