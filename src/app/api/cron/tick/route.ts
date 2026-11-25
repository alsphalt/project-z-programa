import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Scheduler entry point for serverless deployments.
 *
 * A long-running server drains the GitHub push queue and polls remote branches
 * from `src/lib/worker/boot.ts`. On Vercel the function is frozen after the
 * response, so those timers never fire again: this endpoint is what replaces
 * them, driven by Vercel Cron (`vercel.json`).
 *
 * Auth is `Authorization: Bearer $CRON_SECRET`, which is exactly what Vercel
 * Cron sends when the variable exists. Without the variable configured the
 * endpoint refuses (503) instead of running unprotected work that talks to the
 * panel and GitHub.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'CRON_SECRET is not set, so scheduled work is disabled. Add CRON_SECRET to the project environment variables and redeploy.',
      },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }

  const authorization = request.headers.get('authorization') ?? '';
  if (authorization !== `Bearer ${secret}`) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401, headers: { 'cache-control': 'no-store' } },
    );
  }

  try {
    const [{ runDueSyncJobs }, { pollRemoteProjects }] = await Promise.all([
      import('@/lib/github/sync'),
      import('@/lib/github/pull'),
    ]);

    const sync = await runDueSyncJobs(5);
    const pull = await pollRemoteProjects();

    return NextResponse.json(
      {
        ok: true,
        ranAt: new Date().toISOString(),
        sync,
        pull: {
          checked: pull.checked,
          pulled: pull.pulled,
          // Names only: enough to act on, no repository contents in a cron log.
          errors: pull.errors.slice(0, 5),
          errorCount: pull.errors.length,
        },
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ranAt: new Date().toISOString(),
      },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    );
  }
}
