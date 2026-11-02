import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  ownHostsFrom,
  systemEgressResolver,
  type EgressResolver,
} from '../automations/egress-resolve.js';
import { UNFURL_SERVICE, UnfurlController } from './unfurl.controller.js';
import { UnfurlService, fetchUnfurlTransport, type UnfurlTransport } from './unfurl.service.js';

/** Test seams: the HTTP transport and the DNS resolver the egress check uses. */
export const UNFURL_TRANSPORT = Symbol('tmanage.unfurl.transport');
export const UNFURL_RESOLVER = Symbol('tmanage.unfurl.resolver');

export interface UnfurlModuleOptions {
  readonly transport?: UnfurlTransport;
  readonly resolve?: EgressResolver;
}

/**
 * R20-a (54-09 Phase 0) wiring. One in-process service (cache + per-org throttle live in it, so it
 * is a single instance), no table, no migration. Own hosts come from `API_PUBLIC_URL` /
 * `WEB_PUBLIC_URL`, as the webhook egress guard reads them.
 */
@Module({})
export class UnfurlModule {
  static register(options: UnfurlModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      { provide: UNFURL_TRANSPORT, useValue: options.transport ?? fetchUnfurlTransport },
      { provide: UNFURL_RESOLVER, useValue: options.resolve ?? systemEgressResolver },
      {
        provide: UNFURL_SERVICE,
        inject: [UNFURL_TRANSPORT, UNFURL_RESOLVER],
        useFactory: (transport: UnfurlTransport, resolve: EgressResolver) =>
          new UnfurlService({
            transport,
            resolve,
            ownHosts: ownHostsFrom([process.env['API_PUBLIC_URL'], process.env['WEB_PUBLIC_URL']]),
          }),
      },
    ];
    return { module: UnfurlModule, providers, controllers: [UnfurlController] };
  }
}
