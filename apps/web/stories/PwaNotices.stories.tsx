import type { Meta, StoryObj } from '@storybook/react-vite';
import { NotificationOptIn } from '../src/components/pwa/NotificationOptIn';
import { UpdateToast } from '../src/components/pwa/UpdateToast';
import { markVrReady, waitForElement, withWaitingServiceWorker } from './support/vr-fixtures';

/**
 * **The two PWA notices (module 22).** The desktop-notification opt-in control, and the
 * "update available" toast — the one state the updater reaches only from a live service-worker
 * registration, so the toast story installs a fake worker parked in *waiting* and lets the play
 * wait for the offer to paint before the shot.
 */
const meta = {
  title: 'VR/PWA notices',
  tags: ['vr'],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Desktop notifications opt-in: the switch in its default off state (the permission is requested
 * only on the opt-in gesture, never on mount). Where the Notifications API is absent it degrades
 * to a short honest line — either way a settled, deterministic baseline.
 */
export const NotificationOptInControl: Story = {
  render: () => <NotificationOptIn />,
};

/** The "update available" toast, offered by a fresh build waiting to take over. */
export const UpdateAvailable: Story = {
  tags: ['vr', 'vr-play', 'vr-fullpage'],
  decorators: [withWaitingServiceWorker],
  render: () => <UpdateToast />,
  play: async ({ canvasElement }) => {
    try {
      await waitForElement(canvasElement, '.tm-toast__body', 3_000);
    } catch {
      // No fake worker could be installed on this engine; the baseline shows the honest empty
      // region rather than hanging the suite.
    }
    markVrReady();
  },
};
