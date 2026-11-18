import type { Meta, StoryObj } from '@storybook/react-vite';
import { PolicySimulationScreen } from '../src/components/screens/PolicySimulationScreen';
import {
  markVrReady,
  policySimulateClient,
  setReactSelectValue,
  waitForElement,
  withStubbedNetwork,
} from './support/vr-fixtures';

/**
 * **Access-policy simulation (Administration module 18).** The read-only "can this member do
 * this?" dry run, shown with a decision on screen — the surface that distinguishes this screen from
 * the plain policy form. The decision panel appears only after the form is submitted, so the play
 * picks a member by name and presses *Simulate*, waits for the result card to paint, and only then
 * lets the shot land; a baseline of a faked panel would certify markup the screen never renders.
 */
const meta = {
  title: 'VR/Policy simulation',
  component: PolicySimulationScreen,
  tags: ['vr'],
  decorators: [withStubbedNetwork],
  args: {
    organizationSlug: 'northstar',
    organizationName: 'Northstar Studio',
    client: policySimulateClient(),
  },
} satisfies Meta<typeof PolicySimulationScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The allow decision: a member is chosen, the simulation run, and the result region shown. */
export const Decision: Story = {
  tags: ['vr', 'vr-play'],
  play: async ({ canvasElement }) => {
    // The fieldset ships disabled until React hydrates, and the member list arrives after it;
    // wait for both before driving the form.
    await waitForElement(
      canvasElement,
      'fieldset:not([disabled]) select[name="memberId"] option[value="m-u-liam"]',
    );
    const member = await waitForElement<HTMLSelectElement>(
      canvasElement,
      'select[name="memberId"]',
    );
    setReactSelectValue(member, 'm-u-liam');
    const submit = await waitForElement<HTMLButtonElement>(
      canvasElement,
      'form[aria-label="Policy simulation"] button[type="submit"]',
    );
    submit.click();
    await waitForElement(canvasElement, '.tm-cc-card--ink');
    markVrReady();
  },
};
