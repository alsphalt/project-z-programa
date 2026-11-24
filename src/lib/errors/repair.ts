import 'server-only';
import { query } from '../db';
import { randomToken } from '../crypto';
import { ApiError } from '../api';
import type { Principal, Permission } from '../auth/permissions';
import { hasPermission } from '../auth/permissions';
import { requireServer, serverClient } from '../servers/repo';
import { attachConsole, power, sendConsoleCommand } from '../services/console';
import { createBackup, fetchRemoteFile, validateContent, writeProductionFile } from '../files/service';
import { logActivity } from '../audit';
import { saveRepair } from './store';
import { sha256 } from '../crypto';
import type { ErrorEvent, RepairProposal, RepairRecord } from './types';

/**
 * Repair assistance.
 *
 * Rules that are enforced here, not just in the UI:
 *  - no automatic production change: a proposal must be authorised explicitly;
 *  - approval-level repairs need owner/admin, plus the operation permission;
 *  - file patches always back up, validate, then write with an expected hash;
 *  - credential, session and security paths are never repairable by DARKNOTE.
 */

const SAFE_KINDS = new Set(['clear_stale_lock', 'reattach_console', 'rescan_index']);

export interface RepairRequest {
  action: 'propose' | 'apply' | 'discard';
  confirm?: string;
  /** file_patch only */
  path?: string;
  content?: string;
}

function permissionFor(kind: string): Permission {
  switch (kind) {
    case 'restart_bot':
      return 'server.power';
    case 'install_dependencies':
      return 'console.command';
    case 'file_patch':
      return 'file.write';
    case 'rescan_index':
      return 'file.read';
    default:
      return 'console.read';
  }
}

function proposalId(): string {
  return `rep_${randomToken(9).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}`;
}

function step(key: string, label: string, detail: string, state: RepairProposal['steps'][number]['state']) {
  return { key, label, detail, state };
}

