import type { Meta, StoryObj } from '@storybook/react-vite';
import { OrganizationSelectorScreen } from '../src/components/screens/OrganizationSelectorScreen';
import { emptyDirectoryClient } from './support/stub-client';

/**
 * **ID-04 Organization selector.**
 *
 * It fetches the directory the session can act in, so it needs a client that answers. The stub
 * returns `[]`, which is the empty state — the state a person meets on their first sign-in and
 * the one most likely to be got wrong, because it is the one nobody sees while developing.
 *
 * A populated story is deliberately absent rather than forgotten: `FIXTURE_ORGANIZATIONS` left
 * `src/lib/fixtures.ts` when TEN-001's directory endpoint arrived, and inventing a replacement
 * here would put back exactly the invented data that removal was meant to end.
 */
const meta = {
  title: 'Identity/ID-04 Organization selector',
  component: OrganizationSelectorScreen,
  args: { client: emptyDirectoryClient() },
} satisfies Meta<typeof OrganizationSelectorScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No organizations yet. */
export const Empty: Story = {};
