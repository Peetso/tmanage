import { PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { IncomingMessage } from 'node:http';

/**
 * The Fastify adapter, with the one parser the request pipeline adds to Fastify's own.
 *
 * FILE-001b's part route (`PUT /v1/uploads/:handle/parts/:n`) takes raw bytes as
 * `application/octet-stream`, which Fastify does not parse by default (it answers 415). The
 * parser is registered here, on the adapter, before Nest sees it.
 *
 * ## What the parser actually does
 *
 * A content-type parser in Fastify is instance-wide: it runs for every request on every
 * route that names the type, before any guard. So this one is **streaming, and it refuses
 * first**. It looks at the URL before it reads a byte; a request that is not the part route
 * is answered 415 — what Fastify answered before the parser existed — with the body left
 * unread. Only the part route is buffered, and only up to **its own limit**: the part size
 * plus a little slack. Fastify's global `bodyLimit` stays at the 1 MiB default on purpose:
 * raising it to a part size would raise it for every JSON route too, and an 8 MiB JSON body
 * against `POST /work-items` is not a request this API wants to read.
 *
 * The limit is deliberately over the part size: a body that is over by one byte reaches the
 * driver, which refuses it with `PartTooLargeError` after the token check and before any
 * write; a body over the slack is refused here, before the handler, as a 413 that
 * `HttpExceptionFilter` renders in the same envelope. That ordering is a property of the
 * transport and not a leak: the token is checked before the size only for bodies the parser
 * let through, so a forged token with a body over the slack learns that a ceiling exists —
 * the same fact `UPLOAD_PART_SIZE_BYTES` documents — and nothing about any upload.
 *
 * `main.ts` registers the parser for every driver, including `s3`, where the part route is
 * bound to no sink and answers 404; the parser then costs a URL check per octet-stream
 * request and buffers nothing.
 *
 * One helper rather than two constructions so the database suite that drives the transport
 * boots exactly the parser `main.ts` boots. `.ready()` in a suite must come after this.
 */

/** Room for a client that rounds its chunk up; not a second part's worth. */
export const PART_BODY_SLACK_BYTES = 1_024;

export const PART_CONTENT_TYPE = 'application/octet-stream';

/** The part route's path, and nothing else: `/v1/uploads/<handle>/parts/<n>`. */
const PART_ROUTE_PATH = /^\/v1\/uploads\/[^/?#]+\/parts\/[^/?#]+$/;

/** `true` for the one URL the octet-stream parser buffers and the 413 mapping describes. */
export function isPartRoute(url: string): boolean {
  const end = url.search(/[?#]/);
  return PART_ROUTE_PATH.test(end === -1 ? url : url.slice(0, end));
}

export interface FastifyAdapterOptions {
  readonly trustProxy?: boolean;
  /** `ApiConfig.uploadPartSizeBytes` — the same number the driver refuses above. */
  readonly uploadPartSizeBytes: number;
}

/** What the parser reads off the request before deciding whether to read the body at all. */
interface ParserRequest {
  readonly url: string;
  readonly headers: { readonly 'content-length'?: string | undefined };
  /** Fastify's own flag: the URL matched no route, and the not-found handler is next. */
  readonly is404?: boolean;
}

type ParserDone = (error: Error | null, body?: Buffer) => void;

export function createFastifyAdapter(options: FastifyAdapterOptions): FastifyAdapter {
  const adapter = new FastifyAdapter({ trustProxy: options.trustProxy ?? false });
  const limit = options.uploadPartSizeBytes + PART_BODY_SLACK_BYTES;
  adapter
    .getInstance()
    .addContentTypeParser(
      PART_CONTENT_TYPE,
      (request: ParserRequest, payload: IncomingMessage, done: ParserDone) => {
        if (request.is404) {
          // No route at all — a traversal that folded the part path into nothing, say. The
          // not-found handler answers as it always did, and the body stays unread.
          done(null, Buffer.alloc(0));
          return;
        }
        if (!isPartRoute(request.url)) {
          // Not the part route: the same 415 Fastify gave before this parser existed, and
          // not one byte of the body read on the way to it.
          done(new UnsupportedMediaTypeException());
          return;
        }
        const declared = Number(request.headers['content-length']);
        if (declared > limit) {
          done(new PayloadTooLargeException());
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        const detach = (): void => {
          payload.off('data', onData);
          payload.off('end', onEnd);
          payload.off('error', onError);
        };
        const onData = (chunk: Buffer): void => {
          received += chunk.length;
          if (received > limit) {
            detach();
            done(new PayloadTooLargeException());
            return;
          }
          chunks.push(chunk);
        };
        const onEnd = (): void => {
          detach();
          done(null, Buffer.concat(chunks));
        };
        const onError = (error: Error): void => {
          detach();
          done(error);
        };
        payload.on('data', onData);
        payload.on('end', onEnd);
        payload.on('error', onError);
      },
    );
  return adapter;
}
