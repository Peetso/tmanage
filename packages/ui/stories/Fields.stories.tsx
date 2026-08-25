import type { Meta, StoryObj } from '@storybook/react-vite';
import { Field } from '../src/components/Field.js';
import { SearchField } from '../src/components/SearchField.js';

const meta = {
  title: '02 Primitives/Fields',
  component: Field,
  args: { label: 'Work item title' },
} satisfies Meta<typeof Field>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithHint: Story = {
  args: { hint: 'Say what changes, not what the task is called.' },
};

export const Required: Story = {
  args: { required: true, hint: 'Required before the item can leave triage.' },
};

/**
 * The asterisk is `aria-hidden` — `required` already carries the meaning to a screen
 * reader, and the glyph beside the message is a shape rather than a second colour.
 */
export const Invalid: Story = {
  args: {
    required: true,
    hint: 'Lower case, no spaces.',
    error: 'That slug is already taken in this workspace.',
  },
};

export const Disabled: Story = { args: { disabled: true, value: 'Locked', onChange: () => {} } };

export const ReadOnly: Story = {
  args: { readOnly: true, value: 'Set by the client request', onChange: () => {} },
};

export const Search: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 'var(--s4)', flexWrap: 'wrap' }}>
      <SearchField label="Search work items" placeholder="Search work items" />
      <SearchField label="Search, with a visible label" labelVisible placeholder="Search" />
    </div>
  ),
};

export const Stack: Story = {
  render: (args) => (
    <div style={{ display: 'grid', gap: 'var(--s5)', maxWidth: 'var(--reading)' }}>
      <Field {...args} label="Work item title" />
      <Field label="Owner" hint="Every item in progress has exactly one." />
      <Field label="Committed date" type="date" />
    </div>
  ),
};
