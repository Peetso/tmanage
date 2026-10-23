import { describe, expect, it } from 'vitest';
import { INTERNAL_ROLES } from '@tmanage/domain';
import { expectedCeilingGrants } from '@tmanage/test-kit';
import type { ClaimedOutboxEvent } from '../common/database/outbox-store.js';
import type { WorkerTransaction } from '../common/database/worker-database.js';
import {
  clientRequestTransitionedConsumer,
  mayTriageClientRequests,
} from './client-request-notifications.js';

/**
 * The pure half of the submitted-request recipient rule. What the consumers do to real
 * rows — the dedupe under redelivery, the revocation silences, the withdrawn exception —
 * is proved against a real server in `apps/api/test/notif-001-notifications.db.test.ts`.
 *
 * ## The first case used to be `X === X` (finding C2)
 *
 * `mayTriageClientRequests` is
 *
 * ```ts
 * if (!isRole(candidate.role)) return false;
 * if (!hasCapability(candidate.role, 'client_request.triage')) return false;
 * return candidate.hasOrgWideScope || candidate.onProject;
 * ```
 *
 * so with `hasOrgWideScope: true` it reduces to `hasCapability(role, 'client_request.triage')`
 * for any known role — and the expectation the first case compared it against was literally
 * `hasCapability(role, 'client_request.triage')`. The comment that stood here defended the
 * shape ("Not a restatement: the expectation itself is computed from `capabilitiesFor` …
 * this asserts the wiring, not the table") and was wrong twice over: it named the wrong
 * function, and the loop could not fail for any ceiling at all. Adding
 * `client_request.triage` to a role that must never triage would have handed that role every
 * client-request notification in the organization, silently, with this file green.
 *
 * The expectation now comes from `@tmanage/test-kit`'s hand-written transcription of
 * `12-PERMISSION-MATRIX.md` §2 — the same fixture the API's §11 role grid and the membership
 * resolver use — which imports no value from `@tmanage/domain` and cannot see the ceiling.
 * The two sibling cases below (the relation rule and the unknown role) were always genuine
 * and are unchanged.
 *
 * §2 has no "triage" row of its own; the transcription's source for this capability is
 * `23-ERD-AND-STATE-MACHINES.md` §6 ("Only internal manager may accept/defer/decline") read
 * with `21-REQUIREMENTS-TRACEABILITY.md` FR-01. See the fixture's header.
 */

describe('mayTriageClientRequests', () => {
  it('is not a vacuous loop: the matrix grants triage to some internal roles and not others', () => {
    // The guard against the case below quietly becoming a tautology again from the other
    // direction — a fixture that said "every role triages" (or "none does") would make the
    // comparison pass for a function that ignored the role entirely.
    const triaging = INTERNAL_ROLES.filter((role) =>
      expectedCeilingGrants(role, 'client_request.triage'),
    );
    expect(triaging.length).toBeGreaterThan(0);
    expect(triaging.length).toBeLessThan(INTERNAL_ROLES.length);
  });

  it('agrees with the permission matrix for every internal role, org-wide', () => {
    for (const role of INTERNAL_ROLES) {
      const expected = expectedCeilingGrants(role, 'client_request.triage');
      expect(
        mayTriageClientRequests({ userId: 'u', role, hasOrgWideScope: true, onProject: false }),
        role,
      ).toBe(expected);
    }
  });

  it('requires a relation: no org-wide scope and no project membership means no', () => {
    expect(
      mayTriageClientRequests({
        userId: 'u',
        role: 'manager',
        hasOrgWideScope: false,
        onProject: false,
      }),
    ).toBe(false);
    expect(
      mayTriageClientRequests({
        userId: 'u',
        role: 'manager',
        hasOrgWideScope: false,
        onProject: true,
      }),
    ).toBe(true);
  });

  it('refuses a role the domain does not know', () => {
    expect(
      mayTriageClientRequests({
        userId: 'u',
        role: 'superuser',
        hasOrgWideScope: true,
        onProject: true,
      }),
    ).toBe(false);
  });
});

describe('clientRequestTransitionedConsumer and notifyClient (A7)', () => {
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

  it('tells the client nothing, and reads nothing, when notifyClient is false', async () => {
    const { tx, sql } = recordingTx();
    await clientRequestTransitionedConsumer(acceptedEvent({ notifyClient: false }), tx, {
      afterCommit: () => undefined,
    });
    expect(sql).toEqual([]);
  });

  it('still looks the submitter up when notifyClient is absent', async () => {
    const { tx, sql } = recordingTx();
    await clientRequestTransitionedConsumer(acceptedEvent({}), tx, {
      afterCommit: () => undefined,
    });
    expect(sql.length).toBeGreaterThan(0);
  });
});
