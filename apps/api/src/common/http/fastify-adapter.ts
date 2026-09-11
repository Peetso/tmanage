import {
  HttpException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { PartAdmission } from '@tmanage/storage';
import type { TrustedProxies } from '@tmanage/config';
import type { IncomingMessage } from 'node:http';
import type { RequestAdmission } from './rate-limiter.js';

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
 * `HttpExceptionFilter` renders in the same envelope. Both come **after** the admission:
 * since the security review of 2026-09-04 the token is verified before the first byte is
 * read, so a forged request of any size is the one 404 and holds no buffer — it does not
 * even learn that a ceiling exists.
 *
 * Before the token comes the client: `admitClient` (the fixed-window limiter in
 * `rate-limiter.ts`, keyed by `request.ip`) is consulted first of all, so a caller who
 * has used their window costs one map lookup and a 429 — not a signature verification per
 * request, and never a byte of body. `03-TECHNICAL-ARCHITECTURE` §8: "rate limits apply
 * by IP before authentication", and this is the API's one route with no session. The key
 * is what `trustProxy` says it is, and since D09 that is the socket peer unless the peer
 * is one the operator named in `TRUSTED_PROXY_ADDRESSES`: a caller who reaches the process
 * directly is counted by the address it actually connected from and cannot rotate it by
 * writing a header. Behind a configured proxy it is the forwarded client address, which is
 * the proxy's word and no longer anybody's.
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
  /**
   * Whose `X-Forwarded-*` headers Fastify believes — `TRUSTED_PROXY_ADDRESSES`, already
   * parsed and already refused if it was nonsense (`packages/config/src/trusted-proxies.ts`).
   * `false` is trust nobody; a list is the addresses and CIDR ranges of the peers that may
   * speak for somebody else.
   *
   * This carries the configured shape rather than a boolean on purpose (D09). The boolean it
   * replaced had one true value — trust everybody — which `main.ts` passed unconditionally,
   * so any client that could reach the process could name the address every address-keyed
   * control counts against: the part limiter below, and both of D08's sign-in budgets.
   * Fastify's own option takes exactly this union, so the operator's list is handed on as it
   * stands with no second notion of trust in between to drift from it.
   *
   * **Absent means `false`**, and that is the safe direction: an origin with no proxy in
   * front of it reads the socket peer, which is the truth and costs no configuration. Every
   * suite that builds its own adapter therefore gets the socket peer unless it says otherwise.
   */
  readonly trustProxy?: TrustedProxies | undefined;
  /** `ApiConfig.uploadPartSizeBytes` — the same number the driver refuses above. */
  readonly uploadPartSizeBytes: number;
  /**
   * Whether a part body may be read at all — `createPartAdmission` over the local
   * transport's signing secret. Consulted **before** the first byte is buffered (security
   * review, 2026-09-04): a PUT whose token does not verify hands the handler an empty body,
   * which the sink refuses with the same 404 as before, and never holds a part-sized
   * buffer for a caller who proved nothing. Absent — the `s3` driver, a suite with no
   * sink — no body is ever read on this route, which is what a route with no sink answers.
   */
  readonly admitPart?: PartAdmission | undefined;
  /**
   * Whether this client may make another part request at all — `createFixedWindowLimiter`
   * over `RATE_LIMIT_WINDOW_SECONDS` and `RATE_LIMIT_MAX_REQUESTS`, keyed by the request's
   * ip. Consulted before the token and before the body; refused as 429 `rate_limited`.
   * Absent — a suite that is not about the limit — every client is admitted.
   */
  readonly admitClient?: RequestAdmission | undefined;
}

/** `/v1/uploads/<handle>/parts/<n>?t=<token>`, taken apart the way the controller does. */
function partRequest(
  url: string,
): { providerUploadId: string; partNumber: number; token: string | undefined } | null {
  const parsed = new URL(url, 'http://localhost');
  const [, , , providerUploadId, , n] = parsed.pathname.split('/');
  if (!providerUploadId || !n || !/^[1-9]\d*$/.test(n)) return null;
  const partNumber = Number(n);
  if (!Number.isSafeInteger(partNumber)) return null;
  const token = parsed.searchParams.get('t');
  return { providerUploadId, partNumber, token: token ?? undefined };
}

/** What the parser reads off the request before deciding whether to read the body at all. */
interface ParserRequest {
  readonly url: string;
  /** Fastify's client address: the socket's, or the forwarded one under `trustProxy`. */
  readonly ip: string;
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
        if (options.admitClient && !options.admitClient(request.ip)) {
          // The window is used. Before the token, so a flood costs no verification; before
          // the body, so it holds no buffer. 429 says nothing about handles.
          done(new HttpException('Too Many Requests', 429));
          return;
        }
        const part = partRequest(request.url);
        if (
          !options.admitPart ||
          !part ||
          !options.admitPart(part.providerUploadId, part.partNumber, part.token)
        ) {
          // Nothing proved, nothing read. The handler gets an empty body and the sink
          // refuses it as it refuses every forged or expired token — one 404, one body.
          done(null, Buffer.alloc(0));
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
