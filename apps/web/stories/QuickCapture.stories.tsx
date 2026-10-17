import type { Meta, StoryObj } from '@storybook/react-vite';
import { QuickCaptureScreen } from '../src/components/screens/QuickCaptureScreen';
import { projectsClient, withStubbedNetwork } from './support/vr-fixtures';

/**
 * **Quick capture (modules 22/23 — the PWA companions' one entry point).** The capture sheet as a
 * share-target opens it: a title and note prefilled from a shared page, and the destination
 * project picker populated from the caller's projects (the first selected, so the common case is a
 * title and Enter). The refusing shell network keeps the shot off any real origin.
 */
const meta = {
  title: 'VR/Quick capture',
  component: QuickCaptureScreen,
  tags: ['vr'],
  decorators: [withStubbedNetwork],
  args: {
    organizationSlug: 'northstar',
    organizationName: 'Northstar Studio',
    draft: {
      title: 'Follow up on the launch checklist',
      note: 'Shared from the project brief\n\nhttps://northstar.example/doc/launch',
    },
    client: projectsClient(),
  },
} satisfies Meta<typeof QuickCaptureScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Sheet: Story = {};
