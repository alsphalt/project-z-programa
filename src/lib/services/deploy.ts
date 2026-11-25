import 'server-only';
import { jsonb, parseJsonb, query, queryOne } from '../db';
import { randomToken, sha256, uuid } from '../crypto';
import { ApiError } from '../api';
import type { ServerRecord } from '../servers/repo';
import { serverClient } from '../servers/repo';
import { fetchRemoteFile, validateContent, writeProductionFile } from '../files/service';
import { backupStorage } from '../backups/storage';
import { baseName, confineToRoot, extensionOf, isSecretPath, isProbablyBinary } from '../security/paths';
import { waitForStartup, power } from './console';
import { logActivity } from '../audit';
import { captureError } from '../errors/store';
import type { Principal } from '../auth/permissions';

export interface ChangeRequest {
  path: string;
  content: string;
  expectedHash?: string | null;
  note?: string;
}

export interface DeploymentFileResult {
  path: string;
  status: 'written' | 'failed' | 'rolled_back' | 'skipped';
  backupId?: string;
  preHash?: string | null;
  postHash?: string | null;
  version?: number;
  error?: string;
}

export interface DeploymentOutcome {
  id: string;
  status: 'succeeded' | 'failed' | 'rolled_back';
  files: DeploymentFileResult[];
  restarted: boolean;
  health: { verdict: string; detail: string; observedStates?: string[]; logs?: string[] };
  logs: Array<{ level: string; step: string | null; message: string; at: string }>;
  error?: string;
  warnings: string[];
  lockReleased: boolean;
}

const RESTART_EXTENSIONS = new Set(['js', 'cjs', 'mjs', 'ts', 'jsx', 'tsx', 'json', 'sh']);
const LOCK_TTL_MS = 10 * 60_000;

async function writeLog(
  deploymentId: string,
  level: 'info' | 'warn' | 'error' | 'success',
  step: string,
  message: string,
  detail?: unknown,
): Promise<void> {
  await query(
    `insert into deployment_logs (deployment_id, level, step, message, detail) values ($1,$2,$3,$4,$5::jsonb)`,
    [deploymentId, level, step, message, jsonb(detail ?? {})],
  );
}

async function acquireLock(serverId: string, deploymentId: string, owner: string): Promise<boolean> {
  const expires = new Date(Date.now() + LOCK_TTL_MS).toISOString();
  const rows = await query<{ deployment_id: string }>(
    `insert into deployment_locks (server_id, deployment_id, owner, expires_at)
     values ($1,$2,$3,$4::timestamptz)
     on conflict (server_id) do update
       set deployment_id = excluded.deployment_id, owner = excluded.owner,
           acquired_at = now(), expires_at = excluded.expires_at
       where deployment_locks.expires_at < now()
     returning deployment_id`,
    [serverId, deploymentId, owner, expires],
  );
  return rows.length > 0 && rows[0].deployment_id === deploymentId;
}

async function releaseLock(serverId: string, deploymentId: string): Promise<void> {
  await query('delete from deployment_locks where server_id = $1 and deployment_id = $2', [serverId, deploymentId]);
}

export async function currentLock(serverId: string): Promise<{ owner: string; expiresAt: string } | null> {
  const row = await queryOne<{ owner: string; expires_at: string }>(
    'select owner, expires_at from deployment_locks where server_id = $1 and expires_at > now()',
    [serverId],
  );
  return row ? { owner: row.owner, expiresAt: row.expires_at } : null;
}

function shouldRestart(changes: ChangeRequest[], mode: 'auto' | 'always' | 'never'): boolean {
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  return changes.some((change) => RESTART_EXTENSIONS.has(extensionOf(baseName(change.path))));
}

