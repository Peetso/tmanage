import { describe, expect, it } from 'vitest';
import { purgeAiConversations, type AiConversationPurgeStore } from './ai-conversation-purge.js';

const now = () => new Date('2026-11-21T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

interface Row {
  readonly id: string;
  readonly org: string;
  readonly lastAt: number;
}

/** A store over rows and per-workspace windows that applies the same rule the SQL does. */
function fake(rows: Row[], days: Record<string, number>) {
  const audits: number[] = [];
  const past = (r: Row, at: Date) => r.lastAt < at.getTime() - (days[r.org] ?? 30) * DAY;
  const store: AiConversationPurgeStore = {
    listExpired: async (at, after, limit) =>
      rows
        .filter((r) => past(r, at) && r.id > (after ?? ''))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((r) => r.id),
    deleteExpired: async (ids, at) => {
      let removed = 0;
      for (const id of ids) {
        const index = rows.findIndex((r) => r.id === id && past(r, at));
        if (index >= 0) {
          rows.splice(index, 1);
          removed += 1;
        }
      }
      return removed;
    },
    audit: async (deleted) => void audits.push(deleted),
  };
  return { store, audits, rows };
}

describe('AI conversation purge (62-13)', () => {
  it('measures each conversation against its own workspace window (default 30 days)', async () => {
    const t = now().getTime();
    const { store, audits, rows } = fake(
      [
        { id: 'a1', org: 'A', lastAt: t - 31 * DAY }, // A keeps 30 (default): purged
        { id: 'a2', org: 'A', lastAt: t - 29 * DAY }, // kept
        { id: 'b1', org: 'B', lastAt: t - 31 * DAY }, // B keeps 90: kept
        { id: 'c1', org: 'C', lastAt: t - 2 * DAY }, // C keeps 1: purged
      ],
      { B: 90, C: 1 },
    );
    const result = await purgeAiConversations({ store, now });
    expect(result).toMatchObject({ deleted: 2, capped: false });
    expect(rows.map((r) => r.id).sort()).toEqual(['a2', 'b1']);
    expect(audits).toEqual([2]);
  });

  it('caps the batches a run takes and writes one count-only audit row', async () => {
    const t = now().getTime();
    const old = Array.from({ length: 7 }, (_, i) => ({
      id: `x${String(i)}`,
      org: 'A',
      lastAt: t - 40 * DAY,
    }));
    const { store, audits } = fake(old, {});
    const result = await purgeAiConversations({ store, now, batch: 3, maxBatches: 2 });
    expect(result).toMatchObject({ deleted: 6, capped: true });
    expect(audits).toEqual([6]);
  });

  it('writes a zero count when nothing is due', async () => {
    const { store, audits } = fake([{ id: 'n', org: 'A', lastAt: now().getTime() }], {});
    expect(await purgeAiConversations({ store, now })).toMatchObject({ deleted: 0 });
    expect(audits).toEqual([0]);
  });
});
