import { Readable } from 'node:stream';
import {
  Controller,
  Header,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  Optional,
  Post,
  Req,
} from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Public } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { requestState } from '../../common/http/request-state.js';
import { MAX_BOUNCE_BYTES } from '@tmanage/mail';
import { Throttle } from '../rate-limits/throttle-policies.js';
import { InboundEmailService } from './inbound-email.service.js';
import type { IngestStatus } from './inbound-email.service.js';
import {
  MAX_WEBHOOK_BODY_BYTES,
  parseWebhookBody,
  verifyWebhookSignature,
} from './inbound-mail-rules.js';

/**
 * R22-c (54-12 part 2) — `POST /v1/public/inbound-email/webhook`, the one inbound path for mail
 * until a poller exists: Peter's forwarder (or a later poller) posts each message as JSON
 * `{ to, from, messageId, date, subject, text, html, headers, attachments: [{ name, contentType,
 * size, contentBase64 }] }`, signed with the platform secret `INBOUND_EMAIL_WEBHOOK_SECRET`:
 *
 * - `x-inbound-timestamp: <unix seconds>` (±300 s) and
 *   `x-inbound-signature: v1=<hex HMAC-SHA256(secret, timestamp + '.' + rawBody)>`.
 *
 * No session, no CSRF, no tenant in the URL — the recipient resolves the organization inside
 * `ingest()`, which also holds the per-address hour budget. Answers: 404 when no secret of at least
 * 32 characters is configured (the feature is off; `ingest` is never reached), 413 over 10 MiB
 * (before parsing), 401 for any signature miss (never says which), 422 for a malformed body, else
 * 200 `{ status }`. `Cache-Control: no-store`.
 *
 * The HMAC is over the exact bytes sent, so the raw body is kept for this route only — the
 * `preParsing` hook of `github-hooks.controller.ts`, with this route's own 10 MiB ceiling. Fastify's
 * global 1 MiB `bodyLimit` still applies to `application/json`; a forwarder sending larger mail
 * uses `Content-Type: application/vnd.tmanage.inbound-email+json`, whose parser (registered at
 * boot, refusing every other URL with 415) takes the already-captured bytes up to the ceiling.
 */

export const INBOUND_WEBHOOK_DEPS = Symbol('tmanage.inboundEmail.webhookDeps');
export const INBOUND_WEBHOOK_CONTENT_TYPE = 'application/vnd.tmanage.inbound-email+json';
/** 56-26: the raw bounce `POST /v1/public/inbound-email/bounces` takes (mail-bounces module). */
export const BOUNCE_CONTENT_TYPE = 'message/rfc822';
const MIN_SECRET_LENGTH = 32;
const INBOUND_PATH = /^\/v1\/public\/inbound-email\/webhook$/u;
const BOUNCE_PATH = /^\/v1\/public\/inbound-email\/bounces$/u;

export interface InboundWebhookDeps {
  /** Overrides `process.env.INBOUND_EMAIL_WEBHOOK_SECRET` (tests). */
  readonly secret?: string | null;
  readonly now?: () => Date;
}

interface WebhookRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawBody?: Buffer;
}

