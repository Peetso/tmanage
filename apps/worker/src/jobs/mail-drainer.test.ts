import { describe, expect, it, vi } from 'vitest';
import { QueueMailer } from '@tmanage/mail';
import type { MailLane, MailMessage, MailQueueEntry, Mailbox } from '@tmanage/mail';
import type { ClaimedMail, MailQueueStore } from '../common/database/mail-queue-store.js';
import { createMailDrainerState, drainMailOnce } from './mail-drainer.js';

/** An in-memory `mail_queue` with the store's claim/defer/requeue semantics. */
interface Row extends MailQueueEntry {
  status: string;
  attempts: number;
  claimToken: string | null;
  availableAt: Date;
  sentVia?: Mailbox;
  error?: string;
}

function fakeStore(settings: Record<string, string> = {}) {
  const rows: Row[] = [];
  const windows = new Map<string, number>();
  const byAge = (a: Row, b: Row) =>
    a.availableAt.getTime() - b.availableAt.getTime() || (a.id < b.id ? -1 : 1);
  const owned = (id: string, token: string) =>
    rows.find((r) => r.id === id && r.claimToken === token);
  const store: MailQueueStore = {
    enqueue: (entry) =>
      Promise.resolve(
        void rows.push({ ...entry, status: 'queued', attempts: 0, claimToken: null }),
      ),
    recoverStale: (now, before) => {
      let n = 0;
      for (const r of rows.filter((x) => x.status === 'sending' && x.availableAt < before)) {
        if (r.attempts <= 1)
          Object.assign(
            r,
            { status: 'queued', claimToken: null, availableAt: now },
            ((n += 1), {}),
          );
        else Object.assign(r, { status: 'failed', claimToken: null, error: 'stale' });
      }
      return Promise.resolve(n);
    },
    requeueDue: (now) => {
      const due = rows.filter((r) => r.status === 'deferred' && r.availableAt <= now);
      for (const r of due) r.status = 'queued';
      return Promise.resolve(due.length);
    },
    settings: (keys) =>
      Promise.resolve(
        new Map(keys.filter((k) => k in settings).map((k) => [k, settings[k] as string])),
      ),
    windowCounts: (start) =>
      Promise.resolve(
        new Map<Mailbox, number>(
          (['security', 'noreply'] as const).map((m) => [
            m,
            windows.get(`${m}@${start.toISOString()}`) ?? 0,
          ]),
        ),
      ),
    claim: (lane, limit, token, now) => {
      const take = rows
        .filter((r) => r.status === 'queued' && r.lane === lane && r.availableAt <= now)
        .sort(byAge)
        .slice(0, limit);
      for (const r of take)
        Object.assign(r, {
          status: 'sending',
          claimToken: token,
          attempts: r.attempts + 1,
          availableAt: now,
        });
      return Promise.resolve(take.map((r): ClaimedMail => ({ ...r, deadlineAt: r.deadlineAt })));
    },
    deferQueued: (lane, now, until) => {
      const left = rows.filter(
        (r) => r.status === 'queued' && r.lane === lane && r.availableAt <= now,
      );
      for (const r of left) Object.assign(r, { status: 'deferred', availableAt: until });
      return Promise.resolve(left.length);
    },
    countWindow: (mailbox, start) => {
      const key = `${mailbox}@${start.toISOString()}`;
      windows.set(key, (windows.get(key) ?? 0) + 1);
      return Promise.resolve();
    },
    markSent: (id, token, mailbox) =>
      Promise.resolve(
        void Object.assign(owned(id, token) ?? {}, {
          status: 'sent',
          claimToken: null,
          sentVia: mailbox,
        }),
      ),
    markFailed: (id, token, error) =>
      Promise.resolve(
        void Object.assign(owned(id, token) ?? {}, { status: 'failed', claimToken: null, error }),
      ),
    markSuppressed: (id, token) =>
      Promise.resolve(
        void Object.assign(owned(id, token) ?? {}, { status: 'suppressed', claimToken: null }),
      ),
    retryLater: (id, token, at) =>
      Promise.resolve(
        void Object.assign(owned(id, token) ?? {}, {
          status: 'queued',
          claimToken: null,
          availableAt: at,
        }),
      ),
    deferredCounts: () =>
      Promise.resolve({
        auth: rows.filter((r) => r.status === 'deferred' && r.lane === 'auth').length,
        transactional: rows.filter((r) => r.status === 'deferred' && r.lane === 'transactional')
          .length,
      }),
    purge: () => Promise.resolve(),
  };
  return { store, rows };
}

function capture() {
  const sent: MailMessage[] = [];
  return {
    sent,
    mailer: {
      send: (m: MailMessage) => Promise.resolve(void sent.push(m)).then(() => 'sent' as const),
    },
  };
}

let clock = new Date('2026-10-29T10:05:00.000Z');
const now = () => clock;

