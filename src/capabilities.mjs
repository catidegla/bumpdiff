/**
 * What a package can do, read off its files.
 *
 * The honest description of this module is that it is lexical. It looks for
 * the shapes that reach outside the process, and it will see one inside a
 * comment or a string as readily as in live code. A parser would be more
 * precise and would also mean shipping one, which for a tool whose whole job
 * is to inspect packages before you trust them is the wrong trade.
 *
 * The imprecision costs far less than it would in a scanner, because nothing
 * here produces a verdict. It produces a delta. "This version reaches for
 * child_process and the last one did not" is worth a human's thirty seconds
 * whether the match is real or a comment, and if it is a comment they will see
 * that immediately in the evidence line printed underneath.
 *
 * What it never does is call anything malicious. That word requires knowing
 * intent, and a tool that guesses at intent is the tool people stop reading.
 */

import { isText, extensionOf, BINARY_EXTENSIONS } from './tar.mjs';

/**
 * Reaching outside the process, ranked by how much it matters in a diff.
 *
 * Each entry names the capability rather than the module, because
 * `require('child_process')` and `import { spawn } from 'node:child_process'`
 * are the same fact about a package and should not be two findings.
 */
const CAPABILITIES = [
  {
    id: 'process.spawn',
    label: 'runs other programs',
    patterns: [/\bnode:child_process\b/, /require\(\s*['"]child_process['"]\s*\)/, /from\s+['"](?:node:)?child_process['"]/],
  },
  {
    id: 'net.socket',
    label: 'opens raw sockets',
    patterns: [/\bnode:(?:net|dgram|tls)\b/, /require\(\s*['"](?:net|dgram|tls)['"]\s*\)/, /from\s+['"](?:node:)?(?:net|dgram|tls)['"]/],
  },
  {
    id: 'net.http',
    label: 'makes HTTP requests',
    patterns: [/\bnode:(?:http|https)\b/, /require\(\s*['"](?:http|https)['"]\s*\)/, /from\s+['"](?:node:)?(?:https?)['"]/, /\bfetch\s*\(/, /\bXMLHttpRequest\b/],
  },
  {
    id: 'fs.write',
    label: 'writes to the filesystem',
    patterns: [/\bwriteFileSync?\b/, /\bcreateWriteStream\b/, /\bappendFileSync?\b/, /\brmSync?\b/, /\bunlinkSync?\b/, /\bmkdirSync?\b/, /\bchmodSync?\b/],
  },
  {
    id: 'fs.read',
    label: 'reads the filesystem',
    patterns: [/\bnode:fs\b/, /require\(\s*['"]fs['"]\s*\)/, /from\s+['"](?:node:)?fs['"]/, /\breadFileSync?\b/],
  },
  {
    id: 'code.eval',
    label: 'evaluates code at runtime',
    patterns: [/\beval\s*\(/, /new\s+Function\s*\(/, /\bnode:vm\b/, /require\(\s*['"]vm['"]\s*\)/, /\bvm\.runIn/],
  },
  {
    id: 'code.dynamicRequire',
    label: 'requires a name computed at runtime',
    // A literal require is ordinary. A computed one hides what is loaded from
    // anyone reading the source, including this tool.
    patterns: [/require\s*\(\s*(?!['"`])/, /\bimport\s*\(\s*(?!['"`])/],
  },
  {
    id: 'env.read',
    label: 'reads environment variables',
    patterns: [/\bprocess\.env\b/],
  },
  {
    id: 'os.info',
    label: 'reads machine and user details',
    patterns: [/\bnode:os\b/, /require\(\s*['"]os['"]\s*\)/, /\bos\.(?:homedir|hostname|userInfo|networkInterfaces)\b/],
  },
  {
    id: 'process.exit',
    label: 'ends the host process',
    patterns: [/\bprocess\.exit\s*\(/, /\bprocess\.kill\s*\(/],
  },
  {
    id: 'worker.thread',
    label: 'starts worker threads',
    patterns: [/\bnode:worker_threads\b/, /require\(\s*['"]worker_threads['"]\s*\)/, /\bnode:cluster\b/],
  },
  {
    id: 'crypto.use',
    label: 'uses cryptography',
    patterns: [/\bnode:crypto\b/, /require\(\s*['"]crypto['"]\s*\)/, /\bcreateCipheriv\b/, /\bcreateDecipheriv\b/],
  },
  {
    id: 'encoding.base64',
    label: 'decodes base64 blobs',
    patterns: [/Buffer\.from\s*\([^,)]+,\s*['"]base64['"]/, /\batob\s*\(/],
  },
];

/** Hosts a package talks to, as they appear in its source. */
const HOST = /\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?:[:/?#]|\b)/gi;

/**
 * Hosts that carry no signal in a diff.
 *
 * A package gaining a link to its own repository or a licence is not a
 * capability change, and leaving them in buries the one host that matters
 * under twenty that do not.
 */
const UNREMARKABLE_HOSTS = new Set([
  'github.com', 'www.github.com', 'raw.githubusercontent.com', 'gist.github.com',
  'npmjs.com', 'www.npmjs.com', 'registry.npmjs.org', 'nodejs.org',
  'opensource.org', 'www.opensource.org', 'spdx.org', 'unlicense.org',
  'developer.mozilla.org', 'tc39.es', 'www.w3.org', 'schema.org',
  'travis-ci.org', 'coveralls.io', 'badge.fury.io', 'img.shields.io', 'shields.io',
  'example.com', 'www.example.com', 'localhost',
]);

/** A line long enough that nobody wrote it by hand. */
const MINIFIED_LINE = 2000;

/**
 * Extensions that can run, which is the only place a capability means anything.
 *
 * The first live run of this tool reported four findings on a chalk upgrade
 * and three of them were badge URLs in the readme. That is the failure mode
 * that gets a tool uninstalled in a week: a reader who has been wrong-footed
 * three times stops reading the fourth line, which is the one that mattered.
 *
 * Documentation cannot open a socket. Scanning it for capabilities produces
 * findings that are true statements about text and useless statements about
 * software.
 */
const EXECUTABLE = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.py', '.rb', '.pl',
  '.gyp', '.gypi', '.json',
]);

/** Files whose contents are prose, whatever URLs they happen to contain. */
const DOCUMENTATION = new Set(['.md', '.markdown', '.txt', '.rst', '.adoc', '.html', '.htm']);

export function classify(name) {
  const base = name.split('/').pop().toLowerCase();
  const extension = extensionOf(name);

  if (BINARY_EXTENSIONS.has(extension)) return 'binary';
  if (DOCUMENTATION.has(extension)) return 'documentation';
  if (/^(licen[cs]e|notice|changelog|authors|contributors|readme)$/i.test(base)) return 'documentation';
  if (EXECUTABLE.has(extension)) return 'code';
  // An extensionless file in bin/ is a script often enough to be worth reading.
  if (extension === '' && name.startsWith('bin/')) return 'code';

  return 'other';
}

export function analyseFile(name, content) {
  const extension = extensionOf(name);
  const kind = classify(name);

  if (kind === 'binary' || !isText(content)) {
    return { name, kind: 'binary', binary: true, bytes: content.length, capabilities: [], hosts: [], longestLine: 0 };
  }

  const text = content.toString('utf8');
  const longestLine = text.split('\n').reduce((max, line) => Math.max(max, line.length), 0);

  // Prose is measured but never mined. Its size and shape still matter, since
  // a readme that becomes one 40,000 character line is worth a glance.
  if (kind !== 'code') {
    return { name, kind, binary: false, bytes: content.length, capabilities: [], hosts: [], longestLine };
  }

  const found = [];

  for (const capability of CAPABILITIES) {
    for (const pattern of capability.patterns) {
      const match = pattern.exec(text);
      if (!match) continue;

      found.push({
        id: capability.id,
        label: capability.label,
        // The line it was seen on, so a reader can judge a comment from a call
        // without leaving the terminal.
        evidence: lineAround(text, match.index),
      });
      break;
    }
  }

  const hosts = new Set();
  for (const match of text.matchAll(HOST)) {
    const host = match[1].toLowerCase();
    if (!UNREMARKABLE_HOSTS.has(host)) hosts.add(host);
  }

  return {
    name,
    kind,
    binary: false,
    bytes: content.length,
    capabilities: found,
    hosts: [...hosts].sort(),
    longestLine,
  };
}

function lineAround(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  const line = text.slice(start, end === -1 ? text.length : end).trim();
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

/**
 * The manifest, which is where the most consequential things live.
 *
 * An install script is the only capability in a package that runs without
 * anybody importing it, on every machine that types npm install, before any
 * code review has happened. It gets its own treatment for that reason.
 */
export function analyseManifest(manifest) {
  const scripts = manifest?.scripts ?? {};

  const lifecycle = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack']
    .filter((name) => typeof scripts[name] === 'string' && scripts[name].trim() !== '')
    .map((name) => ({ name, command: scripts[name] }));

  return {
    name: manifest?.name ?? null,
    version: manifest?.version ?? null,
    lifecycle,
    bin: typeof manifest?.bin === 'string' ? { [manifest.name]: manifest.bin } : (manifest?.bin ?? {}),
    dependencies: manifest?.dependencies ?? {},
    optionalDependencies: manifest?.optionalDependencies ?? {},
    repository: typeof manifest?.repository === 'string' ? manifest.repository : (manifest?.repository?.url ?? null),
    license: manifest?.license ?? null,
    engines: manifest?.engines ?? {},
    hasTypes: Boolean(manifest?.types ?? manifest?.typings),
  };
}

/** Everything an unpacked version can do, rolled up. */
export function analyse(entries) {
  const manifestEntry = entries.find((e) => e.name === 'package.json');
  const manifest = manifestEntry ? safeJson(manifestEntry.content.toString('utf8')) : null;

  const files = entries.map((e) => analyseFile(e.name, e.content));

  const capabilities = new Map();
  const hosts = new Map();

  for (const file of files) {
    for (const capability of file.capabilities) {
      if (!capabilities.has(capability.id)) {
        capabilities.set(capability.id, { ...capability, files: [] });
      }
      capabilities.get(capability.id).files.push(file.name);
    }

    for (const host of file.hosts) {
      if (!hosts.has(host)) hosts.set(host, []);
      hosts.get(host).push(file.name);
    }
  }

  return {
    manifest: analyseManifest(manifest),
    files: files.map((f) => ({ name: f.name, kind: f.kind, bytes: f.bytes, binary: f.binary, longestLine: f.longestLine })),
    capabilities: [...capabilities.values()],
    hosts: [...hosts.entries()].map(([host, files]) => ({ host, files })).sort((a, b) => a.host.localeCompare(b.host)),
    totals: {
      files: files.length,
      code: files.filter((f) => f.kind === 'code').length,
      bytes: files.reduce((sum, f) => sum + f.bytes, 0),
      binaries: files.filter((f) => f.binary).length,
      minified: files.filter((f) => f.kind === 'code' && f.longestLine > MINIFIED_LINE).length,
    },
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
