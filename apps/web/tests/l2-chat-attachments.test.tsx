import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChannelFileCard,
  ProjectChannelScreen,
} from '../src/components/screens/ProjectChannelScreen';
import { ApiClient } from '../src/lib/api/client';
import { getMessageAttachmentsBatched } from '../src/lib/api/message-attachments';
import type { MessageAttachmentSummary } from '../src/lib/api/message-attachments';
import { activeLocale } from '../src/lib/i18n/locale-store';
import { translate, type MessageKey } from '../src/lib/i18n/t';
import { expectNoAxeViolations } from './axe';

/**
 * L2 — chat attachments: one batched read per channel page (`GET …/conversations/:id/
 * attachments?messageIds=`) instead of one GET per message, and a file card that follows the
 * file's scan status (B5's "Not scanned" label, the blocked state, or "Not available") instead
 * of a bare `/files/:id/content` link that answers a raw 409. EN and AR.
 */

interface Call {
  readonly url: string;
  readonly method: string | undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientOver(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = { url: String(input), method: init?.method };
      calls.push(call);
      return Promise.resolve(handler(call));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls };
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const en = (key: string) => translate('en-US', key as MessageKey);
const ar = (key: string) => translate('ar-EG', key as MessageKey);

function file(
  fileAssetId: string,
  scanStatus?: MessageAttachmentSummary['scanStatus'],
): MessageAttachmentSummary {
  return {
    fileAssetId,
    name: `${fileAssetId}.pdf`,
    sizeBytes: 4096,
    attachedAt: '2026-10-25T10:00:00.000Z',
    ...(scanStatus === undefined ? {} : { scanStatus }),
  };
}

function renderCard(attachment: MessageAttachmentSummary) {
  return render(
    <ul>
      <ChannelFileCard
        file={attachment}
        href={`https://api.example.test/v1/organizations/northstar/files/${attachment.fileAssetId}/content`}
        isMobile={false}
      />
    </ul>,
  );
}

afterEach(() => {
  act(() => activeLocale.set('en-US'));
});

describe('L2 getMessageAttachmentsBatched', () => {
  it('sends the asks of one tick as one read and hands each message its own list', async () => {
    const { client, calls } = clientOver(() =>
      json({
        messages: [
          { messageId: 'msg-1', attachments: [file('f1')] },
          { messageId: 'msg-2', attachments: [] },
        ],
      }),
    );
    const [one, two, three] = await Promise.all([
      getMessageAttachmentsBatched(client, 'northstar', 'conv-1', 'msg-1'),
      getMessageAttachmentsBatched(client, 'northstar', 'conv-1', 'msg-2'),
      getMessageAttachmentsBatched(client, 'northstar', 'conv-1', 'msg-3'),
    ]);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/organizations/northstar/conversations/conv-1/attachments');
    expect(url.searchParams.get('messageIds')).toBe('msg-1,msg-2,msg-3');
    expect(one.map((a) => a.fileAssetId)).toEqual(['f1']);
    expect(two).toEqual([]);
    // A message the API did not answer for (another channel's id) reads as no attachments.
    expect(three).toEqual([]);
  });
});

describe('L2 channel file card (EN)', () => {
  it('opens a clean file', () => {
    renderCard(file('f1', 'clean'));
    expect(
      screen.getByRole('link', { name: `${en('ProjectChannelScreen.openFile')} f1.pdf` }),
    ).toHaveAttribute('href', expect.stringContaining('/files/f1/content'));
  });

  it('shows the Not scanned label and Download for a file not yet scanned, no bare link', async () => {
    const { container } = renderCard(file('f1', 'not_scanned'));
    expect(screen.getByText(en('DownloadScan.notScanned'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en('DownloadScan.download') })).toBeEnabled();
    expect(screen.queryByRole('link')).toBeNull();
    await expectNoAxeViolations(container);
  });

  it('shows the blocked state with Download disabled under "Block until scanned"', async () => {
    const { container } = renderCard(file('f1', 'being_checked'));
    expect(screen.getByText(en('WorkDetail.scanning'))).toBeInTheDocument();
    const download = screen.getByRole('button', { name: en('DownloadScan.download') });
    expect(download).toBeDisabled();
    expect(download).toHaveAccessibleDescription(en('DownloadScan.blocked'));
    expect(screen.queryByRole('link')).toBeNull();
    await expectNoAxeViolations(container);
  });

  it('says a file is not available rather than linking to it', () => {
    renderCard(file('f1', 'unavailable'));
    expect(screen.getByText(en('WorkDetail.unavailable'))).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('L2 channel file card (AR)', () => {
  it('labels every scan state in Arabic', () => {
    act(() => activeLocale.set('ar-EG'));
    const { unmount } = renderCard(file('f1', 'not_scanned'));
    expect(screen.getByText(ar('DownloadScan.notScanned'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ar('DownloadScan.download') })).toBeEnabled();
    unmount();

    const blocked = renderCard(file('f2', 'being_checked'));
    expect(screen.getByText(ar('WorkDetail.scanning'))).toBeInTheDocument();
    expect(screen.getByText(ar('DownloadScan.blocked'))).toBeInTheDocument();
    blocked.unmount();

    renderCard(file('f3', 'unavailable'));
    expect(screen.getByText(ar('WorkDetail.unavailable'))).toBeInTheDocument();
    expect(ar('DownloadScan.notScanned')).not.toBe(en('DownloadScan.notScanned'));
  });
});

const CONVERSATION = {
  id: 'conv-1',
  projectId: 'proj-1',
  name: 'atlas-relaunch',
  createdByUserId: 'user-1111',
  version: 1,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
  archivedAt: null,
};

const PROJECT = {
  id: 'proj-1',
  workspaceId: 'ws-1',
  name: 'Atlas Website Relaunch',
  status: 'active',
  ownerUserId: 'user-1111',
  committedAt: null,
  forecastAt: null,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
  archivedAt: null,
};

function message(id: string, sequenceNo: number) {
  return {
    id,
    conversationId: 'conv-1',
    authorUserId: 'user-aaaa-1111',
    sequenceNo,
    parentMessageId: null,
    body: `Message ${sequenceNo}`,
    bodyRich: null,
    editedAt: null,
    deletedAt: null,
    deletedByUserId: null,
    createdAt: '2026-08-27T10:00:00.000Z',
    updatedAt: '2026-08-27T10:00:00.000Z',
  };
}

function channelHandler(call: Call): Response {
  if (call.url.includes('/reactions')) return json({ tallies: [] });
  if (call.url.includes('/attachments')) {
    return json({
      messages: [
        { messageId: 'msg-1', attachments: [file('brief', 'not_scanned')] },
        { messageId: 'msg-2', attachments: [file('logo', 'clean')] },
        { messageId: 'msg-3', attachments: [] },
      ],
    });
  }
  if (call.url.includes('/members')) return json({ members: [] });
  if (call.url.includes('/messages')) {
    return json({ messages: [message('msg-1', 1), message('msg-2', 2), message('msg-3', 3)] });
  }
  if (call.url.includes('/conversations/conv-1')) return json(CONVERSATION);
  if (call.url.includes('/projects/proj-1')) return json(PROJECT);
  return json({}, 404);
}

describe('L2 ProjectChannelScreen attachments', () => {
  it('reads a page of attachments with one request and labels a not-scanned file', async () => {
    const { client, calls } = clientOver(channelHandler);
    render(
      withQuery(
        <ProjectChannelScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          conversationId="conv-1"
          client={client}
        />,
      ),
    );
    const card = (await screen.findByText('brief.pdf')).closest('li');
    expect(card).not.toBeNull();
    expect(within(card!).getByText(en('DownloadScan.notScanned'))).toBeInTheDocument();
    expect(within(card!).queryByRole('link')).toBeNull();
    expect(await screen.findByText('logo.pdf')).toBeInTheDocument();

    await waitFor(() => {
      const reads = calls.filter((call) => call.url.includes('/attachments'));
      expect(reads).toHaveLength(1);
    });
    const reads = calls.filter((call) => call.url.includes('/attachments'));
    const url = new URL(reads[0]!.url);
    expect(url.pathname).toBe('/v1/organizations/northstar/conversations/conv-1/attachments');
    expect(url.searchParams.get('messageIds')?.split(',').sort()).toEqual([
      'msg-1',
      'msg-2',
      'msg-3',
    ]);
    // No per-message read is left.
    expect(calls.some((call) => /\/messages\/[^/]+\/attachments/u.test(call.url))).toBe(false);
  });
});