const header = (request: WebhookRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

function pathOf(url: string | undefined): string | null {
  if (typeof url !== 'string') return null;
  const end = url.search(/[?#]/u);
  return end === -1 ? url : url.slice(0, end);
}

/** `true` for the inbound-mail webhook URL. */
export function isInboundWebhookRoute(url: string | undefined): boolean {
  const path = pathOf(url);
  return path !== null && INBOUND_PATH.test(path);
}

/** 56-26: `true` for the bounce intake URL. */
export function isBounceIntakeRoute(url: string | undefined): boolean {
  const path = pathOf(url);
  return path !== null && BOUNCE_PATH.test(path);
}

/** The configured secret, or `null` (absent or shorter than 32 characters: the route is off). */
export function webhookSecret(deps: InboundWebhookDeps): string | null {
  const secret =
    deps.secret !== undefined ? deps.secret : (process.env['INBOUND_EMAIL_WEBHOOK_SECRET'] ?? null);
  return secret !== null && secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

@Controller('v1/public/inbound-email')
export class InboundWebhookController {
  constructor(
    @Inject(InboundEmailService) private readonly service: InboundEmailService,
    @Optional() @Inject(INBOUND_WEBHOOK_DEPS) private readonly deps: InboundWebhookDeps = {},
  ) {}

  @Post('webhook')
  @Public()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Throttle('inbound_email_webhook', {
    perMinute: 300,
    perHour: 6_000,
    key: 'ip',
    onStoreError: 'open',
  })
  async receive(@Req() request: WebhookRequest): Promise<{ readonly status: IngestStatus }> {
    const secret = webhookSecret(this.deps);
    if (secret === null) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'inbound_webhook_off');
    }
    const verdict = verifyWebhookSignature({
      rawBody: request.rawBody,
      signature: header(request, 'x-inbound-signature'),
      timestamp: header(request, 'x-inbound-timestamp'),
      secret,
      now: (this.deps.now ?? (() => new Date()))(),
    });
    if (verdict !== 'valid') {
      throw new ApiError(
        401,
        'unauthenticated',
        'The request signature is invalid',
        undefined,
        'invalid_signature',
      );
    }
    let json: unknown;
    try {
      json = JSON.parse((request.rawBody as Buffer).toString('utf8'));
    } catch {
      throw new ApiError(422, 'validation_failed', 'The request body is invalid', [
        { field: 'body', message: 'must be JSON' },
      ]);
    }
    const parsed = parseWebhookBody(json, requestState(request)?.correlationId ?? '');
    if (!parsed.ok) {
      throw new ApiError(422, 'validation_failed', 'The request body is invalid', parsed.details);
    }
    const result = await this.service.ingest(parsed.message);
    return { status: result.status };
  }
}

/**
 * Buffers this route's body (at most {@link MAX_WEBHOOK_BODY_BYTES}; 413 above, before any parse)
 * onto `request.rawBody` and hands the parser a fresh stream of the same bytes. Every other URL
 * passes through untouched.
 */
export async function captureInboundRawBody(
  request: { readonly url?: string; rawBody?: Buffer },
  _reply: unknown,
  payload: NodeJS.ReadableStream,
): Promise<NodeJS.ReadableStream> {
  if (!isInboundWebhookRoute(request.url) && !isBounceIntakeRoute(request.url)) return payload;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of payload) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_WEBHOOK_BODY_BYTES) {
      throw Object.assign(new Error('Payload Too Large'), { statusCode: 413 });
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks);
  request.rawBody = raw;
  const replay = Readable.from([raw], { objectMode: false });
  return Object.assign(replay, { receivedEncodedLength: raw.length });
}

/** The vendor type's parser: the bytes `captureInboundRawBody` kept; 415 on any other URL. */
export function parseInboundVendorBody(
  request: { readonly url?: string },
  body: Buffer,
  done: (error: Error | null, value?: unknown) => void,
): void {
  if (!isInboundWebhookRoute(request.url)) {
    done(Object.assign(new Error('Unsupported Media Type'), { statusCode: 415 }));
    return;
  }
  done(null, body);
}

/** 56-26: the bounce parser — the bytes `captureInboundRawBody` kept; 415 on any other URL. */
export function parseBounceBody(
  request: { readonly url?: string },
  body: Buffer,
  done: (error: Error | null, value?: unknown) => void,
): void {
  if (!isBounceIntakeRoute(request.url)) {
    done(Object.assign(new Error('Unsupported Media Type'), { statusCode: 415 }));
    return;
  }
  done(null, body);
}

interface FastifyCapable {
  addHook(
    name: 'preParsing',
    hook: (
      request: { readonly url?: string; rawBody?: Buffer },
      reply: unknown,
      payload: NodeJS.ReadableStream,
    ) => Promise<NodeJS.ReadableStream>,
  ): void;
  addContentTypeParser(
    type: string,
    options: { readonly parseAs: 'buffer'; readonly bodyLimit: number },
    parser: (
      request: { readonly url?: string },
      body: Buffer,
      done: (error: Error | null, value?: unknown) => void,
    ) => void,
  ): void;
}

/**
 * Registers the raw-body hook and the vendor parser at boot. If either cannot be registered the
 * route has no raw body and answers 401: it fails closed.
 */
@Injectable()
export class InboundWebhookBodyCapture implements OnApplicationBootstrap {
  private readonly logger = new Logger('InboundWebhookBodyCapture');

  constructor(@Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost) {}

  onApplicationBootstrap(): void {
    const adapter = this.adapterHost.httpAdapter as
      HttpAdapterHost['httpAdapter'] | null | undefined;
    if (adapter == null) return;
    try {
      const instance = adapter.getInstance<FastifyCapable>();
      instance.addHook('preParsing', captureInboundRawBody);
      instance.addContentTypeParser(
        INBOUND_WEBHOOK_CONTENT_TYPE,
        { parseAs: 'buffer', bodyLimit: MAX_WEBHOOK_BODY_BYTES },
        parseInboundVendorBody,
      );
      instance.addContentTypeParser(
        BOUNCE_CONTENT_TYPE,
        { parseAs: 'buffer', bodyLimit: MAX_BOUNCE_BYTES },
        parseBounceBody,
      );
    } catch (error) {
      this.logger.warn(`Inbound e-mail webhook body capture not registered: ${String(error)}`);
    }
  }
}
