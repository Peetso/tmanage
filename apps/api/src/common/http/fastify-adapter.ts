import { FastifyAdapter } from '@nestjs/platform-fastify';

/**
 * The Fastify adapter, with the one parser the request pipeline adds to Fastify's own.
 *
 * FILE-001b's part route (`PUT /v1/uploads/:handle/parts/:n`) takes raw bytes as
 * `application/octet-stream`, which Fastify does not parse by default (it answers 415). The
 * parser is registered here, on the adapter, before Nest sees it — and it carries **its own
 * body limit**. Fastify's global `bodyLimit` stays at the 1 MiB default on purpose: raising
 * it to a part size would raise it for every JSON route too, and a 8 MiB JSON body against
 * `POST /work-items` is not a request this API wants to read. The limit is the part size plus
 * a little slack, so a body that is over by one byte reaches the driver, which refuses it
 * with `PartTooLargeError` and no write; a body over the slack is refused by Fastify itself,
 * which `HttpExceptionFilter` renders as the same 413 in our envelope.
 *
 * One helper rather than two constructions so the database suite that drives the transport
 * boots exactly the parser `main.ts` boots. `.ready()` in a suite must come after this.
 */

/** Room for a client that rounds its chunk up; not a second part's worth. */
export const PART_BODY_SLACK_BYTES = 1_024;

export const PART_CONTENT_TYPE = 'application/octet-stream';

export interface FastifyAdapterOptions {
  readonly trustProxy?: boolean;
  /** `ApiConfig.uploadPartSizeBytes` — the same number the driver refuses above. */
  readonly uploadPartSizeBytes: number;
}

export function createFastifyAdapter(options: FastifyAdapterOptions): FastifyAdapter {
  const adapter = new FastifyAdapter({ trustProxy: options.trustProxy ?? false });
  adapter
    .getInstance()
    .addContentTypeParser(
      PART_CONTENT_TYPE,
      { parseAs: 'buffer', bodyLimit: options.uploadPartSizeBytes + PART_BODY_SLACK_BYTES },
      (_request, body, done) => {
        done(null, body);
      },
    );
  return adapter;
}
