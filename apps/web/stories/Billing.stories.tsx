import type { Meta, StoryObj } from '@storybook/react-vite';
import { BillingSeatsScreen } from '../src/components/screens/BillingSeatsScreen';
import { BillingInvoicesScreen } from '../src/components/screens/BillingInvoicesScreen';
import { billingSeatsClient, invoicesClient, withStubbedNetwork } from './support/vr-fixtures';

/**
 * **Billing & entitlements (module 19).** The two owner-facing billing surfaces whose content a
 * visual baseline should pin: the seats table (memberships holding a licence against the plan) and
 * the invoice history (newest first, with its money and status columns). Both are gated on the
 * server by `org.manage`; here they render from mocked clients, and the refusing shell network
 * keeps the shot off any real origin.
 */
const meta = {
  title: 'VR/Billing',
  tags: ['vr'],
  decorators: [withStubbedNetwork],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** The active-seats table, with the assign form above it. */
export const Seats: Story = {
  render: () => (
    <BillingSeatsScreen
      organizationSlug="northstar"
      organizationName="Northstar Studio"
      client={billingSeatsClient()}
    />
  ),
};

/** The invoice history, newest first; no invoice is selected, so the detail stays closed. */
export const Invoices: Story = {
  render: () => (
    <BillingInvoicesScreen
      organizationSlug="northstar"
      organizationName="Northstar Studio"
      client={invoicesClient()}
    />
  ),
};
