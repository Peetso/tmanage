import { Global, Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { MALWARE_SCANNER } from '../http/tokens.js';
import { ClamavScanner } from './clamav-scanner.js';
import type { ClamavTlsOptions } from './clamav-scanner.js';
import { NoneScanner, StubScanner } from './malware-scanner.js';
import type { MalwareScanner } from './malware-scanner.js';

/**
 * The scanner wiring — `StorageModule`'s dual shape, applied to the third network
 * resource. `forConfig` is what `app-composition.ts` calls with the environment's
 * answers; `forScanner` is what a suite calls with the driver it holds; `none()` is what
 * `AppModule` falls back to when the composition root passes nothing — the `none` driver,
 * under which the scan pass records `unscanned` and promotes nothing, so a suite that never
 * runs the pass sees no difference and one that does sees the bootstrap profile's truth.
 *
 * `@Global` for the storage module's reason: the consumer is `FilesModule`, built through
 * `.register()`, and importing a dynamic module twice builds it twice.
 */

export interface ScannerModuleConfig {
  readonly driver: 'none' | 'stub' | 'clamav';
  /** `CLAMAV_HOST`; `packages/config` requires it for `clamav`. */
  readonly host?: string | undefined;
  /** `CLAMAV_PORT`. */
  readonly port: number;
  /** `MALWARE_SCAN_TIMEOUT_MS`. */
  readonly timeoutMs: number;
  /** `CLAMAV_TLS=1` with its pin / CA / servername; absent = plain TCP. */
  readonly tls?: ClamavTlsOptions | undefined;
}

function driverFrom(config: ScannerModuleConfig): MalwareScanner {
  if (config.driver === 'none') return new NoneScanner();
  if (config.driver === 'stub') return new StubScanner();
  if (config.host === undefined || config.host === '') {
    // `packages/config` already refuses this combination at boot; repeated here so a
    // caller that bypassed `loadEnv` fails at wiring time rather than at the first scan.
    throw new Error('MALWARE_SCAN_DRIVER=clamav requires CLAMAV_HOST');
  }
  return new ClamavScanner({
    host: config.host,
    port: config.port,
    timeoutMs: config.timeoutMs,
    tls: config.tls,
  });
}

function moduleFor(scanner: MalwareScanner): DynamicModule {
  const providers: Provider[] = [{ provide: MALWARE_SCANNER, useValue: scanner }];
  return { module: ScannerModule, global: true, providers, exports: providers };
}

@Global()
@Module({})
export class ScannerModule {
  static forConfig(config: ScannerModuleConfig): DynamicModule {
    return moduleFor(driverFrom(config));
  }

  /** A suite's scanner, held by the suite. */
  static forScanner(scanner: MalwareScanner): DynamicModule {
    return moduleFor(scanner);
  }

  /** The `none` driver: nothing is scanned, nothing is promoted, and the rows say so. */
  static none(): DynamicModule {
    return moduleFor(new NoneScanner());
  }
}
