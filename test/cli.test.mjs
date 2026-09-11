import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'bumpdiff.mjs');

/**
 * Nothing here reaches the registry.
 *
 * A test suite for a tool that inspects packages must not depend on the
 * registry being up, and must not be able to change its answers because
 * somebody published something. The comparison itself is covered against
 * synthesised tarballs in compare.test.mjs.
 */
async function run(args, { input = null } = {}) {
  try {
    const child = exec(process.execPath, [CLI, ...args], { windowsHide: true });
    if (input !== null) {
      child.child.stdin.write(input);
      child.child.stdin.end();
    }
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('version and help answer without touching the network', async () => {
  assert.match((await run(['--version'])).stdout.trim(), /^\d+\.\d+\.\d+$/);

  const help = (await run([])).stdout;

  assert.match(help, /What a version bump changed/);
  assert.match(help, /changes, never verdicts/);
});

test('the help says out loud that nothing is downloaded or executed', async () => {
  // The claim that makes it safe to point at a package you do not trust, so
  // it belongs where somebody will read it before they run it.
  const help = (await run([])).stdout;

  assert.match(help, /Nothing is downloaded to disk and no install script is ever run/);
});

test('lockfile with no input explains itself rather than hanging', async () => {
  const result = await run(['lockfile'], { input: '' });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /reads a diff on stdin/);
});

test('a lockfile diff with no version changes says so', async () => {
  const diff = [
    'diff --git a/package-lock.json b/package-lock.json',
    '--- a/package-lock.json',
    '+++ b/package-lock.json',
    ' {',
    '   "name": "thing",',
    ' }',
  ].join('\n');

  const result = await run(['lockfile'], { input: diff });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /No version changes/);
});

/* ------------------------------------------------------- the diff parser */

test('a version bump is read out of an npm lockfile diff', async () => {
  const { parseLockfileDiff } = await import('../src/lockfile.mjs');

  // Exported for testing; if the import shape changes this test should fail
  // loudly rather than silently skip.
  assert.equal(typeof parseLockfileDiff, 'function');

  const diff = [
    '     "node_modules/chalk": {',
    '-      "version": "5.3.0",',
    '+      "version": "5.4.0",',
    '       "resolved": "https://registry.npmjs.org/chalk/-/chalk-5.4.0.tgz",',
  ].join('\n');

  assert.deepEqual(parseLockfileDiff(diff), [{ name: 'chalk', from: '5.3.0', to: '5.4.0' }]);
});

test('a scoped package survives the parser', async () => {
  const { parseLockfileDiff } = await import('../src/lockfile.mjs');

  const diff = [
    '     "node_modules/@scope/thing": {',
    '-      "version": "1.0.0",',
    '+      "version": "1.0.1",',
  ].join('\n');

  assert.deepEqual(parseLockfileDiff(diff), [{ name: '@scope/thing', from: '1.0.0', to: '1.0.1' }]);
});

test('an added package with no previous version is not a bump', async () => {
  const { parseLockfileDiff } = await import('../src/lockfile.mjs');

  const diff = [
    '     "node_modules/brand-new": {',
    '+      "version": "1.0.0",',
  ].join('\n');

  // A package appearing is a different question from one changing, and this
  // tool answers the second. Inventing a comparison would be worse than
  // saying nothing.
  assert.deepEqual(parseLockfileDiff(diff), []);
});

test('a version line that did not change is not a bump', async () => {
  const { parseLockfileDiff } = await import('../src/lockfile.mjs');

  const diff = [
    '     "node_modules/steady": {',
    '       "version": "1.0.0",',
    '-      "resolved": "a",',
    '+      "resolved": "b",',
  ].join('\n');

  assert.deepEqual(parseLockfileDiff(diff), []);
});

test('several packages in one diff all come back', async () => {
  const { parseLockfileDiff } = await import('../src/lockfile.mjs');

  const diff = [
    '     "node_modules/one": {',
    '-      "version": "1.0.0",',
    '+      "version": "1.0.1",',
    '     "node_modules/two": {',
    '-      "version": "2.0.0",',
    '+      "version": "3.0.0",',
  ].join('\n');

  assert.deepEqual(parseLockfileDiff(diff).map((b) => b.name), ['one', 'two']);
});
