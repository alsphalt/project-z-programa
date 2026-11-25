/**
 * Rules that keep the code editor honest.
 *
 * These are the checks that stand between "the surface looks blank" and "an empty
 * buffer was written over BIGBRO.js". They are pure functions so they can be
 * asserted without a browser — which is exactly where the original bug lived.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkLoadedContent,
  checkWrite,
  isCodeLanguage,
} from '../src/lib/editor/guards.ts';

const BIGBRO_BYTES = 391 * 1024;

test('a fully loaded file passes the content check', () => {
  const source = 'const a = 1;\n'.repeat(1000);
  const verdict = checkLoadedContent({
    path: '/BIGBRO.js',
    content: source,
    totalChars: source.length,
    sizeBytes: BIGBRO_BYTES,
  });
  assert.equal(verdict.ok, true);
});

test('an empty body for a non-empty file is refused instead of shown blank', () => {
  const verdict = checkLoadedContent({
    path: '/BIGBRO.js',
    content: '',
    totalChars: 0,
    sizeBytes: BIGBRO_BYTES,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok === false ? verdict.reason : '', /empty body/i);
});

test('a truncated read is refused', () => {
  const verdict = checkLoadedContent({
    path: '/BIGBRO.js',
    content: 'const a = 1;',
    totalChars: 400_000,
    sizeBytes: BIGBRO_BYTES,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok === false ? verdict.reason : '', /received 12 of 400,000/);
});

test('a genuinely empty production file opens as empty', () => {
  const verdict = checkLoadedContent({
    path: '/empty.js',
    content: '',
    totalChars: 0,
    sizeBytes: 0,
  });
  assert.equal(verdict.ok, true);
});

test('an empty editor cannot be saved over a file with bytes', () => {
  const verdict = checkWrite({ productionBytes: BIGBRO_BYTES, content: '' });
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok === false ? verdict.reason : '', /391 KB/);
});

test('a whitespace-only buffer is refused too', () => {
  const verdict = checkWrite({ productionBytes: BIGBRO_BYTES, content: '\n\n   \n' });
  assert.equal(verdict.ok, false);
});

test('a real edit is allowed', () => {
  const verdict = checkWrite({
    productionBytes: BIGBRO_BYTES,
    content: '#!/usr/bin/env node\nconsole.log("hi");\n',
  });
  assert.equal(verdict.ok, true);
});

test('an intentionally created empty file may be saved', () => {
  const verdict = checkWrite({ productionBytes: 0, content: '' });
  assert.equal(verdict.ok, true);
});

test('code languages are classified apart from prose', () => {
  assert.equal(isCodeLanguage('javascript'), true);
  assert.equal(isCodeLanguage('json'), true);
  assert.equal(isCodeLanguage('plaintext'), false);
});

test('the editor is bound to the Editor component, never the module namespace', () => {
  // `dynamic(() => import("@monaco-editor/react"))` hands React the module
  // object, which is not a component: the header renders, the surface does not.
  // This is the exact shape that produced the blank editor.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, '..', 'src', 'components', 'code-editor.tsx'), 'utf8');
  assert.match(
    source,
    /import\(\s*["']@monaco-editor\/react["']\s*\)\.then\(\s*\(mod\)\s*=>\s*mod\.Editor\s*\)/,
    'the dynamic import must select the named Editor component',
  );
  assert.doesNotMatch(
    source,
    /dynamic\(\s*\(\s*\)\s*=>\s*import\(\s*["']@monaco-editor\/react["']\s*\)\s*,/,
    'importing the module namespace as a component yields an invalid element type',
  );
});
