/**
 * Copy Monaco's AMD distribution into `public/monaco/vs` so the editor loads from
 * this app instead of a CDN.
 *
 * Why: the editor used to load `https://cdn.jsdelivr.net/npm/monaco-editor/...`.
 * On a phone (or any network that blocks that host) the loader script never
 * arrives, `loader.init()` never resolves, and the editor area stays blank while
 * the rest of the page renders normally — exactly the reported symptom. Serving
 * the same files from our own origin removes that dependency and keeps versions
 * pinned to package.json.
 *
 * Runs on postinstall/predev/prebuild. Never fails the install: if the package is
 * missing, the app falls back to the CDN (see src/lib/editor/monaco.ts).
 */
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const require = createRequire(import.meta.url);

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const packageJsonPath = require.resolve('monaco-editor/package.json');
  const { version } = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const source = path.join(path.dirname(packageJsonPath), 'min', 'vs');
  const target = path.join(projectRoot, 'public', 'monaco', 'vs');
  const marker = path.join(target, 'darknote-version.txt');

  if (!(await exists(source))) {
    console.warn('[monaco] monaco-editor is not installed; the editor will use the CDN fallback.');
    return;
  }

  if (await exists(marker)) {
    const stamped = (await readFile(marker, 'utf8')).trim();
    if (stamped === version && (await exists(path.join(target, 'editor', 'editor.main.js')))) {
      console.log(`[monaco] public/monaco/vs is already ${version}`);
      return;
    }
  }

  await mkdir(path.dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
  await writeFile(marker, `${version}\n`, 'utf8');
  console.log(`[monaco] copied monaco-editor ${version} → public/monaco/vs`);
}

main().catch((error) => {
  // A failed copy must not break install/build; the CDN fallback still works.
  console.warn(`[monaco] copy skipped: ${error instanceof Error ? error.message : String(error)}`);
});
