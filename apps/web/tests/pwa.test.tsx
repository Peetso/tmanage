import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import manifest from '@/app/manifest';
import { ServiceWorkerRegister } from '@/components/pwa/ServiceWorkerRegister';

describe('web app manifest', () => {
  it('carries the required installable keys and at least one icon', () => {
    const result = manifest();
    expect(result.name).toBe('TManage');
    expect(result.start_url).toBe('/');
    expect(result.display).toBe('standalone');
    expect(result.theme_color).toBeTruthy();
    expect(result.background_color).toBeTruthy();
    expect(result.icons?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('ServiceWorkerRegister', () => {
  it('renders nothing and registers nothing when service workers are unsupported', () => {
    // jsdom's navigator has no `serviceWorker`, so the guard short-circuits.
    expect('serviceWorker' in navigator).toBe(false);
    const { container } = render(<ServiceWorkerRegister />);
    expect(container.firstChild).toBeNull();
  });
});