async function dependencyWarnings(
  server: ServerRecord,
  changes: ChangeRequest[],
): Promise<{ warnings: string[]; addedDependencies: string[] }> {
  const pkg = changes.find((change) => baseName(change.path) === 'package.json');
  if (!pkg) return { warnings: [], addedDependencies: [] };
  const warnings: string[] = [];
  let next: { dependencies?: Record<string, string>; scripts?: Record<string, string> };
  try {
    next = JSON.parse(pkg.content);
  } catch {
    return { warnings: ['package.json does not parse — deployment blocked'], addedDependencies: [] };
  }
  if (!next.scripts?.start) warnings.push('package.json has no "start" script — the panel startup command may fail');
  let previousDeps: Record<string, string> = {};
  try {
    const current = await fetchRemoteFile(server, pkg.path, { withStat: false });
    previousDeps = (JSON.parse(current.content).dependencies ?? {}) as Record<string, string>;
  } catch {
    /* first upload of package.json */
  }
  const added = Object.keys(next.dependencies ?? {}).filter((name) => !(name in previousDeps));
  if (added.length) {
    warnings.push(
      `New dependencies detected: ${added.join(', ')}. The file API cannot install packages — run "npm install" in the console after deploying, or the bot may fail to start.`,
    );
  }
  return { warnings, addedDependencies: added };
}

/**
 * The only path through which content reaches production.
 *
 * validate → lock → backup → write → verify → restart → observe → (rollback)
 */
