/**
 * Introduction-on-launch contract.
 *
 * The installed app must replay the introduction every time it is opened,
 * which means the decision cannot depend on `introSeen`. These assertions lock
 * the two pure helpers that decision is built from, plus the pre-hydration boot
 * shield that keeps the console from painting ahead of the intro.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_APPEARANCE,
  isStandaloneLaunch,
  storedMode,
} from '../src/components/christmas/prefs.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

const provider = read('src/components/christmas/provider.tsx');
const css = read('src/app/globals.css');
const settingsPage = read('src/app/(app)/settings/page.tsx');
const platformPanels = read('src/components/settings/platform-panels.tsx');

/** Minimal window stand-in: only the members the helper touches. */
function withWindow(
  value: { displayModes?: string[]; standalone?: boolean },
  run: () => void,
) {
  const modes = new Set(value.displayModes ?? []);
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    matchMedia: (query: string) => ({
      matches: Array.from(modes).some((mode) => query.includes(`display-mode: ${mode}`)),
    }),
    navigator: { standalone: value.standalone },
  };
  try {
    run();
  } finally {
    (globalThis as { window?: unknown }).window = previous;
  }
}

test('an installed app is recognised in every standalone display mode', () => {
  for (const mode of ['standalone', 'window-controls-overlay', 'fullscreen']) {
    withWindow({ displayModes: [mode] }, () => {
      assert.equal(isStandaloneLaunch(), true, `display-mode: ${mode} must count as installed`);
    });
  }
});

test('a browser tab and iOS home-screen flag are told apart', () => {
  withWindow({}, () => assert.equal(isStandaloneLaunch(), false));
  withWindow({ standalone: true }, () => assert.equal(isStandaloneLaunch(), true));
});

test('the device mode wins over the server default, and defaults when absent', () => {
  assert.equal(storedMode({ mode: 'off' }, DEFAULT_APPEARANCE), 'off');
  assert.equal(storedMode({}, DEFAULT_APPEARANCE), 'on');
  assert.equal(storedMode({ mode: 'garbage' }, DEFAULT_APPEARANCE), 'on');
});

test('the introduction is unconditional: no introSeen, mode or device check can suppress it', () => {
  // The product requirement is that the intro is permanent. The provider must
  // therefore show it from a mount effect with an empty dependency list, and
  // must not consult any stored preference to decide otherwise.
  // Comments may explain the removed options; only executable code is checked.
  const code = provider.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.match(code, /useEffect\(\(\) => \{\s*setIntroOpen\(true\);\s*\}, \[\]\)/);
  assert.ok(!code.includes('introSeen'), 'the provider must not read introSeen any more');
  assert.ok(!/prefs\.intro\b/.test(code), 'the provider must not gate the intro on a boolean preference');
  assert.ok(!code.includes('storedMode('), 'the provider must not consult the stored device mode');
  assert.ok(!code.includes('isStandaloneLaunch('), 'the intro must not depend on how the app was launched');
});

test('the intro keeps its branding, its motion preference and the snow layer', () => {
  assert.match(provider, /DARKNOTE/);
  assert.match(provider, /POWERED BY JIMMY M, TECH/);
  // Reduced motion neutralises the animation instead of removing the intro.
  assert.match(provider, /prefersReducedMotion\(\)/);
  assert.match(provider, /data-motion/);
  assert.match(provider, /<SnowLayer \/>/);
});

test('the boot shield exists in SSR markup and is scoped to installed apps', () => {
  assert.match(provider, /className="xmas-boot"/);
  assert.match(css, /\.xmas-boot\s*\{[^}]*display:\s*none/);
  assert.match(css, /@media[^{]*display-mode:\s*standalone[^{]*\{[\s\S]*?\.xmas-boot/);
  assert.match(css, /html\[data-xmas-boot="done"\]\s+\.xmas-boot\s*\{[^}]*display:\s*none/);
});

test('the appearance settings section is gone, and no switch can disable the intro', () => {
  assert.ok(!settingsPage.includes('AppearanceSettingsPanel'), 'Admin Settings must not render the appearance panel');
  assert.ok(!settingsPage.includes('"appearance"'), 'Admin Settings must not offer an appearance tab');
  assert.ok(!platformPanels.includes('AppearanceSettingsPanel'), 'the appearance panel component must be removed');
  assert.ok(!platformPanels.includes('replayIntro'), 'no replay/disable control may remain');
  // The branding and the animation are still part of the product.
  assert.match(css, /\.xmas-intro\b/);
  assert.match(css, /\.xmas-brand\b/);
});
