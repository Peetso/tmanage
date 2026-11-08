import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { OPS, opsById } from './index.js';
import { MCP_READ_GAPS_WITHHELD, mcpReadGapDetails } from './mcp-read-gaps.js';
import { allDetailsById, buildToolCatalog, toolNameForOp } from '../../mcp/tool-catalog.js';

/** The 23 classified GET reads that had no MCP tool when 52-22 started (of 52 gaps in all). */
const READ_GAPS_52_22 = [
  'glossary.terms.list',
  'message_bookmarks.list',
  'objectives.list',
  'objectives.key_results.list',
  'objectives.work_links.list',
  'onboarding.tour.list',
  'recent_documents.list',
  'org.settings.file_safety.get',
  'upload_sessions.list',
  'upload_sessions.get',
  'usage.list',
  'google_drive.storage.get',
  'google_drive.attachments.list',
  'onedrive.storage.get',
  'onedrive.attachments.list',
  'meeting_guests.list',
  'iterations.list',
  'iterations.get',
  'iterations.burndown',
  'unfurl.get',
  'inbound_email.address.get',
  'inbound_email.log.get',
  'inbound_email.attachments.get',
] as const;

const ALL_CAPS: ReadonlySet<string> = new Set<string>(
  OPS.map((op) => op.capability).filter((c): c is NonNullable<typeof c> => c !== null),
);

describe('52-22 MCP read-gap coverage', () => {
  it('adds only classified read ops (list/get), never a write or confirm op', () => {
    for (const d of mcpReadGapDetails) {
      const op = opsById.get(d.id);
      expect(op, `unknown op ${d.id}`).toBeDefined();
      expect(op!.method).toBe('GET');
      expect(op!.risk).toBe('read');
    }
  });

  it('binds every path param, stays strict and accepts its examples', () => {
    for (const d of mcpReadGapDetails) {
      const shape = (d.input as z.ZodObject<z.ZodRawShape>).shape;
      for (const seg of opsById.get(d.id)!.path.split('/')) {
        if (seg.startsWith(':') && seg !== ':orgSlug') expect(shape).toHaveProperty(seg.slice(1));
      }
      expect(d.input.safeParse({ unknownKey: 'x', ...d.examples[0]!.args }).success).toBe(false);
      for (const ex of d.examples) expect(d.input.safeParse(ex.args).success).toBe(true);
    }
  });

  it('lists the new reads as read-only MCP tools on a read grant', () => {
    const names = new Set(
      buildToolCatalog({ profile: 'full', scopes: ['read'], capabilities: ALL_CAPS }).tools.map(
        (t) => t.name,
      ),
    );
    for (const d of mcpReadGapDetails) expect(names.has(toolNameForOp(d.id))).toBe(true);
  });

  it('covers every 52-22 read gap or withholds it on purpose', () => {
    for (const id of READ_GAPS_52_22) {
      const withheld = id in MCP_READ_GAPS_WITHHELD;
      expect(allDetailsById.has(id), `${id}`).toBe(!withheld);
    }
    expect(mcpReadGapDetails.length + Object.keys(MCP_READ_GAPS_WITHHELD).length).toBe(
      READ_GAPS_52_22.length,
    );
  });
});
