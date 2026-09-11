#!/usr/bin/env node
/**
 * bumpdiff
 *
 * What a version bump changed about what a package can do, rather than what
 * its changelog says it changed.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { packument, resolveVersions, releaseFacts, maintainers, fetchTarball, RegistryError } from '../src/registry.mjs';
import { readTarball } from '../src/tar.mjs';
import { analyse } from '../src/capabilities.mjs';
import { compare, Severity } from '../src/compare.mjs';
import { parseLockfileDiff } from '../src/lockfile.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
const rest = argv.slice(1).filter((a) => !a.startsWith('--'));
const has = (n) => argv.includes(`--${n}`);
const value = (n, fallback = null) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? fallback : argv[i + 1];
};

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  bold: (s) => paint('1', s), dim: (s) => paint('2', s),
  red: (s) => paint('31', s), yellow: (s) => paint('33', s), green: (s) => paint('32', s),
};

/**
 *   0  nothing worth stopping for
 *   1  something worth reading before you upgrade
 *   2  the command or the package was wrong
 *   3  the registry could not be reached
 *
 * Three is separate because a network failure must never read as a clean
 * diff. A CI job that treats "could not check" as "nothing changed" is worse
 * than no check at all.
 */
const EXIT = { CLEAN: 0, REVIEW: 1, USAGE: 2, UNREACHABLE: 3 };

const MARK = {
  [Severity.Review]: c.red('!'),
  [Severity.Notice]: c.yellow('~'),
  [Severity.Context]: c.dim('.'),
};

function usage() {
  console.log(`
${c.bold('bumpdiff')} ${pkg.version}
What a version bump changed about what a package can do.

  ${c.bold('<package>')}        compare a version against the one published before it
  ${c.bold('lockfile')}         every version change in a package-lock.json diff

Examples
  bumpdiff chalk
  bumpdiff chalk 5.3.0 5.4.0
  bumpdiff @scope/thing --to 2.0.0
  git diff package-lock.json | bumpdiff lockfile

Options
  --from <version>     the version being upgraded from (default: the one published before --to)
  --to <version>       the version being upgraded to (default: latest)
  --registry <url>     a registry other than npmjs
  --quiet              only print findings worth reading
  --json               machine readable output
  --notice-fails       exit non-zero on notices too, not just review findings

Nothing is downloaded to disk and no install script is ever run. Findings are
changes, never verdicts: this reports what moved and leaves the judgement to you.
`);
}

async function diff(name, { from, to }) {
  const doc = await packument(name, { registry: value('registry') ?? undefined });
  const versions = resolveVersions(doc, to, from);

  const facts = {
    before: releaseFacts(doc, versions.from),
    after: releaseFacts(doc, versions.to),
    maintainers: maintainers(doc),
  };

  const [beforeTar, afterTar] = await Promise.all([
    fetchTarball(facts.before.tarball),
    fetchTarball(facts.after.tarball),
  ]);

  const before = analyse(readTarball(beforeTar));
  const after = analyse(readTarball(afterTar));

  return { name, versions, facts, result: compare(before, after, facts), before, after };
}

function print({ name, versions, facts, result }) {
  console.log('');
  console.log(`  ${c.bold(name)} ${c.dim(`${versions.from} to ${versions.to}`)}`);
  console.log('');

  const shown = has('quiet')
    ? result.findings.filter((f) => f.severity !== Severity.Context)
    : result.findings;

  if (shown.length === 0) {
    console.log(`  ${c.green('Nothing changed about what this package can do.')}`);
  }

  for (const f of shown) {
    console.log(`  ${MARK[f.severity]} ${f.summary}`);

    if (f.command) console.log(`      ${c.dim(f.command)}`);
    if (f.evidence) console.log(`      ${c.dim(f.evidence)}`);
    if (f.files?.length) console.log(`      ${c.dim(f.files.join(', '))}`);
    if (f.before && f.after && !f.command) console.log(`      ${c.dim(`${f.before} -> ${f.after}`)}`);
  }

  console.log('');
  console.log(c.dim(`  ${facts.after.fileCount ?? '?'} files, ${facts.after.unpackedSize ? `${Math.round(facts.after.unpackedSize / 1024)} kB` : 'unknown size'}, published by ${facts.after.publisher ?? 'somebody the registry does not name'}`));

  if (result.counts.review > 0) {
    console.log('');
    console.log(`  ${c.red(`${result.counts.review} change(s) worth reading before you upgrade.`)}`);
    console.log(c.dim('  These are changes, not verdicts. Most have an ordinary explanation.'));
  }

  console.log('');
}

const commands = {
  async lockfile() {
    // Reading a diff rather than a lockfile, because the question is what a
    // pull request changes, and the lockfile alone cannot answer that.
    const input = await readStdin();

    if (!input.trim()) {
      console.error(c.red('lockfile reads a diff on stdin: git diff package-lock.json | bumpdiff lockfile'));
      process.exit(EXIT.USAGE);
    }

    const bumps = parseLockfileDiff(input);

    if (bumps.length === 0) {
      console.log('\n  No version changes in that diff.\n');
      return;
    }

    let worst = EXIT.CLEAN;
    const all = [];

    for (const bump of bumps) {
      try {
        const outcome = await diff(bump.name, { from: bump.from, to: bump.to });
        all.push(outcome);

        if (!has('json')) print(outcome);

        if (outcome.result.counts.review > 0) worst = EXIT.REVIEW;
        else if (has('notice-fails') && outcome.result.counts.notice > 0) worst = EXIT.REVIEW;
      } catch (error) {
        console.error(`  ${c.yellow('~')} ${bump.name}: ${error.message}`);
        if (error instanceof RegistryError) worst = Math.max(worst, EXIT.UNREACHABLE);
      }
    }

    if (has('json')) console.log(JSON.stringify(all.map(strip), null, 2));

    process.exit(worst);
  },
};

function strip({ name, versions, facts, result }) {
  return { name, versions, facts, findings: result.findings, counts: result.counts };
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

if (has('version')) {
  console.log(pkg.version);
} else if (!command || has('help') || command === 'help') {
  usage();
} else if (commands[command]) {
  try {
    await commands[command]();
  } catch (error) {
    console.error(`bumpdiff: ${error.message}`);
    process.exit(error instanceof RegistryError ? EXIT.UNREACHABLE : EXIT.USAGE);
  }
} else {
  // Anything that is not a known command is a package name, which is the
  // shape people reach for first.
  try {
    const outcome = await diff(command, {
      from: value('from') ?? rest[0] ?? null,
      to: value('to') ?? rest[1] ?? 'latest',
    });

    if (has('json')) console.log(JSON.stringify(strip(outcome), null, 2));
    else print(outcome);

    const failing = outcome.result.counts.review > 0 || (has('notice-fails') && outcome.result.counts.notice > 0);
    process.exit(failing ? EXIT.REVIEW : EXIT.CLEAN);
  } catch (error) {
    console.error(`bumpdiff: ${error.message}`);
    process.exit(error instanceof RegistryError ? EXIT.UNREACHABLE : EXIT.USAGE);
  }
}
