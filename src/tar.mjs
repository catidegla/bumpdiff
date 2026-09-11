/**
 * Reading an npm tarball without unpacking it to disk.
 *
 * Written by hand rather than pulled from a dependency, and the reason is not
 * ideology. This tool exists to inspect packages you have not decided to trust
 * yet, so the last thing it should do is install a dependency tree of its own
 * to do the inspecting. A supply chain inspector with a supply chain is an
 * argument in a circle.
 *
 * Nothing is ever written to disk and no install script is ever executed. The
 * bytes are unzipped in memory, the entries are read, and that is the whole
 * interaction with a package that might be hostile.
 */

import { gunzipSync } from 'node:zlib';

const BLOCK = 512;

/** Trailing NULs and spaces, which tar pads every field with. */
const str = (buf) => {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString('utf8').trim();
};

/**
 * tar stores numbers as octal text, except when it cannot.
 *
 * GNU sets the high bit of the first byte and stores a big-endian binary
 * value instead, which is how sizes above 8GB are expressed. No npm package
 * should reach that, but a hostile one could set the bit deliberately to make
 * a naive parser read the size as NaN and walk off into the data.
 */
function readNumber(buf) {
  if (buf.length === 0) return 0;

  if (buf[0] & 0x80) {
    let value = BigInt(buf[0] & 0x7f);
    for (let i = 1; i < buf.length; i++) value = (value << 8n) | BigInt(buf[i]);
    return Number(value);
  }

  const text = str(buf);
  if (text === '') return 0;

  const parsed = parseInt(text, 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The checksum field, which is the only integrity the format offers.
 *
 * Computed over the header with the checksum field itself treated as spaces.
 * Verified because a header that does not add up is a header we are reading
 * wrongly, and continuing from there means reporting on bytes that are not
 * the file we think they are.
 */
function checksumMatches(header) {
  const stored = readNumber(header.subarray(148, 156));

  let signed = 0;
  let unsigned = 0;

  for (let i = 0; i < BLOCK; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : header[i];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }

  // Some historic writers signed the bytes. Accepting either is what every
  // real tar reader does.
  return stored === unsigned || stored === signed;
}

/**
 * Read a gzipped tar into entries.
 *
 * @param {Buffer} gzipped
 * @param {object} options
 * @param {number} options.maxEntries   refuse an archive with more files than this
 * @param {number} options.maxTotalBytes refuse one that unpacks larger than this
 * @returns {Array<{name: string, size: number, type: string, content: Buffer}>}
 */
export function readTarball(gzipped, { maxEntries = 20000, maxTotalBytes = 512 * 1024 * 1024 } = {}) {
  const buf = gunzipSync(gzipped);
  const entries = [];

  let offset = 0;
  let total = 0;
  let longName = null;
  let paxName = null;

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);

    // Two consecutive zero blocks end the archive. One is enough to stop on.
    if (header.every((b) => b === 0)) break;

    if (!checksumMatches(header)) {
      throw new Error(`the tar header at byte ${offset} does not checksum, so this archive is not readable`);
    }

    const size = readNumber(header.subarray(124, 136));
    const type = String.fromCharCode(header[156]) || '0';
    const prefix = str(header.subarray(345, 500));
    const rawName = str(header.subarray(0, 100));

    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;

    if (dataEnd > buf.length) {
      throw new Error('an entry claims more bytes than the archive holds');
    }

    const data = buf.subarray(dataStart, dataEnd);

    // GNU long name, and the pax equivalent. Both store the real name in the
    // body of a pseudo entry that precedes the file it names.
    if (type === 'L') {
      longName = str(data);
    } else if (type === 'x' || type === 'X') {
      paxName = readPaxPath(data);
    } else {
      const name = longName ?? paxName ?? (prefix ? `${prefix}/${rawName}` : rawName);
      longName = null;
      paxName = null;

      if (type === '0' || type === '\0' || type === '7') {
        total += size;

        if (entries.length >= maxEntries) throw new Error(`archive holds more than ${maxEntries} entries`);
        if (total > maxTotalBytes) throw new Error('archive unpacks to more than the allowed size');

        entries.push({
          // npm wraps everything in package/. Stripped so paths read the way
          // they will once installed.
          name: name.replace(/^package\//, ''),
          size,
          type: 'file',
          content: Buffer.from(data),
        });
      }
    }

    offset = dataEnd + (size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK));
  }

  return entries;
}

/** pax headers are "<len> key=value\n" records; only the path matters here. */
function readPaxPath(data) {
  const text = data.toString('utf8');
  const match = /(?:^|\n)\d+ path=([^\n]+)/.exec(text);
  return match ? match[1] : null;
}

/**
 * Whether an entry is text worth reading for capabilities.
 *
 * A NUL byte in the first stretch is the same test `git diff` uses, and it is
 * right for the same reason: anything carrying one is not source we can read
 * usefully, and trying costs memory on files that are frequently enormous.
 */
export function isText(content) {
  const window = content.subarray(0, Math.min(content.length, 8000));
  return !window.includes(0);
}

export const BINARY_EXTENSIONS = new Set([
  '.node', '.exe', '.dll', '.so', '.dylib', '.wasm', '.bin', '.a', '.o', '.dSYM',
]);

export function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}
