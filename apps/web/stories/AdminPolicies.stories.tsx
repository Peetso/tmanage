import type { Meta, StoryObj } from '@storybook/react-vite';
import { AdminPoliciesScreen } from '../src/components/screens/AdminPoliciesScreen';
import { orgPolicyClient, withStubbedNetwork } from './support/vr-fixtures';

/**
 * **Organization access policies (Administration module 18).** The policy editor seeded from the
 * stored document: session lifetime, the invite-domain allowlist, and the guest-access switch. The
 * form follows the read, so the baseline is the loaded, populated state a returning admin sees.
 */
const meta = {
  title: 'VR/Admin policies',
  component: AdminPoliciesScreen,
  tags: ['vr'],
  decorators: [withStubbedNetwork],
  args: {
    organizationSlug: 'northstar',
    organizationName: 'Northstar Studio',
    client: orgPolicyClient(),
  },
} satisfies Meta<typeof AdminPoliciesScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Policy: Story = {};
