import type { Meta, StoryObj } from '@storybook/react-vite';
import { Checkbox } from '../src/components/Checkbox.js';
import { Radio, RadioGroup } from '../src/components/Radio.js';
import { Switch } from '../src/components/Switch.js';

const meta = {
  title: '02 Primitives/Selection',
  component: Checkbox,
  args: { label: 'Also publish to the client' },
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The checked box is ink and the mark is paper — law 2 keeps lime out of selection. The
 * mixed state is the bulk-select header standing over a partly-selected list.
 */
export const Checkboxes: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s4)', maxWidth: 'var(--reading)' }}>
      <Checkbox label="Unchecked" />
      <Checkbox label="Checked" defaultChecked />
      <Checkbox label="Some of them" indeterminate hint="Two of five items are selected." />
      <Checkbox label="Refused" error="Accept the terms before continuing." />
      <Checkbox label="Locked" disabled defaultChecked />
    </div>
  ),
};

export const Radios: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s6)', maxWidth: 'var(--reading)' }}>
      <RadioGroup legend="Audience" hint="Who can read this update.">
        <Radio label="Internal" value="internal" defaultChecked />
        <Radio label="Client-visible" value="client" hint="The client is notified." />
      </RadioGroup>
      <RadioGroup legend="Unanswered" error="Pick an audience before posting.">
        <Radio label="Internal" value="internal" />
        <Radio label="Client-visible" value="client" />
      </RadioGroup>
      <RadioGroup legend="Locked" disabled>
        <Radio label="Internal" value="internal" defaultChecked />
        <Radio label="Client-visible" value="client" />
      </RadioGroup>
    </div>
  ),
};

/**
 * The "on" track is ink, not lime: an enabled setting is a chosen value, not
 * current / next / live. The thumb travels in logical coordinates, so in the RTL variant
 * "on" is the reading-direction end without an override.
 */
export const Switches: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s4)', maxWidth: 'var(--reading)' }}>
      <Switch label="Off" />
      <Switch label="On" defaultChecked />
      <Switch label="With a hint" defaultChecked hint="Applies immediately." />
      <Switch label="Locked" disabled defaultChecked />
    </div>
  ),
};
