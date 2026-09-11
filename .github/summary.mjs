/**
 * Turn a bumpdiff JSON report into the block a reviewer reads on the run.
 *
 * Built from the report already on disk rather than from a second run,
 * because scoring again would fetch and unpack every tarball twice.
 *
 * Usage: node summary.mjs <report.json>
 * Writes the markdown to stdout and the finding count to stderr's last line,
 * so a shell can capture the count without parsing the prose.
 */
import { readFileSync } from 'node:fs';

const MARK = { review: '!', notice: '~', context: '.' };

export function summarise(runs) {
  const list = Array.isArray(runs) ? runs : [runs];
  const lines = ['### bumpdiff', ''];

  let review = 0;
  let notice = 0;

  for (const run of list) {
    const findings = run.findings ?? [];
    review += findings.filter((f) => f.severity === 'review').length;
    notice += findings.filter((f) => f.severity === 'notice').length;

    // Background findings are true and not worth a line in a pull request.
    const worth = findings.filter((f) => f.severity !== 'context');
    if (!worth.length) continue;

    lines.push(`**${run.name}** ${run.versions.from} to ${run.versions.to}`, '');

    for (const f of worth) {
      lines.push(`- ${MARK[f.severity] ?? '.'} ${f.summary}`);
      // The line it was found on, so a false positive is obvious in a second
      // rather than after somebody opens the package.
      if (f.evidence) lines.push(`  \`${String(f.evidence).slice(0, 160)}\``);
    }

    lines.push('');
  }

  if (!review && !notice) {
    lines.push('Nothing changed about what these packages can do.');
  } else {
    lines.push(
      `${review} worth reading before you merge, ${notice} worth knowing. ` +
        'These are changes, not verdicts, and most have an ordinary explanation.',
    );
  }

  return { markdown: lines.join('\n'), count: review + notice };
}

if (process.argv[2]) {
  const { markdown, count } = summarise(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  process.stdout.write(`${markdown}\n`);
  process.stderr.write(`${count}\n`);
}
