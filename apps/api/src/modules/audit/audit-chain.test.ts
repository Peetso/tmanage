import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '@tmanage/domain';
import { ChainVerifier, canonicalJson, chainRowHash, genesisHash } from './audit-chain.js';
import type { ChainedEvent } from './audit-chain.js';
import { AnchorSigner, anchorMessage } from './audit-anchor-signer.js';
import { auditCatalog } from './audit-catalog.js';

/** 56-11 — the chain's pure half: canonical hash, tamper detection, anchor HMAC, catalog census. */

const ORG = 'org-1';

function chain(n: number): ChainedEvent[] {
  const rows: ChainedEvent[] = [];
  let prev = genesisHash(ORG);
  for (let seq = 1; seq <= n; seq += 1) {
    const base = {
      organizationId: ORG,
      id: `event-${seq}`,
      createdAt: new Date(Date.UTC(2026, 9, 30, 10, 0, seq)),
      actorUserId: 'user-1',
      effectiveActorId: null,
      action: 'project.created',
      objectType: 'project',
      objectId: `project-${seq}`,
      result: 'allowed',
      metadataJson: { b: seq, a: 'x' },
    };
    const rowHash = chainRowHash(base, seq, prev);
    rows.push({ ...base, chainSeq: seq, prevHash: prev, rowHash });
    prev = rowHash;
  }
  return rows;
}

function verify(rows: readonly ChainedEvent[], head = rows[rows.length - 1]) {
  const verifier = new ChainVerifier(ORG);
  for (const row of rows) verifier.push(row);
  return verifier.finish({
    chainSeq: head?.chainSeq ?? 0,
    headHash: head?.rowHash ?? genesisHash(ORG),
    lastEventId: head?.id ?? null,
  }).firstBreak;
}

describe('audit hash chain (56-11)', () => {
  it('hashes deterministically, independent of metadata key order or stored-text form', () => {
    const [row] = chain(1) as [ChainedEvent];
    const reordered = { ...row, metadataJson: { a: 'x', b: 1 } };
    const asText = { ...row, metadataJson: '{"b":1,"a":"x"}' };
    expect(chainRowHash(reordered, 1, row.prevHash)).toBe(row.rowHash);
    expect(chainRowHash(asText, 1, row.prevHash)).toBe(row.rowHash);
    expect(canonicalJson({ z: [1, { y: 2, x: 1 }], a: null })).toBe(
      '{"a":null,"z":[1,{"x":1,"y":2}]}',
    );
    expect(genesisHash('org-2')).not.toBe(genesisHash(ORG));
  });

  it('verifies an intact chain and names the first bad row of an edited, deleted or reordered one', () => {
    const rows = chain(5);
    expect(verify(rows)).toBeNull();

    const edited = rows.map((r) =>
      r.chainSeq === 3 ? { ...r, metadataJson: { a: 'y', b: 3 } } : r,
    );
    expect(verify(edited)).toEqual({
      reason: 'row_hash_mismatch',
      eventId: 'event-3',
      chainSeq: 3,
    });

    expect(verify(rows.filter((r) => r.chainSeq !== 2))).toMatchObject({
      reason: 'missing_row',
      eventId: 'event-3',
    });

    const [a, b, c, d, e] = rows as [
      ChainedEvent,
      ChainedEvent,
      ChainedEvent,
      ChainedEvent,
      ChainedEvent,
    ];
    const swapped = [a, { ...c, chainSeq: 2 }, { ...b, chainSeq: 3 }, d, e];
    expect(verify(swapped)).toMatchObject({ reason: 'prev_hash_mismatch', eventId: 'event-3' });

    expect(verify(rows.slice(0, 4), rows[4])).toMatchObject({ reason: 'head_mismatch' });
  });

  it('signs anchors with the keyring HMAC (golden vector shared with the worker) and never crashes keyless', () => {
    const message = anchorMessage({
      organizationId: ORG,
      day: '2026-10-29',
      headHash: 'a'.repeat(64),
      eventCount: 3,
    });
    const signer = AnchorSigner.fromEnv({
      AUDIT_ANCHOR_KEY: '1:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
    });
    const signature = signer.sign(message);
    expect(signature).toBe('v1:1:3deee75d88aec5182334c0496552d19187b8fed78cdc6bd349ce6cb61276fcf6');
    expect(signer.verify(message, signature)).toBe(true);
    expect(signer.verify(message.replace('3]', '4]'), signature)).toBe(false);

    const keyless = AnchorSigner.fromEnv({});
    expect([keyless.status, keyless.sign(message)]).toEqual(['absent', null]);
    expect(AnchorSigner.fromEnv({ AUDIT_ANCHOR_KEY: 'nonsense' }).status).toBe('invalid');
  });

  it('catalogues every audit action with an English and an Arabic description', () => {
    const catalog = auditCatalog();
    expect(catalog.map((entry) => entry.action)).toEqual([...AUDIT_ACTIONS]);
    const missing = catalog.filter(
      (e) => e.descriptionEn.trim() === '' || !/[؀-ۿ]/u.test(e.descriptionAr),
    );
    expect(missing).toEqual([]);
  });
});
