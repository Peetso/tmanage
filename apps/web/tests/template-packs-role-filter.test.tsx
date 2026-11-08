import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OnboardingWizardScreen } from '../src/components/onboarding/OnboardingWizardScreen';
import { TemplatePacksGallery } from '../src/components/projects/TemplatePacksGallery';
import { ApiClient } from '../src/lib/api/client';
import type { TemplatePackView } from '../src/lib/api/template-packs';
import { filterTemplatePacks } from '../src/lib/onboarding/template-pack-filter';

/** 55-02 starter packs by role and 54-23 Arabic agency packs: the filter and the gallery chips. */

function pack(key: string, partial: Partial<TemplatePackView>): TemplatePackView {
  return {
    key,
    name: key,
    description: `${key} description`,
    roles: ['agency_owner'],
    language: 'en',
    workWeek: 'mon_fri',
    templateNames: ['One'],
    docs: [],
    automations: [],
    installed: false,
    installedAt: null,
    ...partial,
  };
}

const PACKS: readonly TemplatePackView[] = [
  pack('starter-agency-owner', { name: 'Agency owner starter' }),
  pack('starter-accounting', { name: 'Accounting starter', roles: ['accounting'] }),
  pack('ar-agency-gulf', {
    name: 'حزمة وكالة الخليج',
    roles: ['agency_owner', 'marketing'],
    language: 'ar',
    workWeek: 'sun_thu',
  }),
];

describe('filterTemplatePacks (55-02, 54-23)', () => {
  it('narrows to a role and keeps every pack without one', () => {
    expect(filterTemplatePacks(PACKS, null, 'en').map((p) => p.key)).toEqual([
      'starter-agency-owner',
      'starter-accounting',
      'ar-agency-gulf',
    ]);
    expect(filterTemplatePacks(PACKS, 'marketing', 'en').map((p) => p.key)).toEqual([
      'ar-agency-gulf',
    ]);
  });

  it('puts the Arabic packs first in an Arabic interface', () => {
    expect(filterTemplatePacks(PACKS, 'agency_owner', 'ar-SA').map((p) => p.key)).toEqual([
      'ar-agency-gulf',
      'starter-agency-owner',
    ]);
  });
});

describe('TemplatePacksGallery role filter (55-02)', () => {
  it('filters the cards by the pressed role chip and badges the Arabic pack', async () => {
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ packs: PACKS }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )) as typeof globalThis.fetch,
      readCsrfToken: () => undefined,
      newCorrelationId: () => 'c',
    });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <TemplatePacksGallery api={client} organizationSlug="northstar" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Accounting starter')).toBeTruthy();
    expect(screen.getByText('Arabic')).toBeTruthy();
    expect(screen.getByText(/Sunday to Thursday week/)).toBeTruthy();

    const accounting = screen.getByRole('button', { name: 'Accounting' });
    fireEvent.click(accounting);
    expect(accounting.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText('Agency owner starter')).toBeNull();
    expect(screen.queryByText('حزمة وكالة الخليج')).toBeNull();
    expect(screen.getByText('Accounting starter')).toBeTruthy();
  });
});

describe('OnboardingWizardScreen starter-pack step (55-02)', () => {
  it('offers the packs for the chosen role', async () => {
    const steps = ['company', 'work_type', 'invite', 'storage', 'sample_project', 'finish'];
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((input: RequestInfo | URL) => {
        const body = String(input).includes('/templates/packs')
          ? { packs: PACKS }
          : {
              status: 'active',
              currentStep: 'sample_project',
              steps: steps.map((step, i) => ({ step, outcome: i < 4 ? 'done' : null })),
            };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }) as typeof globalThis.fetch,
      readCsrfToken: () => undefined,
      newCorrelationId: () => 'c',
    });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <OnboardingWizardScreen organizationSlug="northstar" client={client} onLeave={() => {}} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('radio', { name: /Accounting starter/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Marketing' }));
    expect(screen.queryByRole('radio', { name: /Accounting starter/ })).toBeNull();
    const gulf = screen.getByRole('radio', { name: /حزمة وكالة الخليج · Arabic/ });
    expect((gulf as HTMLInputElement).checked).toBe(true);
  });
});
