import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { platformBootstrapLine } from './platform-admin.access.js';
import type { PlatformBootstrapAccount } from './platform-admin.access.js';
import {
  PLATFORM_ADMIN_ALLOWLIST,
  PLATFORM_ADMIN_LOOKUP,
  PLATFORM_STAFF_TWO_STEP,
  platformTwoStepRequired,
} from './platform-admin.guard.js';

/** The part of the repository the start-up line needs. */
export interface PlatformBootstrapLookup {
  bootstrapAccounts?(
    emails: readonly string[],
    correlationId: string,
  ): Promise<readonly PlatformBootstrapAccount[]>;
}

/**
 * PLATFORMFIX — at every start, one log line says what `PLATFORM_ADMIN_EMAILS` amounts to:
 * how many addresses, how many have an account, how many are confirmed, how many can open
 * Platform admin (counts only, never an address). A failed read is logged and never stops the
 * start: the list itself is checked again on every request.
 */
@Injectable()
export class PlatformBootstrapReport implements OnApplicationBootstrap {
  private readonly logger = new Logger('PlatformAdmin');

  constructor(
    @Inject(PLATFORM_ADMIN_ALLOWLIST) private readonly allowlist: readonly string[],
    @Inject(PLATFORM_ADMIN_LOOKUP) private readonly lookup: PlatformBootstrapLookup,
    @Optional()
    @Inject(PLATFORM_STAFF_TWO_STEP)
    private readonly twoStepRequired: boolean = platformTwoStepRequired(process.env),
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.logger.log(await this.line());
  }

  async line(): Promise<string> {
    try {
      const accounts = this.lookup.bootstrapAccounts
        ? await this.lookup.bootstrapAccounts(this.allowlist, randomUUID())
        : [];
      return platformBootstrapLine(this.allowlist.length, accounts, this.twoStepRequired);
    } catch {
      return `platform bootstrap: ${this.allowlist.length} address(es) configured; the account check failed`;
    }
  }
}
