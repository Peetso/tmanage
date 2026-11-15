import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OPS, opsById } from './index.js';
import { REDACT_PROFILES } from './detail.js';
import { waveBDetails, waveBDetailsById } from './wave-b.js';

/**
 * Wave-B registry detail contract (slice S3; plan §7 S3 "schemas, redaction and examples").
 *
 * The per-area detail files only enrich ops that S1 already classified in `index.ts`. These
 * checks keep the detail honest: it covers exactly the wave-B route surface, its schemas are
 * strict and bound to the op's path params (never `orgSlug`, which comes from the grant —
 * architecture B3), each worked example validates, and the safety flags line up with the risk
 * class (architecture B4). Everything runs off the in-repo registry data — no container, no DB.
 */

/** The wave-B modules, by op-id prefix — the same split the plan §7 S3 row names. */
const WAVE_B = [
  /^conversations\./,
  /^(doc_collections|doc_tags|document_bookmarks|document_read_state|document_templates|documents)\./,
  /^(files|file_tags)\./,
  /^(calendar|meetings|meeting_series)\./,
  /^decisions\./,
  /^(approvals|esign)\./,
  /^client_requests\./,
];

const isWaveB = (id: string): boolean => WAVE_B.some((re) => re.test(id));
const expectedIds = new Set(OPS.map((op) => op.id).filter(isWaveB));

describe('AI action registry — wave B detail (S3)', () => {
  it('covers exactly the wave-B op surface, once each', () => {
    const detailIds = waveBDetails.map((d) => d.id);
    expect(new Set(detailIds).size, 'duplicate detail ids').toBe(detailIds.length);
    expect(new Set(detailIds)).toEqual(expectedIds);
  });

  it('attaches detail only to real classified ops', () => {
    for (const d of waveBDetails) expect(opsById.has(d.id), `unknown op id: ${d.id}`).toBe(true);
  });

  it('uses strict object inputs that bind the path params but never orgSlug', () => {
    for (const d of waveBDetails) {
      const op = opsById.get(d.id)!;
      expect(d.input, `${d.id} input must be a zod object`).toBeInstanceOf(z.ZodObject);
      const shape = (d.input as z.ZodObject<z.ZodRawShape>).shape;
      expect(Object.keys(shape), `${d.id} must not take orgSlug`).not.toContain('orgSlug');
      for (const seg of op.path.split('/')) {
        if (!seg.startsWith(':')) continue;
        const name = seg.slice(1);
        if (name === 'orgSlug') continue;
        expect(Object.keys(shape), `${d.id} missing path param ${name}`).toContain(name);
      }
    }
  });

  it('rejects unknown keys (strict) and accepts every worked example', () => {
    for (const d of waveBDetails) {
      expect(d.examples.length, `${d.id} needs at least one example`).toBeGreaterThan(0);
      for (const ex of d.examples) {
        expect(() => d.input.parse(ex.args), `${d.id} example "${ex.summary}"`).not.toThrow();
        expect(
          d.input.safeParse({ ...ex.args, __unexpected__: 1 }).success,
          `${d.id} must reject unknown keys`,
        ).toBe(false);
      }
    }
  });

  it('keeps redaction profiles and notify/download flags consistent with risk', () => {
    for (const d of waveBDetails) {
      const op = opsById.get(d.id)!;
      expect(REDACT_PROFILES, `${d.id} redact profile`).toContain(d.redact);
      // A read can never message other people.
      if (op.risk === 'read') expect(d.notifies, `${d.id} read op must not notify`).toBe(false);
    }
  });

  it('keeps file download as a confirm-class, link-only op', () => {
    const download = opsById.get('files.content.list');
    expect(download?.risk, 'file download must be confirm-class (approval-gated)').toBe('confirm');
    expect(waveBDetailsById.has('files.content.list')).toBe(true);
  });
});
