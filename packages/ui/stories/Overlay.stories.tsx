import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../src/components/Button.js';
import { Select } from '../src/components/Select.js';
import { Toast, ToastRegion } from '../src/components/Toast.js';
import { Tooltip } from '../src/components/Tooltip.js';

const meta = {
  title: '02 Primitives/Overlay',
  component: Select,
  args: { label: 'State', children: null },
} satisfies Meta<typeof Select>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Selects: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s5)', maxWidth: 'var(--reading)' }}>
      <Select label="State" hint="Filters the list below.">
        <option value="">Any state</option>
        <option value="in_progress">In progress</option>
        <option value="blocked">Blocked</option>
      </Select>
      <Select label="Owner" error="Pick an owner before assigning." required>
        <option value="">Unassigned</option>
        <option value="nr">Nadia Rahman</option>
      </Select>
      <Select label="Locked" disabled defaultValue="one">
        <option value="one">Fixed by the request</option>
      </Select>
    </div>
  ),
};

/**
 * The open bubble is `defaultOpen` — the harness cannot hover, and the closed state is
 * already every other story. The bubble is ink with paper text in both themes.
 */
export const Tooltips: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 'var(--s8)', paddingBlockStart: 'var(--s16)' }}>
      <Tooltip content="Publishes this update to the client portal." defaultOpen>
        <Button tone="outline">Publish</Button>
      </Tooltip>
      <Tooltip content="Closed until hovered or focused.">
        <Button tone="outline">Quiet</Button>
      </Tooltip>
    </div>
  ),
};

/**
 * The region is rendered `position: static` here so the shot frames the toasts rather
 * than an empty canvas with a fixed corner. Only the placement is overridden — the
 * region's role, name and paint are the component's own.
 */
export const Toasts: Story = {
  render: () => (
    <ToastRegion style={{ position: 'static' }}>
      <Toast>Copied to the clipboard.</Toast>
      <Toast tone="success">Work item created.</Toast>
      <Toast tone="warning">The client will be notified.</Toast>
      <Toast tone="danger" onDismiss={() => {}}>
        The transition was refused — the item moved meanwhile.
      </Toast>
    </ToastRegion>
  ),
};