async function enqueue(store: MailQueueStore, count: number, templateKey: string, lane: MailLane) {
  const mailer = new QueueMailer(store, { now });
  for (let i = 0; i < count; i += 1) {
    await mailer.send({
      to: `${lane}${String(i)}@example.com`,
      subject: lane,
      text: 'x',
      templateKey,
    });
  }
}

describe('UNIT/INT-56-31 — the mail drainer', () => {
  it('sends all auth first under a 50/h ceiling, defers bulk and resumes it next window', async () => {
    clock = new Date('2026-10-29T10:05:00.000Z');
    const { store, rows } = fakeStore({ mail_hour_ceiling_noreply: '50' });
    await enqueue(store, 500, 'announcement', 'bulk');
    await enqueue(store, 20, 'sign_in_code', 'auth');
    const noreply = capture();
    const state = createMailDrainerState();
    const first = await drainMailOnce({ store, noreply: noreply.mailer, now }, state);
    expect(noreply.sent.filter((m) => m.subject === 'auth')).toHaveLength(20);
    expect(first.sent).toBe(20 + 16); // usable 45; bulk stops at 80 % (36) of it
    expect(rows.filter((r) => r.status === 'deferred')).toHaveLength(484);
    await drainMailOnce({ store, noreply: noreply.mailer, now }, state);
    expect(noreply.sent).toHaveLength(36);
    clock = new Date('2026-10-29T11:00:01.000Z');
    const next = await drainMailOnce({ store, noreply: noreply.mailer, now }, state);
    expect(next.sent).toBe(36);
    expect(rows.filter((r) => r.status === 'sent')).toHaveLength(72);
  });

  it('INT-56-32: security@ refusing → auth goes via noreply@, degraded raised once', async () => {
    clock = new Date('2026-10-29T12:00:00.000Z');
    const { store, rows } = fakeStore();
    await enqueue(store, 3, 'password_reset', 'auth');
    const noreply = capture();
    const refused = Object.assign(new Error('535'), { code: 'EAUTH', responseCode: 535 });
    const security = { send: vi.fn(() => Promise.reject(refused)) };
    const alert = vi.fn(() => Promise.resolve());
    const state = createMailDrainerState();
    await drainMailOnce({ store, noreply: noreply.mailer, security, alert, now }, state);
    await enqueue(store, 1, 'password_reset', 'auth');
    await drainMailOnce({ store, noreply: noreply.mailer, security, alert, now }, state);
    expect(noreply.sent).toHaveLength(4);
    expect(security.send).toHaveBeenCalledTimes(1);
    expect(rows.every((r) => r.status === 'sent' && r.sentVia === 'noreply')).toBe(true);
    expect(
      alert.mock.calls.filter((c) => (c as unknown[])[0] === 'mail_provider_degraded'),
    ).toHaveLength(1);
  });

  it('REL-13: a claim left by a killed drainer is not resent, then sent exactly once', async () => {
    clock = new Date('2026-10-29T13:00:00.000Z');
    const { store } = fakeStore();
    await enqueue(store, 1, 'invitation', 'transactional');
    await store.claim('transactional', 50, 'dead-drainer', clock); // killed before send
    const noreply = capture();
    const state = createMailDrainerState();
    await drainMailOnce({ store, noreply: noreply.mailer, now }, state);
    expect(noreply.sent).toHaveLength(0);
    clock = new Date('2026-10-29T13:11:00.000Z');
    await drainMailOnce({ store, noreply: noreply.mailer, now }, state);
    await drainMailOnce({ store, noreply: noreply.mailer, now }, state);
    expect(noreply.sent).toHaveLength(1);
  });

  it('never sends an auth code past its deadline, and alerts on deferred auth', async () => {
    clock = new Date('2026-10-29T14:00:00.000Z');
    const { store, rows } = fakeStore({ mail_hour_ceiling_noreply: '1' });
    await enqueue(store, 2, 'sign_in_code', 'auth');
    clock = new Date('2026-10-29T14:20:00.000Z'); // the 10-minute code TTL has passed
    const noreply = capture();
    const alert = vi.fn(() => Promise.resolve());
    await drainMailOnce({ store, noreply: noreply.mailer, alert, now }, createMailDrainerState());
    expect(noreply.sent).toHaveLength(0);
    // ceiling 1 → usable 0: both auth rows are deferred, not dropped, and the alert fires.
    expect(rows.map((r) => r.status)).toEqual(['deferred', 'deferred']);
    expect(alert).toHaveBeenCalledWith(
      'auth_mail_deferred',
      expect.objectContaining({ severity: 'high' }),
    );
  });

  it('marks a past-deadline auth row failed with error deadline', async () => {
    clock = new Date('2026-10-29T15:00:00.000Z');
    const { store, rows } = fakeStore();
    await enqueue(store, 1, 'mfa_code', 'auth');
    clock = new Date('2026-10-29T15:30:00.000Z');
    const noreply = capture();
    await drainMailOnce({ store, noreply: noreply.mailer, now }, createMailDrainerState());
    expect(noreply.sent).toHaveLength(0);
    expect(rows[0]).toMatchObject({ status: 'failed', error: 'deadline' });
  });
});
