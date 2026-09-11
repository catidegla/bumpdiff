import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import { readTarball, isText, extensionOf } from '../src/tar.mjs';
import { makeTarball } from './helpers.mjs';

test('a tarball reads back into the files that went in', () => {
  const entries = readTarball(makeTarball({
    'package.json': '{"name":"x"}',
    'index.js': 'export const a = 1;\n',
  }));

  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.name).sort(), ['index.js', 'package.json']);
  assert.equal(entries.find((e) => e.name === 'index.js').content.toString(), 'export const a = 1;\n');
});

test('npm\'s package/ wrapper is stripped, so paths read as they will once installed', () => {
  const [entry] = readTarball(makeTarball({ 'lib/deep/file.js': 'x' }));

  assert.equal(entry.name, 'lib/deep/file.js');
});

test('a file whose length is not a multiple of the block size still reads', () => {
  // The padding arithmetic is the easiest thing to get wrong here, and getting
  // it wrong shifts every subsequent entry by a few hundred bytes.
  for (const size of [1, 511, 512, 513, 1023, 1024]) {
    const body = 'a'.repeat(size);
    const [entry] = readTarball(makeTarball({ 'f.txt': body }));

    assert.equal(entry.content.length, size, `size ${size}`);
    assert.equal(entry.content.toString(), body, `size ${size}`);
  }
});

test('an empty file is an entry rather than a gap', () => {
  const entries = readTarball(makeTarball({ 'empty.js': '', 'after.js': 'kept' }));

  assert.equal(entries.length, 2);
  assert.equal(entries[0].content.length, 0);
  assert.equal(entries[1].content.toString(), 'kept');
});

test('a header that does not checksum is refused rather than read hopefully', async () => {
  // Continuing past a bad header means reporting on bytes that are not the
  // file we think they are, which is worse than refusing.
  const good = makeTarball({ 'a.js': 'x' });
  const raw = Buffer.from(good);

  // Corrupt a header byte after gunzip by rebuilding the archive around it.
  const { gunzipSync } = await import('node:zlib');
  const plain = gunzipSync(raw);
  plain[10] = plain[10] ^ 0xff;

  assert.throws(() => readTarball(gzipSync(plain)), /does not checksum/);
});

test('an entry claiming more bytes than the archive holds is refused', async () => {
  const { gunzipSync } = await import('node:zlib');
  const plain = gunzipSync(makeTarball({ 'a.js': 'x' }));

  // Rewrite the size field to something enormous and fix the checksum, which
  // is exactly what a crafted archive would do.
  plain.write((1 << 20).toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
  plain.write('        ', 148, 8, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += plain[i];
  plain.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');

  assert.throws(() => readTarball(gzipSync(plain)), /more bytes than the archive holds/);
});

test('an archive with too many entries is refused before it exhausts memory', () => {
  const many = {};
  for (let i = 0; i < 50; i++) many[`f${i}.js`] = 'x';

  assert.throws(() => readTarball(makeTarball(many), { maxEntries: 10 }), /more than 10 entries/);
});

test('an archive that unpacks larger than allowed is refused', () => {
  assert.throws(
    () => readTarball(makeTarball({ 'big.js': 'a'.repeat(5000) }), { maxTotalBytes: 1000 }),
    /more than the allowed size/,
  );
});

/* ---------------------------------------------------------------- helpers */

test('text detection agrees with what git calls binary', () => {
  assert.equal(isText(Buffer.from('plain text')), true);
  assert.equal(isText(Buffer.from([0x00, 0x01, 0x02])), false);
  assert.equal(isText(Buffer.from('')), true);
});

test('a NUL beyond the sniffed window does not make a file binary', () => {
  // Matching git's behaviour rather than scanning megabytes of every file.
  const content = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]);

  assert.equal(isText(content), true);
});

test('extensions come back lowercased and dotted', () => {
  assert.equal(extensionOf('a/b/c.JS'), '.js');
  assert.equal(extensionOf('Makefile'), '');
  assert.equal(extensionOf('archive.tar.gz'), '.gz');
});
