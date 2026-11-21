import type { AiRequest } from '../ai-client.js';
import type { AiUsage } from '../ai-cost.js';

/**
 * 62-28 — the port the digest wording job sends its requests through: a message batch (plan 62
 * §4.8, "worded by Haiku through the Batch API"). Results arrive later, so a submit and its
 * results are two calls on two passes.
 *
 * No production adapter is wired: there is no API key in this workspace, so the job does not start
 * (`copilot.module.ts`) and every digest uses the plain template. A real adapter is one class over
 * the provider's message-batch endpoints; it must return the raw text of each answer and its usage,
 * never throw on one bad item, and name the cause of a failure without a key or a body.
 */

export interface DigestBatchItem {
  /** Our row id: how a result finds its request. */
  readonly customId: string;
  readonly request: AiRequest;
}

export type DigestBatchItemOutcome = 'succeeded' | 'errored' | 'expired' | 'canceled';

export interface DigestBatchResult {
  readonly customId: string;
  readonly outcome: DigestBatchItemOutcome;
  /** The answer's text when it succeeded. */
  readonly text: string | null;
  readonly usage: AiUsage | null;
  readonly stopReason: string | null;
  readonly providerMessageId: string | null;
}

export type DigestBatchPoll =
  | { readonly ended: false }
  | { readonly ended: true; readonly results: readonly DigestBatchResult[] };

export interface DigestBatchClient {
  submit(items: readonly DigestBatchItem[]): Promise<{ readonly batchId: string }>;
  poll(batchId: string): Promise<DigestBatchPoll>;
}

/** A deterministic batch for tests: answers each request with `answer(request)`. */
export class FakeDigestBatchClient implements DigestBatchClient {
  readonly submitted: DigestBatchItem[][] = [];
  private readonly batches = new Map<string, readonly DigestBatchItem[]>();
  ended = true;

  constructor(
    private readonly answer: (item: DigestBatchItem) => Omit<DigestBatchResult, 'customId'>,
  ) {}

  submit(items: readonly DigestBatchItem[]): Promise<{ readonly batchId: string }> {
    const batchId = `msgbatch_fake_${String(this.batches.size + 1)}`;
    this.batches.set(batchId, items);
    this.submitted.push([...items]);
    return Promise.resolve({ batchId });
  }

  poll(batchId: string): Promise<DigestBatchPoll> {
    const items = this.batches.get(batchId);
    if (items === undefined || !this.ended) return Promise.resolve({ ended: false });
    return Promise.resolve({
      ended: true,
      results: items.map((item) => ({ customId: item.customId, ...this.answer(item) })),
    });
  }
}
