import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockPanel } from './mock-pterodactyl.mjs';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'dbg-'));
process.env.DARKNOTE_DATA_DIR = dataDir;
process.env.DARKNOTE_DB_DRIVER = 'pglite';
process.env.DARKNOTE_SECRET = 'explorer-secret-value-that-is-long-enough-for-aes';
process.env.NODE_ENV = 'test';

const panel = await createMockPanel({ identifier: 'dbg', apiKey: 'ptlc_dbg_key_long_enough_here', seed: {} }).start();
const { createServer, getServer } = await import('../src/lib/servers/repo.ts');
const { query } = await import('../src/lib/db.ts');
const { scanServer } = await import('../src/lib/services/discovery.ts');
const cls = await import('../src/lib/explorer/classify.ts');

await query(`insert into admin_users (id,email,name,password_hash,role) values ('u1','a@b.c','A','x','owner') on conflict do nothing`);
const server = await createServer({ name:'d', panelUrl: panel.baseUrl, serverIdentifier: panel.identifier, apiKey: panel.apiKey, projectRoot:'/', startupTimeoutS:2, syncIntervalS:300 }, { id:'u1', email:'a@b.c', name:'A', role:'owner', permissions:[] });
await scanServer({ server: await getServer(server.id), user: { id:'u1' }, mode:'manual', deep:true });

for (const p of ['/database', '/database/owner.json', '/auth', '/plugins', '/app']) {
  const rows = await query('select path, is_directory, is_secret from file_indexes where server_id=$1 and path=$2 and deleted_at is null', [server.id, p]);
  console.log(p, JSON.stringify(rows), 'reason=', cls.deletionBlockReason(p, Boolean(rows[0]?.is_directory)));
}
const dirs = await query('select path, is_directory from file_indexes where server_id=$1 and is_directory = true order by path limit 12', [server.id]);
console.log('indexed dirs:', dirs.map(d=>d.path).join(', '));
await panel.stop();
process.exit(0);
