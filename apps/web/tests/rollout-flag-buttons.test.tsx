import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODULE_ENABLED,
  type OptionalModuleFlag,
} from '../src/lib/api/admin-feature-flags';
import type { ApiClient } from '../src/lib/api/client';
import type { FilePreviewManifest } from '../src/lib/api/file-preview';
import type { WorkFormSummary } from '../src/lib/api/work-forms';
import { ExternalApproversPanel } from '../src/components/screens/approvals/ExternalApproversPanel';
import { WorkFormPublicLink } from '../src/components/screens/WorkFormPublicLink';
import { ThreadPanel } from '../src/components/viewer/ThreadPanel';

// 52-24: the three web entry points whose routes the server refuses while their flag is off.
const api = {
  request: vi.fn(async () => ({ data: { approvers: [] } })),
} as unknown as ApiClient;

/** The resolved flags as `FeatureOn` reads them, with one flag set; nothing is fetched. */
function mount(flag: OptionalModuleFlag, on: boolean, ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(['resolved-feature-flags', 'acme', 'shell'], {
    flags: { ...DEFAULT_MODULE_ENABLED, [flag]: on },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const FORM = {
  id: 'f1',
  name: 'Brief',
  published: false,
  publicSlug: null,
} as unknown as WorkFormSummary;

/** The server folds the `proofing` flag into the manifest: off, nothing may be commented. */
function manifestFor(proofing: boolean) {
  return {
    capabilities: { canReview: proofing, canComment: proofing },
    file: { projectId: 'p1' },
    versions: { versions: [] },
  } as unknown as FilePreviewManifest;
}

function threadPanel(proofing: boolean) {
  return (
    <ThreadPanel
      api={api}
      organizationSlug="acme"
      manifest={manifestFor(proofing)}
      threads={[]}
      threadsLoading={false}
      threadsError={null}
      selectedThreadId={null}
      pageNo={null}
      stageAcceptsPins={false}
      naturalSize={null}
      onSelect={() => undefined}
      onStartPin={() => undefined}
      onCreateGeneral={() => undefined}
      creatingGeneral={false}
      createGeneralError={null}
      onChanged={async () => undefined}
    />
  );
}

function approvers() {
  return (
    <ExternalApproversPanel
      api={api}
      organizationSlug="acme"
      deliverableId="d1"
      versionId="v1"
      versionNo={2}
    />
  );
}

describe('52-24 web buttons follow their rollout flag', () => {
  it.each([false, true])('proofing "Add comment" shows only while on (%s)', (on) => {
    mount('proofing', on, threadPanel(on));
    expect(screen.queryByRole('button', { name: 'Add comment' }) !== null).toBe(on);
  });

  it.each([false, true])('"Send for approval" shows only while approval_links is on (%s)', (on) => {
    mount('approval_links', on, approvers());
    expect(screen.queryByRole('heading', { name: /Send for approval/u }) !== null).toBe(on);
  });

  it.each([false, true])('"Share a public link" shows only while public_forms is on (%s)', (on) => {
    mount('public_forms', on, <WorkFormPublicLink api={api} organizationSlug="acme" form={FORM} />);
    expect(screen.queryByRole('button', { name: 'Share a public link' }) !== null).toBe(on);
  });
});
