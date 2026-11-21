import { createHash } from 'node:crypto';

/**
 * 62-24 (plan 62 §4.5) — the embedding provider seam.
 *
 * Plan §4.5 names Voyage `voyage-4-lite` at 512 dimensions. No Voyage key exists yet, so
 * production runs with **no provider**: passages are stored without an embedding and retrieval is
 * keyword-only (FULLTEXT), the plan's own fallback. A real provider is one class behind this
 * interface; it must send only passage text (never ids or names of people), and is wired only
 * once the key is set and the privacy page names the processor.
 *
 * {@link HashingEmbeddingProvider} is the deterministic stand-in the tests use (feature hashing of
 * word tokens into 512 buckets, L2-normalised): similar words give similar vectors, so ranking,
 * filter-before-rank and both vector stores can be proven without a network or a key.
 */

export const EMBEDDING_DIMENSIONS = 512;

export interface EmbeddingProvider {
  /** Stored beside each vector; a model change re-embeds. At most 48 characters. */
  readonly model: string;
  /** One vector per input, each {@link EMBEDDING_DIMENSIONS} long and unit length. */
  embed(texts: readonly string[], purpose: 'passage' | 'query'): Promise<Float32Array[]>;
}

/** Word tokens, any script: letters and digits runs, lower-cased. */
export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1);
}

export function normalise(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  for (let i = 0; i < vector.length; i += 1) vector[i] = vector[i]! / norm;
  return vector;
}

export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'test-hashing-512';

  embed(texts: readonly string[], _purpose?: 'passage' | 'query'): Promise<Float32Array[]> {
    return Promise.resolve(
      texts.map((text) => {
        const vector = new Float32Array(EMBEDDING_DIMENSIONS);
        for (const token of tokens(text)) {
          const digest = createHash('sha256').update(token).digest();
          const bucket = digest.readUInt16LE(0) % EMBEDDING_DIMENSIONS;
          vector[bucket] = vector[bucket]! + (digest[2]! & 1 ? 1 : -1);
        }
        return normalise(vector);
      }),
    );
  }
}

/** Cosine distance (1 - cosine similarity) of two vectors of one length. */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / Math.sqrt(na * nb);
}

/** The text form `VEC_FromText` reads and `VEC_ToText` writes: `[0.1,0.2,…]`. */
export function vectorText(vector: Float32Array): string {
  return `[${Array.from(vector, (v) => (Number.isFinite(v) ? v : 0)).join(',')}]`;
}

export function parseVectorText(text: string): Float32Array | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length !== EMBEDDING_DIMENSIONS) return null;
    return Float32Array.from(parsed, (v) => (typeof v === 'number' ? v : 0));
  } catch {
    return null;
  }
}