export async function deployChanges(options: {
  server: ServerRecord;
  user: Pick<Principal, 'id' | 'email'>;
  changes: ChangeRequest[];
  note?: string;
  restartMode?: 'auto' | 'always' | 'never';
  installDependencies?: boolean;
}): Promise<DeploymentOutcome> {
  const { server, user } = options;
  const restartMode = options.restartMode ?? 'auto';
  const warnings: string[] = [];
  const fileResults: DeploymentFileResult[] = [];
  const logs: DeploymentOutcome['logs'] = [];

  if (!options.changes.length) {
    throw new ApiError('There is nothing to deploy.', 400, 'no_changes');
  }

  const seen = new Set<string>();
  const changes: ChangeRequest[] = options.changes.map((change) => {
    const target = confineToRoot(server.projectRoot, change.path);
    if (seen.has(target)) throw new ApiError(`Duplicate file in deployment: ${target}`, 400, 'duplicate_file');
    seen.add(target);
    if (isSecretPath(target)) {
      throw new ApiError(`Refusing to deploy to protected path ${target}`, 403, 'secret_blocked');
    }
    if (isProbablyBinary(target)) {
      throw new ApiError(`Binary file ${target} must be uploaded, not deployed as text`, 415, 'binary_deploy');
    }
    return { ...change, path: target, content: change.content };
  });

  const deploymentId = uuid();
  const depWarn = await dependencyWarnings(server, changes);
  warnings.push(...depWarn.warnings);

  // ---- validation (no production write happens before this passes) ---------
  for (const change of changes) {
    const result = await validateContent(change.path, change.content);
    warnings.push(...result.warnings.map((warning) => `${change.path}: ${warning}`));
    if (!result.ok) {
      throw new ApiError(
        `Validation failed for ${change.path}: ${result.errors.join('; ')}`,
        422,
        'validation_failed',
        { path: change.path, errors: result.errors },
      );
    }
  }

  const locked = await acquireLock(server.id, deploymentId, `${user.email}:${deploymentId.slice(0, 8)}`);
  if (!locked) {
    const existing = await currentLock(server.id);
    throw new ApiError(
      `Another deployment is in progress${existing ? ` (lock held until ${new Date(existing.expiresAt).toLocaleTimeString()})` : ''}. Try again when it finishes.`,
      409,
      'deployment_locked',
    );
  }

  const restartPlanned = shouldRestart(changes, restartMode);
  await query(
    `insert into deployments (id, server_id, status, trigger, file_count, files, validation, restart_requested, notes, created_by)
     values ($1,$2,'running','manual',$3,$4::jsonb,$5::jsonb,$6,$7,$8)`,
    [
      deploymentId,
      server.id,
      changes.length,
      jsonb(changes.map((change) => ({ path: change.path, bytes: Buffer.byteLength(change.content) }))),
      jsonb({ warnings, dependencies: depWarn.addedDependencies }),
      restartPlanned,
      options.note ?? null,
      user.id,
    ],
  );
  const log = async (level: 'info' | 'warn' | 'error' | 'success', step: string, message: string, detail?: unknown) => {
    logs.push({ level, step, message, at: new Date().toISOString() });
    await writeLog(deploymentId, level, step, message, detail);
  };

  await log('info', 'start', `Deployment ${deploymentId} started for ${changes.length} file(s).`);

  let restarted = false;
  let health: DeploymentOutcome['health'] = { verdict: 'not-checked', detail: 'No restart was required.' };
  let failure: string | undefined;

  try {
    // ---- write phase -------------------------------------------------------
    for (const change of changes) {
      try {
        await log('info', 'write', `Writing ${change.path}`);
        const result = await writeProductionFile({
          server,
          path: change.path,
          content: change.content,
          expectedHash: change.expectedHash ?? null,
          note: options.note ?? 'Deployment',
          userId: user.id,
          deploymentId,
        });
        fileResults.push({
          path: change.path,
          status: 'written',
          backupId: result.backupId,
          preHash: result.previousHash,
          postHash: result.hash,
          version: result.version,
        });
        await log('success', 'write', `${change.path} written and verified (${result.hash.slice(0, 12)}…).`, {
          atomic: result.atomic,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fileResults.push({ path: change.path, status: 'failed', error: message });
        await log('error', 'write', `Failed to write ${change.path}: ${message}`);
        throw error;
      }
    }

    // ---- dependency install (optional, console only, never faked) ----------
    if (depWarn.addedDependencies.length && options.installDependencies) {
      const client = await serverClient(server);
      await client.sendCommand('npm install');
      await log('warn', 'dependencies', 'Sent "npm install" to the server console.');
    }

    // ---- restart -----------------------------------------------------------
    if (restartPlanned) {
      await log('info', 'restart', 'Requesting a restart so the new code is loaded.');
      const client = await serverClient(server);
      await client.sendPower('restart');
      restarted = true;
      await query('update deployments set restart_performed = true where id = $1', [deploymentId]);
      await log('info', 'restart', 'Restart signal accepted by the panel.');

      await log('info', 'health', `Waiting for startup (timeout ${server.startupTimeoutS}s).`);
      health = await waitForStartup(server, server.startupTimeoutS);
      // Only an observed crash or a timeout is a deployment failure. "unknown"
      // means the panel would not give us console output — the files are still
      // written and verified, so the deployment stands but is reported as
      // unverified rather than silently called healthy.
      const fatal = health.verdict === 'crashed' || health.verdict === 'timeout';
      await log(health.verdict === 'healthy' ? 'success' : fatal ? 'error' : 'warn', 'health', health.detail);
      if (fatal) {
        failure = `Startup health check failed: ${health.detail}`;
        captureError({
          message: failure,
          source: 'deployment',
          serverId: server.id,
          code: 'deployment_health_failed',
          userId: user.id,
          context: { deploymentId, health, logs: health.logs?.slice(-20) ?? [] },
          evidence: health.logs?.slice(-5) ?? [],
        });
      }
    } else {
      const client = await serverClient(server);
      const resources = await client.getResources();
      health = {
        verdict: String(resources.current_state) === 'running' ? 'running' : 'unknown',
        detail: `No restart was required (${changes
          .map((change) => change.path)
          .join(', ')} do not need a process reload). Container state: ${resources.current_state}.`,
      };
      await log('info', 'health', health.detail);
    }

    if (failure) {
      await rollbackFiles(deploymentId, server, user, fileResults);
      await log('warn', 'rollback', 'Restored the previous production content because the health check failed.');
      if (restartPlanned) {
        try {
          const client = await serverClient(server);
          await client.sendPower('restart');
          await log('info', 'rollback', 'Restart requested after rollback.');
        } catch (error) {
          await log('error', 'rollback', `Restart after rollback failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await query(
        `update deployments set status = 'rolled_back', error = $2, health = $3::jsonb, finished_at = now(),
           post_hashes = $4::jsonb where id = $1`,
        [deploymentId, failure, jsonb(health), jsonb(Object.fromEntries(fileResults.map((r) => [r.path, r.postHash ?? null])))],
      );
      await logActivity({
        user,
        serverId: server.id,
        action: 'deployment.rolled_back',
        target: deploymentId,
        severity: 'critical',
        detail: { failure },
      });
      return {
        id: deploymentId,
        status: 'rolled_back',
        files: fileResults.map((result) =>
          result.status === 'written' ? { ...result, status: 'rolled_back' as const } : result,
        ),
        restarted,
        health,
        logs,
        error: failure,
        warnings,
        lockReleased: true,
      };
    }

    await query(
      `update deployments set status = 'succeeded', health = $2::jsonb,
         pre_hashes = $3::jsonb, post_hashes = $4::jsonb, finished_at = now() where id = $1`,
      [
        deploymentId,
        jsonb(health),
        jsonb(Object.fromEntries(fileResults.map((row) => [row.path, row.preHash ?? null]))),
        jsonb(Object.fromEntries(fileResults.map((row) => [row.path, row.postHash ?? null]))),
      ],
    );
    await query('update connected_servers set last_sync_at = now(), connection_state = $2 where id = $1', [
      server.id,
      'synchronized',
    ]);
    await log('success', 'done', 'Deployment finished successfully.');
    await logActivity({
      user,
      serverId: server.id,
      action: 'deployment.succeeded',
      target: deploymentId,
      detail: { files: changes.map((change) => change.path), restarted },
    });

    return {
      id: deploymentId,
      status: 'succeeded',
      files: fileResults,
      restarted,
      health,
      logs,
      warnings,
      lockReleased: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await log('error', 'abort', `Deployment aborted: ${message}`);
    captureError({
      message,
      source: 'deployment',
      serverId: server.id,
      code: error instanceof ApiError ? error.code : undefined,
      userId: user.id,
      httpStatus: error instanceof ApiError ? error.status : undefined,
      context: { deploymentId, files: changes.map((change) => change.path) },
      evidence: [message],
    });
    const written = fileResults.filter((result) => result.status === 'written');
    if (written.length) {
      await rollbackFiles(deploymentId, server, user, fileResults);
      await log('warn', 'rollback', `Restored ${written.length} file(s) from their pre-deployment backups.`);
    }
    await query(
      `update deployments set status = 'failed', error = $2, health = $3::jsonb, finished_at = now() where id = $1`,
      [deploymentId, message, jsonb(health)],
    );
    await logActivity({
      user,
      serverId: server.id,
      action: 'deployment.failed',
      target: deploymentId,
      severity: 'critical',
      detail: { message },
    });
    return {
      id: deploymentId,
      status: written.length ? 'rolled_back' : 'failed',
      files: fileResults.map((result) =>
        result.status === 'written' ? { ...result, status: 'rolled_back' as const } : result,
      ),
      restarted,
      health,
      logs,
      error: message,
      warnings,
      lockReleased: true,
    };
  } finally {
    await releaseLock(server.id, deploymentId);
  }
}

/** Restore only the files this deployment touched, using its own backups. */
async function rollbackFiles(
  deploymentId: string,
  server: ServerRecord,
  user: { id: string; email: string },
  results: DeploymentFileResult[],
): Promise<void> {
  for (const result of [...results].reverse()) {
    if (result.status !== 'written' || !result.backupId) continue;
    const backup = await queryOne<{ storage_key: string }>(
      'select storage_key from file_backups where id = $1',
      [result.backupId],
    );
    if (!backup) continue;
    try {
      const buffer = await backupStorage().get(backup.storage_key);
      await writeProductionFile({
        server,
        path: result.path,
        content: buffer.toString('utf8'),
        expectedHash: null,
        note: `Rollback of deployment ${deploymentId}`,
        userId: user.id,
        deploymentId: null,
        allowEmpty: true,
      });
      result.status = 'rolled_back';
    } catch (error) {
      await writeLog(
        deploymentId,
        'error',
        'rollback',
        `Could not restore ${result.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export async function rollbackDeployment(options: {
  server: ServerRecord;
  user: { id: string; email: string };
  deploymentId: string;
}): Promise<{ restored: string[]; failed: Array<{ path: string; error: string }>; restarted: boolean; detail: string }> {
  const { server, user, deploymentId } = options;
  const deployment = await queryOne<{
    id: string;
    status: string;
    files: unknown;
    server_id: string;
  }>('select id, status, files, server_id from deployments where id = $1', [deploymentId]);
  if (!deployment || deployment.server_id !== server.id) {
    throw new ApiError('Deployment not found for this server', 404, 'deployment_not_found');
  }
  const files = parseJsonb<Array<{ path: string }>>(deployment.files, []);
  const versions = await query<{ path: string; backup_id: string | null; sha256: string }>(
    `select distinct on (path) path, backup_id, sha256 from file_versions
      where deployment_id = $1 and backup_id is not null order by path, version desc`,
    [deploymentId],
  );

  const restored: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  if (!versions.length) {
    throw new ApiError(
      'No pre-deployment backups were recorded for this deployment, so it cannot be rolled back automatically.',
      409,
      'no_rollback_data',
    );
  }

  for (const version of versions) {
    const backup = version.backup_id
      ? await queryOne<{ storage_key: string }>('select storage_key from file_backups where id = $1', [version.backup_id])
      : null;
    if (!backup) {
      failed.push({ path: version.path, error: 'Backup object missing from storage' });
      continue;
    }
    try {
      const buffer = await backupStorage().get(backup.storage_key);
      await writeProductionFile({
        server,
        path: version.path,
        content: buffer.toString('utf8'),
        expectedHash: null,
        note: `Manual rollback of deployment ${deploymentId}`,
        userId: user.id,
        allowEmpty: true,
      });
      restored.push(version.path);
    } catch (error) {
      failed.push({ path: version.path, error: error instanceof Error ? error.message : String(error) });
    }
  }

  let restarted = false;
  if (restored.length && server.autoRestart) {
    try {
      const client = await serverClient(server);
      await client.sendPower('restart');
      restarted = true;
    } catch {
      restarted = false;
    }
  }
  await query(`update deployments set status = 'rolled_back', finished_at = now() where id = $1`, [deploymentId]);
  await logActivity({
    user,
    serverId: server.id,
    action: 'deployment.rollback_manual',
    target: deploymentId,
    severity: 'warning',
    detail: { restored, failed: failed.map((item) => item.path) },
  });
  return {
    restored,
    failed,
    restarted,
    detail: `Restored ${restored.length} file(s)${failed.length ? `, ${failed.length} failed` : ''}.${restarted ? ' Bot restart requested.' : ''}`,
  };
}

export async function deploymentDetail(serverId: string, deploymentId: string) {
  const deployment = await queryOne(
    'select * from deployments where id = $1 and server_id = $2',
    [deploymentId, serverId],
  );
  if (!deployment) return null;
  const logs = await query(
    'select level, step, message, detail, created_at from deployment_logs where deployment_id = $1 order by id asc',
    [deploymentId],
  );
  return { deployment, logs };
}

export async function listDeployments(serverId: string, limit = 40) {
  return query(
    `select id, status, trigger, file_count, restart_requested, restart_performed, error, created_by,
            started_at, finished_at, health, notes
       from deployments where server_id = $1 order by started_at desc limit $2`,
    [serverId, limit],
  );
}

/**
 * Compute a stable plan hash so a previewed global replacement can only be
 * applied if the same files, hashes and replacement text are still in place.
 */
export function planHash(input: unknown): string {
  return sha256(JSON.stringify(input));
}
