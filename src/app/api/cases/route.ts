import { z } from 'zod';
import { route, ok, ApiError } from '@/lib/api';
import { assertServerAccess } from '@/lib/servers/repo';
import { listCases, previewCaseEdit } from '@/lib/services/cases';
import { sha256 } from '@/lib/crypto';
import { query, queryOne } from '@/lib/db';
import type { CaseAction } from '@/lib/services/cases';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Cases discovered by the AST scan of the indexed production files. */
export const GET = route({ permission: 'file.read' }, async ({ req, user }) => {
  const url = new URL(req.url);
  const serverId = url.searchParams.get('serverId');
  if (!serverId) throw new ApiError('serverId is required', 400, 'server_required');
  const server = await assertServerAccess(user, serverId, 'file.read');

  const rows = await listCases(server.id, {
    search: url.searchParams.get('q') ?? undefined,
    path: url.searchParams.get('path') ?? undefined,
    limit: 600,
  });

  const files = await query<{ path: string; sha256: string | null; size_bytes: string | number; indexed_at: string }>(
    `select path, sha256, size_bytes, indexed_at from file_indexes
      where server_id = $1 and is_directory = false and deleted_at is null
        and (path like '%.js' or path like '%.cjs' or path like '%.mjs' or path like '%.ts')
      order by size_bytes desc limit 60`,
    [server.id],
  );

  const configRow = await queryOne<{ path: string }>(
    `select path from file_indexes where server_id = $1 and name = 'config.json' and deleted_at is null limit 1`,
    [server.id],
  );

  return ok({
    cases: rows.map((row) => ({
      id: row.id,
      name: row.name,
      filePath: row.path,
      line: row.lineStart,
      endLine: row.lineEnd,
      aliases: row.aliases,
      fileSha: row.sha256,
    })),
    files: files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      size: Number(file.size_bytes ?? 0),
      indexedAt: file.indexed_at,
    })),
    aliasesSource: configRow?.path ?? null,
    note:
      'Cases are parsed from the real files with an AST walk, so nested switches and commented-out labels are not reported as commands. Re-scan after changing a file in the panel.',
  });
});

const previewSchema = z.object({
  serverId: z.string().min(1),
  path: z.string().min(1),
  name: z.string().min(1),
  action: z.enum(['delete-block', 'duplicate-block', 'replace-block']),
  replacement: z.string().optional(),
  newName: z.string().optional(),
});

function issueLine(message: string): number {
  const match = /line\s+(\d+)/i.exec(message);
  return match ? Number(match[1]) : 1;
}

/**
 * Build the edited file in memory and validate it. Nothing is written here — the
 * caller reviews the result and then deploys it through /api/deployments.
 */
export const POST = route({ permission: 'file.write' }, async ({ user, body }) => {
  const input = await body(previewSchema);
  const server = await assertServerAccess(user, input.serverId, 'file.write');

  const action: CaseAction =
    input.action === 'delete-block' ? 'delete' : input.action === 'duplicate-block' ? 'duplicate' : 'replace';

  if (action === 'replace' && !input.replacement?.trim()) {
    throw new ApiError('Replacement code is required to replace a case body.', 400, 'replacement_required');
  }
  if (action === 'duplicate' && !input.newName?.trim()) {
    throw new ApiError('A new case name is required to duplicate a case.', 400, 'name_required');
  }

  const preview = await previewCaseEdit({
    server,
    path: input.path,
    name: input.name,
    action,
    replacement: input.replacement,
    newName: input.newName,
  });

  const balance = preview.structure.otherCasesIntact
    ? []
    : [
        {
          line: 1,
          message: `Structural check failed: ${preview.structure.removedCases.length} case(s) disappeared and the before/after case count changed from ${preview.structure.beforeCases} to ${preview.structure.afterCases}.`,
        },
      ];

  return ok({
    content: preview.afterContent,
    newSha: sha256(preview.afterContent),
    originalSha: preview.beforeHash,
    validation: {
      ok: preview.validation.ok,
      errors: preview.validation.errors.map((message) => ({ line: issueLine(message), message })),
      warnings: preview.validation.warnings,
    },
    balance,
    structure: preview.structure,
    lines: preview.lines,
    warning: preview.warnings.length ? preview.warnings.join(' ') : undefined,
  });
});
