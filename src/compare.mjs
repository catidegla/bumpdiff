/**
 * The difference between what two versions can do.
 *
 * Every finding here is a change, never a judgement. "This version runs other
 * programs and the last one did not" is a fact somebody can act on. "This
 * version is malicious" is a guess wearing the clothes of a fact, and a tool
 * that makes it will be wrong in public eventually, after which nobody reads
 * the true findings either.
 *
 * Severity exists, but it ranks how much a change deserves a human's attention
 * rather than how dangerous it is. An install script appearing is at the top
 * not because install scripts are bad, most are a build step, but because it
 * is the one change that runs on every machine before anyone has read a line.
 */

export const Severity = Object.freeze({
  Review: 'review',   // stop and look before upgrading
  Notice: 'notice',   // worth knowing, usually fine
  Context: 'context', // background, not a finding
});

const finding = (severity, kind, summary, detail = {}) => ({ severity, kind, summary, ...detail });

/**
 * @param {object} before analyse() of the old version
 * @param {object} after  analyse() of the new version
 * @param {object} facts  { before, after } from releaseFacts, plus maintainers
 */
export function compare(before, after, facts = {}) {
  const findings = [];

  findings.push(...lifecycle(before, after));
  findings.push(...capabilities(before, after));
  findings.push(...hosts(before, after));
  findings.push(...shape(before, after));
  findings.push(...manifest(before, after));
  findings.push(...release(facts));

  const rank = { [Severity.Review]: 0, [Severity.Notice]: 1, [Severity.Context]: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.kind.localeCompare(b.kind));

  return {
    findings,
    counts: {
      review: findings.filter((f) => f.severity === Severity.Review).length,
      notice: findings.filter((f) => f.severity === Severity.Notice).length,
      context: findings.filter((f) => f.severity === Severity.Context).length,
    },
    quiet: findings.every((f) => f.severity === Severity.Context),
  };
}

/* --------------------------------------------------------- install scripts */

function lifecycle(before, after) {
  const out = [];
  const was = new Map(before.manifest.lifecycle.map((s) => [s.name, s.command]));
  const now = new Map(after.manifest.lifecycle.map((s) => [s.name, s.command]));

  for (const [name, command] of now) {
    if (!was.has(name)) {
      out.push(finding(Severity.Review, 'install-script-added',
        `a ${name} script appeared, which runs on every machine that installs this`,
        { script: name, command }));
    } else if (was.get(name) !== command) {
      out.push(finding(Severity.Review, 'install-script-changed',
        `the ${name} script changed`,
        { script: name, before: was.get(name), after: command }));
    }
  }

  for (const [name] of was) {
    if (!now.has(name)) {
      out.push(finding(Severity.Notice, 'install-script-removed', `the ${name} script was removed`, { script: name }));
    }
  }

  return out;
}

/* -------------------------------------------------------------- capability */

function capabilities(before, after) {
  const was = new Map(before.capabilities.map((c) => [c.id, c]));
  const now = new Map(after.capabilities.map((c) => [c.id, c]));
  const out = [];

  for (const [id, capability] of now) {
    if (was.has(id)) continue;

    out.push(finding(Severity.Review, 'capability-gained',
      `it now ${capability.label}, and the previous version did not`,
      { capability: id, files: capability.files.slice(0, 5), evidence: capability.evidence }));
  }

  for (const [id, capability] of was) {
    if (now.has(id)) continue;

    // Worth saying, gently. A capability disappearing is usually a cleanup and
    // occasionally a sign the package was rewritten by somebody else.
    out.push(finding(Severity.Notice, 'capability-lost',
      `it no longer ${capability.label}`, { capability: id }));
  }

  return out;
}

/* -------------------------------------------------------------------- hosts */

function hosts(before, after) {
  const was = new Set(before.hosts.map((h) => h.host));
  const out = [];

  for (const entry of after.hosts) {
    if (was.has(entry.host)) continue;

    out.push(finding(Severity.Review, 'host-added',
      `a new host appears in the source: ${entry.host}`,
      { host: entry.host, files: entry.files.slice(0, 5) }));
  }

  return out;
}

/* -------------------------------------------------------------------- shape */

