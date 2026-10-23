import { describe, expect, it } from 'vitest';
import type { MailDelivery, Mailer, MailMessage } from '@tmanage/mail';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import { ClientRequestMailer } from '../notifications/client-request-mailer.js';
import { createClientRequestTransitionedMail } from './client-request-mail.js';

/**
 * A7: "Tell <name> it is accepted" unticked puts `notifyClient: false` on the transitioned
 * payload, and the client then gets no mail. What the consumer does to real rows is proved in
 * the API's database suites; this pins only the early exit.
 */

class RecordingMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  send(message: MailMessage): Promise<MailDelivery> {
    this.sent.push(message);
    return Promise.resolve('sent');
  }
}

function acceptedEvent(extra: Record<string, unknown>): ClaimedOutboxEvent {
  return {
    id: 'evt-1',
    organizationId: 'org-1',
    type: 'client_request.transitioned.v1',
    schemaVersion: 1,
    aggregateType: 'client_request',
    aggregateId: 'req-1',
    payload: {
      requestId: 'req-1',
      projectId: 'proj-1',
      clientOrganizationId: 'corg-1',
      fromStatus: 'triage',
      toStatus: 'accepted',
      requestVersion: 3,
      ...extra,
    },
    correlationId: null,
    occurredAt: new Date(0),
    attempts: 1,
  };
}

function recordingTx(): { tx: WorkerTransaction; sql: string[] } {
  const sql: string[] = [];
  const tx: WorkerTransaction = {
    query: <T>(text: string): Promise<T> => {
      sql.push(text);
      // No submitter row: the consumer stops after its first read when it does read.
      return Promise.resolve([] as unknown as T);
    },
  };
  return { tx, sql };
}

describe('createClientRequestTransitionedMail and notifyClient (A7)', () => {
  it('stages no mail, and reads nothing, when notifyClient is false', async () => {
    const transport = new RecordingMailer();
    const handler = createClientRequestTransitionedMail(
      new ClientRequestMailer(transport, 'https://app.example'),
    );
    const { tx, sql } = recordingTx();
    const staged: unknown[] = [];
    await handler(acceptedEvent({ notifyClient: false }), tx, {
      afterCommit: (effect) => staged.push(effect),
    });
    expect(sql).toEqual([]);
    expect(staged).toEqual([]);
    expect(transport.sent).toEqual([]);
  });

  it('still looks the submitter up when notifyClient is absent', async () => {
    const handler = createClientRequestTransitionedMail(
      new ClientRequestMailer(new RecordingMailer(), 'https://app.example'),
    );
    const { tx, sql } = recordingTx();
    await handler(acceptedEvent({}), tx, { afterCommit: () => undefined });
    expect(sql.length).toBeGreaterThan(0);
  });
});
