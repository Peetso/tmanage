import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { OneDriveAttachmentsController } from '../onedrive/onedrive.controller.js';
import { GoogleDriveAttachmentsController } from './google-drive.controller.js';

/**
 * FIX6 review L1 — a task file never goes straight into the company's drive. The old routes
 * (`POST …/work-items/:id/{google-drive,onedrive}/uploads`) handed any member who could edit a task
 * a pre-authenticated upload link into the owner's drive, with none of TManage's file checks.
 * Task files now upload to TManage storage; only attaching an existing drive file remains.
 */
function routePaths(controller: { prototype: object }): string[] {
  const proto = controller.prototype;
  return Object.getOwnPropertyNames(proto)
    .map((name) => {
      const handler: unknown = Reflect.get(proto, name);
      return typeof handler === 'function'
        ? (Reflect.getMetadata('path', handler) as unknown)
        : undefined;
    })
    .filter((path): path is string => typeof path === 'string');
}

describe('the drive task routes', () => {
  it('offer attach, list and detach, and no upload into the drive', () => {
    for (const controller of [GoogleDriveAttachmentsController, OneDriveAttachmentsController]) {
      const paths = routePaths(controller);
      expect(paths).toContain('attachments');
      expect(paths.some((path) => path.includes('upload'))).toBe(false);
    }
  });
});