function shape(before, after) {
  const out = [];
  const wasFiles = new Map(before.files.map((f) => [f.name, f]));
  const nowFiles = new Map(after.files.map((f) => [f.name, f]));

  const newBinaries = [...nowFiles.values()].filter((f) => f.binary && !wasFiles.has(f.name));

  if (newBinaries.length) {
    out.push(finding(Severity.Review, 'binary-added',
      `${newBinaries.length} binary file(s) appeared, which nothing here can read`,
      { files: newBinaries.map((f) => f.name).slice(0, 5) }));
  }

  const newlyMinified = [...nowFiles.values()].filter(
    (f) => !f.binary && f.longestLine > 2000 && (wasFiles.get(f.name)?.longestLine ?? 0) <= 2000,
  );

  if (newlyMinified.length) {
    out.push(finding(Severity.Notice, 'minified-added',
      `${newlyMinified.length} file(s) are now single long lines, which is a build output or an attempt not to be read`,
      { files: newlyMinified.map((f) => f.name).slice(0, 5) }));
  }

  // A patch that triples in size is not necessarily wrong and is always worth
  // a glance, because it is the cheapest possible signal that something other
  // than a bug fix happened.
  const growth = before.totals.bytes > 0 ? after.totals.bytes / before.totals.bytes : 1;

  if (growth >= 2) {
    out.push(finding(Severity.Notice, 'size-jump',
      `the unpacked size went from ${kb(before.totals.bytes)} to ${kb(after.totals.bytes)}, ${growth.toFixed(1)} times larger`,
      { before: before.totals.bytes, after: after.totals.bytes }));
  }

  return out;
}

const kb = (bytes) => `${(bytes / 1024).toFixed(0)} kB`;

/**
 * Whether two repository fields name the same place.
 *
 * npm accepts about six spellings of one repository and packages drift between
 * them for no reason at all: `git+https://github.com/x/y.git` against
 * `https://github.com/x/y` is a formatting change that a naive comparison
 * reports as the source moving, which is the most alarming finding this tool
 * has. Raising it over a `.git` suffix is how a reader learns to ignore it,
 * and a repository genuinely moving is something they need to see.
 */
export function sameRepository(a, b) {
  const normalise = (raw) => String(raw)
    .trim()
    .toLowerCase()
    .replace(/^git\+/, '')
    .replace(/^(?:git|ssh):\/\/(?:git@)?/, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');

  return normalise(a) === normalise(b);
}

/* ----------------------------------------------------------------- manifest */

function manifest(before, after) {
  const out = [];
  const a = before.manifest;
  const b = after.manifest;

  const wasDeps = new Set(Object.keys({ ...a.dependencies, ...a.optionalDependencies }));
  const added = Object.keys({ ...b.dependencies, ...b.optionalDependencies }).filter((d) => !wasDeps.has(d));

  if (added.length) {
    out.push(finding(Severity.Notice, 'dependency-added',
      `${added.length} new dependenc${added.length === 1 ? 'y' : 'ies'}: ${added.slice(0, 6).join(', ')}`,
      { dependencies: added }));
  }

  const wasBin = new Set(Object.keys(a.bin ?? {}));
  const newBin = Object.keys(b.bin ?? {}).filter((n) => !wasBin.has(n));

  if (newBin.length) {
    out.push(finding(Severity.Review, 'bin-added',
      `it now installs executable(s) onto the PATH: ${newBin.join(', ')}`,
      { bin: newBin }));
  }

  if (a.repository && b.repository && sameRepository(a.repository, b.repository) === false) {
    out.push(finding(Severity.Review, 'repository-changed',
      `the source repository moved from ${a.repository} to ${b.repository}`,
      { before: a.repository, after: b.repository }));
  }

  if (a.license && b.license && a.license !== b.license) {
    out.push(finding(Severity.Notice, 'license-changed',
      `the licence changed from ${a.license} to ${b.license}`,
      { before: a.license, after: b.license }));
  }

  return out;
}

/* ------------------------------------------------------------------ release */

function release(facts) {
  const out = [];
  const { before, after, maintainers: people } = facts;

  if (!before || !after) return out;

  if (before.publisher && after.publisher && before.publisher !== after.publisher) {
    // The single most useful fact in a supply chain compromise, and one that
    // reading the code will never give you.
    out.push(finding(Severity.Review, 'publisher-changed',
      `published by ${after.publisher}, where the previous version was published by ${before.publisher}`,
      { before: before.publisher, after: after.publisher, maintainers: people ?? [] }));
  }

  if (before.hasProvenance && !after.hasProvenance) {
    out.push(finding(Severity.Review, 'provenance-lost',
      'the previous version carried npm provenance and this one does not, so it was published by hand rather than from a workflow',
      {}));
  }

  if (!before.hasProvenance && after.hasProvenance) {
    out.push(finding(Severity.Context, 'provenance-gained', 'this version carries npm provenance and the previous one did not', {}));
  }

  if (after.deprecated) {
    out.push(finding(Severity.Notice, 'deprecated', `the registry marks this version deprecated: ${after.deprecated}`, {}));
  }

  if (before.publishedAt && after.publishedAt) {
    const days = (Date.parse(after.publishedAt) - Date.parse(before.publishedAt)) / 86400000;
    out.push(finding(Severity.Context, 'timing',
      `published ${days < 1 ? 'less than a day' : `${Math.round(days)} days`} after the previous version`,
      { days }));
  }

  return out;
}
