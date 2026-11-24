/**
 * PWA contract tests.
 *
 * Installability is a set of boring, easily-broken invariants: a manifest that
 * is valid JSON served from the document, 192px and 512px icons that actually
 * exist at those sizes, a maskable icon, a service worker served from the root
 * so its scope can cover the app, and an offline fallback that is precached.
 *
 * These assertions are deliberately file-level: they catch a renamed icon or a
 * dropped header without needing a browser.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

const manifest = JSON.parse(read('public/manifest.webmanifest')) as {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
};

const sw = read('public/sw.js');
const layout = read('src/app/layout.tsx');
const nextConfig = read('next.config.ts');

/** Width/height straight out of the PNG IHDR chunk. */
function pngSize(relative: string) {
  const buffer = readFileSync(path.join(root, relative));
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG', `${relative} is not a PNG`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('the manifest describes a standalone app scoped to the origin root', () => {
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.ok(manifest.name.length > 0);
  assert.ok(manifest.short_name.length <= 12, 'short_name should fit under a launcher icon');
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
});

test('the document links the manifest and declares a mobile web app', () => {
  assert.match(layout, /manifest:\s*"\/manifest\.webmanifest"/);
  assert.match(layout, /appleWebApp:/);
  assert.match(layout, /capable:\s*true/);
});

test('every declared icon exists and is rendered at the size it claims', () => {
  for (const icon of manifest.icons) {
    const relative = path.join('public', icon.src.replace(/^\//, ''));
    assert.ok(existsSync(path.join(root, relative)), `${icon.src} is missing`);
    assert.equal(icon.type, 'image/png');
    const [width, height] = icon.sizes.split('x').map(Number);
    assert.deepEqual(pngSize(relative), { width, height }, `${icon.src} has the wrong dimensions`);
  }
});

test('the icon set covers the 192, 512 and maskable requirements', () => {
  const sizes = manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose ?? 'any'}`);
  assert.ok(sizes.includes('192x192:any'));
  assert.ok(sizes.includes('512x512:any'));
  assert.ok(sizes.includes('512x512:maskable'));
  assert.ok(existsSync(path.join(root, 'src/app/icon.png')), 'app icon convention file is missing');
  assert.ok(existsSync(path.join(root, 'src/app/apple-icon.png')), 'apple-icon convention file is missing');
});

test('the worker is served from the root scope and revalidated', () => {
  assert.ok(existsSync(path.join(root, 'public/sw.js')));
  assert.match(nextConfig, /source:\s*"\/sw\.js"/);
  assert.match(nextConfig, /Service-Worker-Allowed/);
  assert.match(nextConfig, /must-revalidate/);
});

test('the worker never caches API traffic or HTML navigations', () => {
  assert.match(sw, /url\.pathname\.startsWith\("\/api\/"\)\)\s*return/);
  // Navigations are network-first: the offline page is the only cached HTML.
  assert.match(sw, /request\.mode === "navigate"/);
  const navigationHandler = sw.slice(
    sw.indexOf('async function networkFirstNavigation'),
    sw.indexOf('self.addEventListener("fetch"'),
  );
  assert.ok(navigationHandler.length > 0, 'networkFirstNavigation is missing');
  assert.ok(!navigationHandler.includes('cache.put'), 'navigations must never be written to a cache');
  assert.match(sw, /const OFFLINE_URL = "\/offline"/);
  assert.match(sw, /PRECACHE = \[\s*OFFLINE_URL/);
});

test('there is an offline route that does not require a session', () => {
  const offlinePage = 'src/app/offline/page.tsx';
  assert.ok(existsSync(path.join(root, offlinePage)));
  const source = read(offlinePage);
  assert.ok(!source.includes('currentUser'), 'the offline page must render without auth');
});
