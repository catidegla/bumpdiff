/**
 * Finding the version changes in a diff.
 *
 * Reading a diff rather than a lockfile, because the question is what a pull
 * request changes and the lockfile alone cannot answer that. It says what the
 * tree is now, not what it was.
 *
 * Deliberately simple, and deliberately biased towards missing a bump rather
 * than inventing one. A bump this fails to notice costs a reader nothing; one
 * it invents sends them to read a diff that does not exist, and after the
 * second of those they stop running it.
 */

/**
 * @param {string} text a unified diff, usually from git diff package-lock.json
 * @returns {Array<{name: string, from: string, to: string}>}
 */
export function parseLockfileDiff(text) {
  const bumps = new Map();
  let current = null;

  for (const line of String(text ?? '').split('\n')) {
    // npm v2 and v3 lockfiles key entries by their install path.
    const entry = /^[+\- ]\s*"(?:node_modules\/)?((?:@[^/"]+\/)?[^/"]+)":\s*\{/.exec(line);
    if (entry) {
      current = entry[1];
      continue;
    }

    // yarn's text format keys by name@range on an unchanged line.
    const yarn = /^[ ]\s*"?((?:@[^/"@\s]+\/)?[^/"@\s]+)@/.exec(line);
    if (yarn) {
      current = yarn[1];
      continue;
    }

    const version = /^([+-])\s*"?version"?:?\s*"([^"]+)"/.exec(line);
    if (!version || !current) continue;

    if (!bumps.has(current)) bumps.set(current, { name: current, from: null, to: null });

    const found = bumps.get(current);
    if (version[1] === '-') found.from = version[2];
    else found.to = version[2];
  }

  // Both halves, and actually different. A package appearing for the first
  // time is a different question from one changing, and this answers the
  // second.
  return [...bumps.values()].filter((b) => b.from && b.to && b.from !== b.to);
}
