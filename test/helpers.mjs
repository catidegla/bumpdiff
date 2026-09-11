import { gzipSync } from 'node:zlib';

const BLOCK = 512;

/**
 * Write a tar the way npm writes one, so the parser is tested against the
 * format rather than against a fixture somebody generated with the parser.
 *
 * Everything here runs offline. A test suite for a tool that inspects packages
 * before you trust them must not need the registry to be up, and must not be
 * able to change its answers because somebody published something.
 */
export function makeTarball(files, { prefix = 'package/' } = {}) {
  const blocks = [];

  for (const [name, body] of Object.entries(files)) {
    const content = Buffer.from(body, 'utf8');
    const header = Buffer.alloc(BLOCK);

    header.write(prefix + name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'utf8');           // mode
    header.write('0000000\0', 108, 8, 'utf8');           // uid
    header.write('0000000\0', 116, 8, 'utf8');           // gid
    header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
    header.write('00000000000\0', 136, 12, 'utf8');      // mtime
    header.write('        ', 148, 8, 'utf8');            // checksum placeholder
    header.write('0', 156, 1, 'utf8');                   // typeflag: regular file
    header.write('ustar\0', 257, 6, 'utf8');
    header.write('00', 263, 2, 'utf8');

    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += header[i];
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');

    blocks.push(header);
    blocks.push(content);

    const padding = content.length % BLOCK;
    if (padding !== 0) blocks.push(Buffer.alloc(BLOCK - padding));
  }

  // Two zero blocks end an archive.
  blocks.push(Buffer.alloc(BLOCK * 2));

  return gzipSync(Buffer.concat(blocks));
}

/** A package with a manifest and whatever files the test needs. */
export function makePackage(manifest, files = {}) {
  return makeTarball({ 'package.json': JSON.stringify(manifest, null, 2), ...files });
}

/** The shape releaseFacts returns, for tests that do not need a registry. */
export function facts(overrides = {}) {
  return {
    version: '1.0.0',
    publishedAt: '2026-01-01T00:00:00.000Z',
    publisher: 'someone',
    shasum: null,
    integrity: null,
    unpackedSize: 1000,
    fileCount: 3,
    hasProvenance: false,
    deprecated: null,
    tarball: null,
    ...overrides,
  };
}
