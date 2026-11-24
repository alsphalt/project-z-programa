import { z } from 'zod';
import { ok, rateLimit, route } from '@/lib/api';
import { saveCaseEdit } from '@/lib/crashfix/save';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const schema = z.object({
  projectId: z.string().min(1),
  fileId: z.string().min(1),
  caseName: z.string().min(1).max(200),
  caseStart: z.number().int().min(0),
  expectedFileSha: z.string().min(16),
  expectedCaseSha: z.string().optional(),
  expectedCaseCode: z.string().optional(),
  nextCode: z.string().min(1).max(400_000),
});

/**
 * Writes the repaired case into the real project file. The response only reports
 * success after the conditional write and the re-read both succeeded.
 */
export const POST = route({ permission: 'file.write' }, async ({ user, body }) => {
  rateLimit(`crashfix-save:${user.id}`, 90, 60_000);
  const input = await body(schema);
  const result = await saveCaseEdit({ ...input, userId: user.id });
  return ok({
    ...result,
    message: 'CASE UPDATED SUCCESSFULLY',
  });
});