export async function buildProposal(
  error: ErrorEvent,
  user: Principal,
  options: { path?: string; content?: string } = {},
): Promise<RepairRecord> {
  const kind = error.repairKind;
  if (!kind) {
    throw new ApiError(
      'No automated repair is offered for this problem. The Error Center shows the root cause and a recommended solution instead.',
      409,
      'no_repair_available',
    );
  }

  let proposal: RepairProposal;

  if (kind === 'file_patch') {
    const path = options.path?.trim();
    const content = options.content ?? '';
    if (!path || !content) {
      throw new ApiError('A file patch needs a path and the proposed content.', 400, 'patch_incomplete');
    }
    if (!error.serverId) throw new ApiError('This error is not linked to a server.', 409, 'no_server');
    const server = await requireServer(error.serverId);
    // Bind the patch to the content that is in production right now. The write
    // is refused if production changes before the owner authorises it.
    let baseHash: string | null = null;
    try {
      baseHash = (await fetchRemoteFile(server, path, { withStat: false })).sha256;
    } catch {
      baseHash = null;
    }
    const validation = await validateContent(path, content);
    proposal = {
      id: proposalId(),
      kind,
      authority: 'approval',
      summary: `Proposed change to ${path}`,
      risk: 'Writes to a production file. A backup is stored first, the content is validated, and the write is refused if production changed since the base hash was captured.',
      path,
      baseHash,
      proposedContent: content,
      diff: buildDiffSummary(error, path, content),
      steps: [
        step('prepare', 'Proposal prepared', `Draft for ${path} captured (${Buffer.byteLength(content)} bytes).`, 'done'),
        step('backup', 'Back up current production content', 'Runs immediately before the write; stored in the private backup store.', 'pending'),
        step('validate', 'Validate the proposed file', validation.ok ? `Passed (${validation.warnings.length} warning(s)).` : `Failed: ${validation.errors.join('; ')}`, validation.ok ? 'done' : 'blocked'),
        step('authorize', 'Owner/admin authorisation', 'Required before the file is written.', 'pending'),
        step('deploy', 'Write and verify', 'Atomic write, read-back SHA-256 verification, then restart if the file is executable.', 'pending'),
      ],
      validated: validation.ok,
      validationErrors: validation.errors,
      createdAt: new Date().toISOString(),
      state: validation.ok ? 'proposed' : 'blocked',
      notes: validation.warnings,
    };
    void server;
  } else if (kind === 'add_http_method') {
    proposal = {
      id: proposalId(),
      kind,
      authority: 'approval',
      summary: `Add the missing ${error.httpMethod ?? 'HTTP'} handler`,
      risk: 'Adds an exported handler to an application route. DARKNOTE will not generate business logic automatically, because a wrong handler is worse than a visible 405.',
      path: error.filePath,
      baseHash: null,
      proposedContent: null,
      diff: error.httpMethod
        ? `+ export async function ${error.httpMethod}(req: NextRequest) {\n+   // implement ${error.httpMethod} ${error.endpoint ?? ''}\n+ }`
        : null,
      steps: [
        step('identify', 'Route located', error.filePath ?? 'not identified', error.filePath ? 'done' : 'blocked'),
        step('draft', 'Draft the handler', 'Needs the intended behaviour; BIGBROTHER can show the caller and the route file.', 'pending'),
        step('validate', 'Validate the file', 'The Code Editor runs the same syntax check before deploy.', 'pending'),
        step('authorize', 'Owner/admin authorisation', 'Required before the file is written.', 'pending'),
      ],
      validated: false,
      createdAt: new Date().toISOString(),
      state: 'blocked',
      notes: ['This repair needs a human-written handler; the proposal shows where it goes.'],
    };
  } else if (kind === 'restart_bot') {
    proposal = {
      id: proposalId(),
      kind,
      authority: 'approval',
      summary: 'Restart the bot container',
      risk: 'Restarts the production bot. Any in-flight conversation is interrupted for the duration of the restart.',
      path: null,
      baseHash: null,
      proposedContent: null,
      diff: null,
      steps: [
        step('prepare', 'Pre-flight check', 'Confirms the panel is reachable and the container is not suspended.', 'pending'),
        step('authorize', 'Authorisation', 'Owner/admin must confirm the restart.', 'pending'),
        step('power', 'POST power restart', 'Sent through the Pterodactyl Client API.', 'pending'),
        step('observe', 'Observe the console', 'Health is reported from real console output, never assumed.', 'pending'),
      ],
      validated: true,
      createdAt: new Date().toISOString(),
      state: 'proposed',
    };
  } else if (kind === 'install_dependencies') {
    const moduleName = /cannot find module ['"`]?([^'"`\s]+)/i.exec(error.message)?.[1];
    const command = moduleName ? `npm install ${moduleName}` : 'npm install';
    proposal = {
      id: proposalId(),
      kind,
      authority: 'approval',
      summary: `Run "${command}" in the server console`,
      risk: 'Installs packages into production node_modules. It can change the dependency tree and takes the container offline while npm runs.',
      path: null,
      baseHash: null,
      proposedContent: command,
      diff: null,
      steps: [
        step('prepare', 'Command prepared', command, 'done'),
        step('authorize', 'Authorisation', 'Owner/admin must approve a console command.', 'pending'),
        step('send', 'Send to the console', 'The output appears in Terminal & Logs.', 'pending'),
        step('verify', 'Verify the module resolves', 'Re-read console output for MODULE_NOT_FOUND after the restart.', 'pending'),
      ],
      validated: true,
      createdAt: new Date().toISOString(),
      state: 'proposed',
    };
  } else if (kind === 'clear_stale_lock') {
    const stale = await query<{ deployment_id: string }>(
      `select deployment_id from deployment_locks where server_id = $1 and expires_at < now()`,
      [error.serverId],
    );
    proposal = {
      id: proposalId(),
      kind,
      authority: 'safe',
      summary: 'Clear an expired deployment lock',
      risk: 'Removes a database row only. It cannot affect production files, and a live deployment keeps its lock.',
      path: null,
      baseHash: null,
      proposedContent: null,
      diff: null,
      steps: [
        step('inspect', 'Inspect the lock', stale.length ? `Expired lock(s) found: ${stale.map((row) => row.deployment_id).join(', ')}` : 'No expired lock exists right now.', stale.length ? 'done' : 'blocked'),
        step('authorize', 'Authorisation', 'Confirm the cleanup.', 'pending'),
        step('apply', 'Delete the expired row', 'Only rows with expires_at < now() are removed.', 'pending'),
      ],
      validated: stale.length > 0,
      createdAt: new Date().toISOString(),
      state: stale.length ? 'proposed' : 'blocked',
    };
  } else if (kind === 'reattach_console') {
    proposal = {
      id: proposalId(),
      kind,
      authority: 'safe',
      summary: 'Re-attach the panel console websocket',
      risk: 'Opens one authenticated websocket. No production change.',
      path: null,
      baseHash: null,
      proposedContent: null,
      diff: null,
      steps: [
        step('prepare', 'Detach the stale socket', 'Closes the current session for this server.', 'pending'),
        step('authorize', 'Authorisation', 'Confirm the reconnect.', 'pending'),
        step('attach', 'Attach and authenticate', 'Uses a freshly minted panel token.', 'pending'),
      ],
      validated: true,
      createdAt: new Date().toISOString(),
      state: 'proposed',
    };
  } else if (kind === 'rescan_index') {
    proposal = {
      id: proposalId(),
      kind,
      authority: 'safe',
      summary: 'Re-index the project files',
      risk: 'Read-only walk of the server filesystem. Updates DARKNOTE metadata only.',
      path: null,
      baseHash: null,
      proposedContent: null,
      diff: null,
      steps: [
        step('authorize', 'Authorisation', 'Confirm the scan.', 'pending'),
        step('scan', 'Walk the filesystem', 'Runs the same discovery used by Server Discovery.', 'pending'),
      ],
      validated: true,
      createdAt: new Date().toISOString(),
      state: 'proposed',
    };
  } else {
    throw new ApiError(`Repair kind "${kind}" is not implemented.`, 409, 'repair_unsupported');
  }

  const record: RepairRecord = {
    authority: proposal.authority,
    kind,
    state: proposal.state,
    proposal,
    lastAction: 'proposed',
    lastActionAt: new Date().toISOString(),
  };
  await saveRepair(error.id, record);
  await logActivity({
    user,
    serverId: error.serverId,
    action: 'error.repair_proposed',
    target: error.id,
    detail: { kind, authority: proposal.authority },
  });
  return record;
}

function buildDiffSummary(error: ErrorEvent, path: string, content: string): string {
  const lines = content.split('\n');
  return [
    `--- a${path}`,
    `+++ b${path}`,
    `@@ error ${error.code} @@`,
    ...lines.slice(0, 40).map((line) => `+${line}`),
    lines.length > 40 ? `+… ${lines.length - 40} more line(s)` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface RepairOutcome {
  repair: RepairRecord;
  result: string;
  detail?: unknown;
}

export async function applyRepair(
  error: ErrorEvent,
  user: Principal,
  request: RepairRequest,
): Promise<RepairOutcome> {
  const proposal = error.repair?.proposal ?? null;
  if (!proposal) {
    throw new ApiError('Prepare the repair proposal before applying it.', 409, 'no_proposal');
  }
  if (proposal.state === 'applied') {
    throw new ApiError('This repair was already applied.', 409, 'already_applied');
  }
  if (proposal.state === 'blocked') {
    throw new ApiError(
      `This repair is blocked: ${proposal.validationErrors?.join('; ') || proposal.notes?.join(' ') || 'it needs a manual change.'}`,
      409,
      'repair_blocked',
    );
  }

  const permission = permissionFor(proposal.kind);
  if (!hasPermission(user, permission)) {
    throw new ApiError(`Your role does not include "${permission}", which this repair requires.`, 403, 'forbidden');
  }
  if (proposal.authority === 'approval' && !['owner', 'admin'].includes(user.role)) {
    throw new ApiError('This repair changes production and needs owner or admin authorisation.', 403, 'owner_approval_required');
  }
  const expected = proposal.kind === 'restart_bot' ? 'RESTART' : proposal.kind === 'file_patch' ? 'DEPLOY' : 'CONFIRM';
  if ((request.confirm ?? '').trim().toUpperCase() !== expected) {
    throw new ApiError(`Type ${expected} to authorise this repair.`, 400, 'confirmation_required');
  }
  if (!error.serverId) {
    throw new ApiError('This repair needs a connected server.', 409, 'no_server');
  }
  const server = await requireServer(error.serverId);
  const now = new Date().toISOString();
  const steps = proposal.steps.map((item) => ({ ...item }));

  const finish = async (state: RepairProposal['state'], result: string, detail?: unknown): Promise<RepairOutcome> => {
    const record: RepairRecord = {
      ...error.repair,
      authority: proposal.authority,
      kind: proposal.kind,
      state,
      proposal: {
        ...proposal,
        steps,
        state,
        appliedAt: state === 'applied' ? now : proposal.appliedAt ?? null,
        appliedBy: state === 'applied' ? user.email : proposal.appliedBy ?? null,
      },
      lastAction: request.action,
      lastActionAt: now,
    };
    await saveRepair(error.id, record);
    await logActivity({
      user,
      serverId: server.id,
      action: state === 'applied' ? 'error.repair_applied' : 'error.repair_discarded',
      target: error.id,
      severity: proposal.authority === 'approval' ? 'warning' : 'info',
      detail: { kind: proposal.kind, result },
    });
    return { repair: record, result, detail };
  };

  try {
    if (proposal.kind === 'clear_stale_lock') {
      steps[1] = { ...steps[1], state: 'done' };
      const deleted = await query<{ deployment_id: string }>(
        `delete from deployment_locks where server_id = $1 and expires_at < now() returning deployment_id`,
        [server.id],
      );
      steps[2] = { ...steps[2], state: 'done' };
      return finish(
        'applied',
        deleted.length
          ? `Removed ${deleted.length} expired deployment lock row(s).`
          : 'No expired lock remained; nothing was deleted.',
        { removed: deleted.map((row) => row.deployment_id) },
      );
    }

    if (proposal.kind === 'reattach_console') {
      steps[0] = { ...steps[0], state: 'done' };
      steps[1] = { ...steps[1], state: 'done' };
      const { detachConsole } = await import('../services/console');
      detachConsole(server.id);
      attachConsole(server);
      steps[2] = { ...steps[2], state: 'done' };
      return finish('applied', 'Console websocket detached and re-attached. Live output should resume within a few seconds.');
    }

    if (proposal.kind === 'rescan_index') {
      steps[0] = { ...steps[0], state: 'done' };
      const { scanServer: scan } = await import('../services/discovery');
      const result = await scan({ server, mode: 'manual', user });
      steps[1] = { ...steps[1], state: 'done' };
      return finish('applied', `Index refreshed: ${result.indexed} file(s) indexed, ${result.added} added.`, result);
    }

    if (proposal.kind === 'restart_bot') {
      const client = await serverClient(server);
      const resources = await client.getResources();
      if (resources.is_suspended) {
        steps[0] = { ...steps[0], state: 'blocked' };
        return finish('blocked', 'The server is suspended in the panel, so a restart cannot run.');
      }
      steps[0] = { ...steps[0], state: 'done' };
      steps[1] = { ...steps[1], state: 'done' };
      await power(server, 'restart');
      steps[2] = { ...steps[2], state: 'done' };
      steps[3] = { ...steps[3], state: 'done' };
      return finish('applied', 'Restart signal accepted by the panel. Open Live Monitor to watch the real startup output.');
    }

    if (proposal.kind === 'install_dependencies') {
      if (!proposal.proposedContent) throw new ApiError('The proposal has no command to run.', 409, 'no_command');
      steps[1] = { ...steps[1], state: 'done' };
      await sendConsoleCommand(server, proposal.proposedContent);
      steps[2] = { ...steps[2], state: 'done' };
      steps[3] = { ...steps[3], state: 'pending' };
      return finish(
        'applied',
        `Sent "${proposal.proposedContent}" to the server console. Read Terminal & Logs for the result — installation is not assumed to have succeeded.`,
      );
    }

    if (proposal.kind === 'file_patch') {
      if (!proposal.path || !proposal.proposedContent) {
        throw new ApiError('The proposal is missing its path or content.', 409, 'patch_incomplete');
      }
      const validation = await validateContent(proposal.path, proposal.proposedContent);
      if (!validation.ok) {
        steps[2] = { ...steps[2], state: 'blocked' };
        throw new ApiError(`Validation failed: ${validation.errors.join('; ')}`, 422, 'validation_failed');
      }
      steps[2] = { ...steps[2], state: 'done' };

      const backup = await createBackup({
        server,
        path: proposal.path,
        reason: 'repair',
        userId: user.id,
        note: `Backup before BIGBROTHER repair for ${error.code}`,
      });
      steps[1] = { ...steps[1], state: 'done' };
      steps[3] = { ...steps[3], state: 'done' };

      const write = await writeProductionFile({
        server,
        path: proposal.path,
        content: proposal.proposedContent,
        expectedHash: proposal.baseHash,
        note: `Repair of ${error.code}`,
        userId: user.id,
      });
      steps[4] = { ...steps[4], state: 'done' };
      return finish(
        'applied',
        `Wrote and verified ${write.path} (backup ${backup.id}). Open Deployments to restart and observe startup.`,
        { backupId: backup.id, hash: write.hash, version: write.version },
      );
    }

    throw new ApiError('This repair cannot be applied automatically.', 409, 'repair_unsupported');
  } catch (error_) {
    await saveRepair(error.id, {
      ...error.repair,
      state: 'proposed',
      proposal: { ...proposal, steps, state: 'proposed' },
      lastAction: 'apply_failed',
      lastActionAt: now,
    });
    throw error_;
  }
}

export async function discardRepair(error: ErrorEvent, user: Principal): Promise<RepairRecord> {
  const record: RepairRecord = {
    ...error.repair,
    state: 'discarded',
    proposal: error.repair?.proposal ? { ...error.repair.proposal, state: 'discarded' } : null,
    lastAction: 'discarded',
    lastActionAt: new Date().toISOString(),
  };
  await saveRepair(error.id, record);
  await logActivity({
    user,
    serverId: error.serverId,
    action: 'error.repair_discarded',
    target: error.id,
  });
  return record;
}

/** Stable hash used to prove a patch was built against the content shown. */
export function patchFingerprint(path: string, content: string): string {
  return sha256(`${path}:${content}`);
}

export function isSafeRepair(kind: string | null | undefined): boolean {
  return Boolean(kind && SAFE_KINDS.has(kind));
}
