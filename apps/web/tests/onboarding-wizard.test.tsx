import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OnboardingWizardScreen } from '../src/components/onboarding/OnboardingWizardScreen';
import { ApiClient } from '../src/lib/api/client';
import type { OnboardingWizardView, WizardStep } from '../src/lib/api/onboarding-wizard';
import { nextStep, parseInviteEmails, previousStep } from '../src/lib/onboarding/wizard';

/** 55-01 — the onboarding wizard: resume position, skip, and the invite parser. */

const STEPS: readonly WizardStep[] = [
  'company',
  'work_type',
  'invite',
  'storage',
  'sample_project',
  'finish',
];

function view(current: WizardStep, status: OnboardingWizardView['status'] = 'active') {
  const index = STEPS.indexOf(current);
  return {
    status,
    currentStep: current,
    steps: STEPS.map((step, i) => ({ step, outcome: i < index ? 'done' : null })),
  };
}

function mount(start: WizardStep) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      let body: unknown = view(start);
      if (url.endsWith('/dismiss')) body = view(start, 'dismissed');
      else if (url.includes('/integrations/'))
        body = { configured: false, googleDrive: {}, oneDrive: {} };
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
  const onLeave = vi.fn();
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={query}>
      <OnboardingWizardScreen organizationSlug="northstar" client={client} onLeave={onLeave} />
    </QueryClientProvider>,
  );
  return { calls, onLeave };
}

describe('OnboardingWizardScreen (55-01)', () => {
  it('resumes at the stored step and marks earlier steps done', async () => {
    mount('storage');
    expect(await screen.findByRole('heading', { name: 'Connect your storage' })).toBeTruthy();
    expect(screen.getByText('Step 4 of 6')).toBeTruthy();
    expect(screen.getByText('Connect storage').closest('li')?.getAttribute('aria-current')).toBe(
      'step',
    );
    expect(screen.getByText('Company').closest('li')?.getAttribute('data-state')).toBe('done');
  });

  it('skips a step by recording it as skipped, and Skip setup leaves for My Day', async () => {
    const { calls, onLeave } = mount('storage');
    await screen.findByRole('heading', { name: 'Connect your storage' });
    fireEvent.click(screen.getByRole('button', { name: 'Skip this step' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/onboarding/wizard/steps/storage'))).toBe(true),
    );
    expect(calls.find((c) => c.url.endsWith('/steps/storage'))?.body).toEqual({
      outcome: 'skipped',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup' }));
    await waitFor(() => expect(onLeave).toHaveBeenCalled());
  });

  it('moves between steps and parses invite addresses', () => {
    expect(nextStep('storage')).toBe('sample_project');
    expect(nextStep('finish')).toBe('finish');
    expect(previousStep('company')).toBeNull();
    expect(parseInviteEmails('a@x.io, B@x.io\nb@x.io; nope')).toEqual({
      valid: ['a@x.io', 'B@x.io'],
      invalid: ['nope'],
    });
  });
});
