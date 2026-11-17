import { describe, expect, it } from 'vitest';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { OutboxEffect } from '../outbox/dispatcher.js';
import type {
  StorageRootEmailFacts,
  StorageRootMailer,
} from '../notifications/storage-root-mailer.js';
import { composeStorageRootEmail } from '../notifications/storage-root-mailer.js';
import { createStorageRootAtRisk } from '../consumers/storage-root-at-risk.js';
import { storageRootCandidateOf } from '../common/database/storage-root-check-store.js';
import {
  storageRootRisk,
  sweepStorageRootCheck,
  weekOf,
  type StorageRootCandidate,
  type StorageRootCheckStore,
} from './storage-root-check.js';

/** 51-17 slice 2 — the weekly storage-root check and the owners' notice, through fakes. */

const ORG = 'org-a';
const candidate = (patch: Partial<StorageRootCandidate> = {}): StorageRootCandidate => ({
  organizationId: ORG,
  connectionId: 'conn-1',
  provider: 'google_drive',
  rootOwnerKind: 'shared_drive',
  holder: { role: 'org_admin', status: 'active' },
  ...patch,
});

describe('the weekly storage-root check', () => {
  it('flags a lost or demoted holder before a personal root, and nothing else', () => {
    expect(storageRootRisk(candidate())).toBeNull();
    expect(storageRootRisk(candidate({ rootOwnerKind: 'personal' }))).toBe('personal_root');
    expect(storageRootRisk(candidate({ holder: null }))).toBe('holder_not_admin');
    expect(
      storageRootRisk(candidate({ holder: { role: 'org_admin', status: 'offboarded' } })),
    ).toBe('holder_not_admin');
    expect(
      storageRootRisk(
        candidate({ rootOwnerKind: 'personal', holder: { role: 'member', status: 'active' } }),
      ),
    ).toBe('holder_not_admin');
    expect(
      storageRootCandidateOf({
        id: 'c',
        organization_id: ORG,
        provider: 'tmanage',
        root_owner_kind: 'unknown',
        holder_role: null,
        holder_status: null,
      }),
    ).toBeNull();
  });

  it('announces once per connection with the week in the key', async () => {
    const announced: unknown[] = [];
    let since: Date | null = null;
    const store: StorageRootCheckStore = {
      listCandidates: async (from) => {
        since = from;
        return [candidate({ rootOwnerKind: 'personal' }), candidate({ connectionId: 'conn-2' })];
      },
      announce: async (payload) => {
        announced.push(payload);
      },
    };
    const now = new Date('2026-11-18T10:00:00.000Z'); // a Wednesday
    expect(weekOf(now)).toBe('2026-11-16');
    const result = await sweepStorageRootCheck(store, now);
    expect(result).toEqual({ checked: 2, announced: 1 });
    expect(since).toEqual(new Date('2026-11-11T10:00:00.000Z'));
    expect(announced).toEqual([
      expect.objectContaining({
        connectionId: 'conn-1',
        reason: 'personal_root',
        idempotencyKey: 'conn-1:personal_root:2026-11-16',
      }),
    ]);
  });
});

describe('the owners are told, once', () => {
  const event = {
    id: 'ev-1',
    organizationId: ORG,
    type: 'storage_connection.root_at_risk.v1',
    payload: {
      organizationId: ORG,
      connectionId: 'conn-1',
      provider: 'onedrive',
      reason: 'holder_offboarded',
      idempotencyKey: 'conn-1:holder_offboarded:m-1:2',
      occurredAt: '2026-11-16T10:00:00.000Z',
    },
  } as unknown as ClaimedOutboxEvent;

  function fakeTx(seen: Set<string>) {
    const notices: unknown[][] = [];
    let lastInserted = false;
    const tx = {
      async query(sql: string, params: readonly unknown[] = []): Promise<unknown> {
        if (/FROM memberships/.test(sql)) {
          return [
            { user_id: 'u-owner', role: 'owner', has_org_wide_scope: 1 },
            { user_id: 'u-admin', role: 'org_admin', has_org_wide_scope: 1 },
          ];
        }
        if (/INSERT INTO notifications/.test(sql)) {
          const key = `${String(params[2])}:${String(params[6])}`;
          lastInserted = !seen.has(key);
          seen.add(key);
          notices.push([...params]);
          return {};
        }
        if (/SELECT id FROM notifications/.test(sql)) return lastInserted ? [{ id: 'n' }] : [];
        if (/FROM users u/.test(sql)) {
          return [
            {
              email: 'owner@example.com',
              display_name: 'Owner',
              email_enabled: 1,
              quiet_hours_start: null,
              quiet_hours_end: null,
              quiet_hours_timezone: null,
            },
          ];
        }
        throw new Error(`unexpected statement: ${sql}`);
      },
    } as unknown as WorkerTransaction;
    return { tx, notices };
  }

  it('writes the reference notice to owners only and mails each once', async () => {
    const sent: StorageRootEmailFacts[] = [];
    const mailer = {
      enabled: true,
      deliver: async (facts: StorageRootEmailFacts) => {
        sent.push(facts);
        return 'sent' as const;
      },
    } as unknown as StorageRootMailer;
    const handler = createStorageRootAtRisk(mailer);
    const seen = new Set<string>();
    for (let delivery = 0; delivery < 2; delivery += 1) {
      const staged: OutboxEffect[] = [];
      const { tx, notices } = fakeTx(seen);
      await handler(event, tx, { afterCommit: (effect) => staged.push(effect) });
      expect(notices).toHaveLength(1);
      expect(notices[0]?.slice(1)).toEqual([
        ORG,
        'u-owner',
        'storage_connection.root_at_risk.v1',
        'storage_connection',
        'conn-1',
        'storage_root:conn-1:holder_offboarded:m-1:2',
      ]);
      for (const effect of staged) await effect();
    }
    // The redelivery found the notice already there: no second mail.
    expect(sent).toEqual([
      {
        organizationId: 'org-a',
        recipientEmail: 'owner@example.com',
        recipientName: 'Owner',
        provider: 'onedrive',
        reason: 'holder_offboarded',
      },
    ]);
    expect(composeStorageRootEmail(sent[0] as StorageRootEmailFacts).subject).toBe(
      'Hand over your TManage OneDrive storage',
    );
  });
});
