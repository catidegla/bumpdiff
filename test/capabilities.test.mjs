import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyse, analyseFile, analyseManifest, classify } from '../src/capabilities.mjs';
import { readTarball } from '../src/tar.mjs';
import { makePackage } from './helpers.mjs';

const file = (name, body) => analyseFile(name, Buffer.from(body));
const ids = (result) => result.capabilities.map((c) => c.id).sort();

/* ------------------------------------------------------------ classification */

test('prose is prose whatever URLs it contains', () => {
  // The bug the first live run found: three of four findings on a real
  // package were badge URLs in a readme.
  assert.equal(classify('README.md'), 'documentation');
  assert.equal(classify('LICENSE'), 'documentation');
  assert.equal(classify('docs/guide.markdown'), 'documentation');
  assert.equal(classify('CHANGELOG'), 'documentation');
});

test('things that can run are code', () => {
  for (const name of ['index.js', 'a.mjs', 'b.cjs', 'c.ts', 'd.tsx', 'install.sh', 'setup.py', 'binding.gyp']) {
    assert.equal(classify(name), 'code', name);
  }
});

test('an extensionless file in bin is treated as a script', () => {
  assert.equal(classify('bin/cli'), 'code');
  assert.equal(classify('cli'), 'other');
});

test('compiled artefacts are binary', () => {
  for (const name of ['native.node', 'lib.so', 'thing.wasm', 'a.dylib']) {
    assert.equal(classify(name), 'binary', name);
  }
});

test('a host in a readme produces no finding at all', () => {
  const doc = file('README.md', '[![badge](https://coveralls.io/x.svg)](https://strapi.io)');

  assert.deepEqual(doc.hosts, []);
  assert.deepEqual(doc.capabilities, []);
});

test('the same host in code does produce one', () => {
  const code = file('index.js', 'fetch("https://collect.example.net/beacon")');

  assert.deepEqual(code.hosts, ['collect.example.net']);
});

/* -------------------------------------------------------------- capabilities */

test('running other programs is caught in both module spellings', () => {
  assert.deepEqual(ids(file('a.js', "const cp = require('child_process')")), ['process.spawn']);
  assert.deepEqual(ids(file('a.js', "import { spawn } from 'node:child_process'")), ['process.spawn']);
});

test('network, filesystem and evaluation are each their own capability', () => {
  assert.ok(ids(file('a.js', "require('net')")).includes('net.socket'));
  assert.ok(ids(file('a.js', 'writeFileSync(p, d)')).includes('fs.write'));
  assert.ok(ids(file('a.js', 'eval(payload)')).includes('code.eval'));
  assert.ok(ids(file('a.js', 'new Function("return 1")()')).includes('code.eval'));
});

test('a require with a computed name is separated from an ordinary one', () => {
  // A literal require is how every package works. A computed one hides what
  // is loaded from everybody reading the source, including this tool.
  assert.ok(!ids(file('a.js', "require('fs')")).includes('code.dynamicRequire'));
  assert.ok(ids(file('a.js', 'require(name)')).includes('code.dynamicRequire'));
  assert.ok(ids(file('a.js', 'require(a + b)')).includes('code.dynamicRequire'));
});

test('each capability is reported once however many times it appears', () => {
  const many = file('a.js', "require('net');require('net');require('net')");

  assert.equal(many.capabilities.filter((c) => c.id === 'net.socket').length, 1);
});

test('a bare mention in prose is not a capability', () => {
  // "child_process" written in a sentence matches nothing. The patterns want
  // the shape of an import, which is most of what keeps this readable.
  const mentioned = file('a.js', '// this module deliberately avoids child_process entirely\n');

  assert.deepEqual(mentioned.capabilities, []);
});

test('the line it was seen on comes back, so a false positive is obvious at a glance', () => {
  // A commented out import does match, because the pattern is lexical. The
  // evidence line is what lets a reader dismiss it in one second rather than
  // opening the package to find out.
  const seen = file('a.js', "const x = 1;\n// const cp = require('child_process'); // removed in v2\nconst y = 2;");

  assert.equal(seen.capabilities.length, 1);
  assert.match(seen.capabilities[0].evidence, /removed in v2/);
});

test('self referential and boilerplate hosts are not findings', () => {
  const code = file('a.js', '// see https://github.com/a/b and https://img.shields.io/x\nfetch("https://api.real.example")');

  assert.deepEqual(code.hosts, ['api.real.example']);
});

/* ------------------------------------------------------------------ manifest */

test('only the lifecycle scripts that actually run are collected', () => {
  const manifest = analyseManifest({
    name: 'x',
    scripts: { test: 'jest', postinstall: 'node build.js', build: 'tsc' },
  });

  assert.deepEqual(manifest.lifecycle.map((s) => s.name), ['postinstall']);
  assert.equal(manifest.lifecycle[0].command, 'node build.js');
});

test('an empty lifecycle script is not a lifecycle script', () => {
  assert.deepEqual(analyseManifest({ scripts: { postinstall: '   ' } }).lifecycle, []);
});

test('a string bin is normalised to the object form', () => {
  assert.deepEqual(analyseManifest({ name: 'tool', bin: './cli.js' }).bin, { tool: './cli.js' });
});

test('a repository given as a string or an object both read', () => {
  assert.equal(analyseManifest({ repository: 'https://a/b' }).repository, 'https://a/b');
  assert.equal(analyseManifest({ repository: { url: 'https://a/b' } }).repository, 'https://a/b');
});

/* --------------------------------------------------------------- whole package */

test('a package rolls up to its capabilities, hosts and totals', () => {
  const entries = readTarball(makePackage(
    { name: 'x', version: '1.0.0', scripts: { postinstall: 'node x.js' } },
    {
      'index.js': "const cp = require('child_process');\nfetch('https://drop.example.org/x');",
      'README.md': 'see https://coveralls.io/badge',
    },
  ));

  const result = analyse(entries);

  assert.equal(result.manifest.name, 'x');
  assert.deepEqual(result.manifest.lifecycle.map((s) => s.name), ['postinstall']);
  assert.ok(result.capabilities.some((c) => c.id === 'process.spawn'));
  assert.deepEqual(result.hosts.map((h) => h.host), ['drop.example.org']);
  assert.equal(result.totals.files, 3);
  assert.equal(result.totals.code, 2);
});

test('a package with an unreadable manifest still analyses its files', async () => {
  // A broken package.json is a reason to look harder, not to give up, and a
  // hostile package would be delighted to find a scanner that stops there.
  const { makeTarball } = await import('./helpers.mjs');
  const entries = readTarball(makeTarball({
    'package.json': '{ this is not json',
    'a.js': "require('net')",
  }));

  const result = analyse(entries);

  assert.equal(result.manifest.name, null);
  assert.ok(result.capabilities.some((c) => c.id === 'net.socket'));
});
