import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  Combobox,
  DateField,
  Field,
  InlineAlert,
  Radio,
  RadioGroup,
  SearchField,
  Select,
  SkipLink,
  StateCapsule,
  StatusDot,
  Switch,
  ThemeProvider,
  TimeField,
  Toast,
  ToastRegion,
  Tooltip,
} from '../src/components/index.js';
import { expectNoAxeViolations } from './axe.js';

/** Every primitive at once — the surface the state matrix's theme columns apply to. */
function Surface({ title }: { title: string }) {
  return (
    <>
      <SkipLink targetId="main" />
      <main id="main">
        <h1>{title}</h1>
        <Button tone="lime">{title}</Button>
        <SearchField label={title} />
        <Field label={title} hint={title} />
        <Avatar name="Nadia Rahman" audience="client" />
        <StateCapsule state="current">{title}</StateCapsule>
        <StatusDot tone="live">{title}</StatusDot>
        <Badge mono>v4</Badge>
        <InlineAlert tone="client">{title}</InlineAlert>
        <Checkbox label={title} indeterminate />
        <RadioGroup legend={title} hint={title}>
          <Radio label={title} value="one" defaultChecked />
        </RadioGroup>
        <Switch label={title} defaultChecked />
        <Select label={title} hint={title}>
          <option value="">{title}</option>
        </Select>
        {/* A constant trigger label: the surface assertion queries one button by title. */}
        <Tooltip content={title} defaultOpen>
          <Button tone="outline">More</Button>
        </Tooltip>
        <ToastRegion>
          <Toast tone="success" onDismiss={() => {}}>
            {title}
          </Toast>
        </ToastRegion>
        <Combobox
          label={`${title}.`}
          options={[{ value: 'one', label: title }]}
          value="one"
          defaultOpen
        />
        <DateField label={`${title}..`} defaultValue="2026-09-15" hint={title} />
        <TimeField label={`${title}...`} defaultValue="14:30" />
      </main>
    </>
  );
}

describe('ThemeProvider', () => {
  it('applies theme, contrast, density and direction to the subtree it owns', () => {
    render(
      <ThemeProvider theme="dark" contrast="high" density="operational" dir="rtl" lang="ar">
        <span>محتوى</span>
      </ThemeProvider>,
    );

    const root = screen.getByText('محتوى').parentElement;
    expect(root).toHaveAttribute('data-theme', 'dark');
    expect(root).toHaveAttribute('data-contrast', 'high');
    expect(root).toHaveAttribute('data-density', 'operational');
    expect(root).toHaveAttribute('dir', 'rtl');
    expect(root).toHaveAttribute('lang', 'ar');
  });

  it('changes nothing outside itself, so a client preview can sit inside the app', () => {
    render(
      <ThemeProvider theme="light">
        <span>internal</span>
        <ThemeProvider theme="dark" lang="ar" dir="rtl">
          <span>portal preview</span>
        </ThemeProvider>
      </ThemeProvider>,
    );

    expect(document.documentElement).not.toHaveAttribute('data-theme');
    expect(screen.getByText('internal').parentElement).toHaveAttribute('data-theme', 'light');
    expect(screen.getByText('portal preview').parentElement).toHaveAttribute('data-theme', 'dark');
  });

  it('defaults to light, normal contrast, balanced density, English LTR', () => {
    render(
      <ThemeProvider>
        <span>default</span>
      </ThemeProvider>,
    );

    const root = screen.getByText('default').parentElement;
    expect(root).toHaveAttribute('data-theme', 'light');
    expect(root).toHaveAttribute('data-contrast', 'normal');
    expect(root).toHaveAttribute('data-density', 'balanced');
    expect(root).toHaveAttribute('dir', 'ltr');
  });
});

describe('SkipLink', () => {
  it('is the first thing the keyboard reaches, and points at the main region', async () => {
    render(<Surface title="Home" />);

    await userEvent.tab();
    const link = screen.getByRole('link', { name: 'Skip to main content' });
    expect(link).toHaveFocus();
    expect(link).toHaveAttribute('href', '#main');
    expect(document.getElementById('main')).not.toBeNull();
  });
});

describe('the whole primitive surface', () => {
  const ARABIC = 'مراجعة اتجاه الصفحة الرئيسية';
  const ENGLISH = 'Homepage direction';
  const LONG_ENGLISH =
    'Homepage direction, second revision, including the client-supplied photography brief and the revised delivery date';
  const LONG_ARABIC =
    'مراجعة اتجاه الصفحة الرئيسية، النسخة الثانية، بما في ذلك موجز التصوير المقدم من العميل وتاريخ التسليم المعدل';

  it.each([
    {
      name: 'light, English, LTR',
      theme: 'light',
      contrast: 'normal',
      dir: 'ltr',
      lang: 'en',
      title: ENGLISH,
    },
    {
      name: 'dark, English, LTR',
      theme: 'dark',
      contrast: 'normal',
      dir: 'ltr',
      lang: 'en',
      title: ENGLISH,
    },
    {
      name: 'high contrast, English, LTR',
      theme: 'light',
      contrast: 'high',
      dir: 'ltr',
      lang: 'en',
      title: ENGLISH,
    },
    {
      name: 'high contrast, dark',
      theme: 'dark',
      contrast: 'high',
      dir: 'ltr',
      lang: 'en',
      title: ENGLISH,
    },
    {
      name: 'light, Arabic, RTL',
      theme: 'light',
      contrast: 'normal',
      dir: 'rtl',
      lang: 'ar',
      title: ARABIC,
    },
    {
      name: 'dark, Arabic, RTL',
      theme: 'dark',
      contrast: 'normal',
      dir: 'rtl',
      lang: 'ar',
      title: ARABIC,
    },
    {
      name: 'long English label',
      theme: 'light',
      contrast: 'normal',
      dir: 'ltr',
      lang: 'en',
      title: LONG_ENGLISH,
    },
    {
      name: 'long Arabic label',
      theme: 'light',
      contrast: 'normal',
      dir: 'rtl',
      lang: 'ar',
      title: LONG_ARABIC,
    },
  ] as const)('has no axe violations: $name', async ({ theme, contrast, dir, lang, title }) => {
    const { container } = render(
      <ThemeProvider theme={theme} contrast={contrast} dir={dir} lang={lang}>
        <Surface title={title} />
      </ThemeProvider>,
    );

    // The accessible name survives the direction and the script — nothing is truncated
    // into the accessibility tree.
    expect(screen.getByRole('button', { name: title })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});
