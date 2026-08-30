import type { Meta, StoryObj } from '@storybook/react-vite';
import { Combobox } from '../src/components/Combobox.js';
import { DateField, TimeField } from '../src/components/DateField.js';

const PEOPLE = [
  { value: 'nr', label: 'Nadia Rahman' },
  { value: 'jp', label: 'Jonas Petersen' },
  { value: 'ah', label: 'Amina Haddad' },
];

const meta = {
  title: '02 Primitives/Pickers',
  component: Combobox,
  args: { label: 'Owner', options: PEOPLE },
} satisfies Meta<typeof Combobox>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The open popup is `defaultOpen` — the harness cannot type. The chosen option carries
 * `aria-selected` and its weight; the active-option paint only appears under keyboard
 * traversal, which the unit suite covers.
 */
export const Comboboxes: Story = {
  render: () => (
    <div
      style={{
        display: 'grid',
        gap: 'var(--s5)',
        maxWidth: 'var(--reading)',
        paddingBlockEnd: 'calc(var(--row) * 5)',
      }}
    >
      <Combobox label="Owner" options={PEOPLE} hint="Start typing a name." />
      <Combobox label="Refused" options={PEOPLE} error="Pick an owner from the list." />
      <Combobox label="Open, one chosen" options={PEOPLE} value="jp" defaultOpen />
    </div>
  ),
};

/**
 * A calendar day and a wall-clock time, both carried as the strings the native controls
 * speak — the DATE-migration convention surfacing in the component layer.
 */
export const DateAndTime: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 'var(--s5)', maxWidth: 'var(--reading)' }}>
      <DateField
        label="Committed day"
        defaultValue="2026-09-15"
        hint="The day you are promising."
      />
      <DateField label="Refused" error="A committed day cannot be in the past." required />
      <DateField label="Locked" disabled defaultValue="2026-09-15" />
      <TimeField label="Handoff time" defaultValue="14:30" hint="Their local afternoon." />
    </div>
  ),
};
