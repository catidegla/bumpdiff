<div align="center">

# bumpdiff

A patch bump that starts spawning shells looks exactly like one that fixes a typo.

[![CI](https://github.com/catidegla/bumpdiff/actions/workflows/ci.yml/badge.svg)](https://github.com/catidegla/bumpdiff/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933)](package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

---

```bash
npx bumpdiff chalk 4.1.2 5.0.0
```

```
  chalk 4.1.2 to 5.0.0

  ! it now reads machine and user details, and the previous version did not
      import os from 'node:os';
      source/vendor/supports-color/index.js
  . published 119 days after the previous version

  12 files, 40 kB, published by sindresorhus

  1 change(s) worth reading before you upgrade.
  These are changes, not verdicts. Most have an ordinary explanation.
```

A version number tells you what the author intended. It tells you nothing about what changed in **what the package can do**.

## What it looks at

| | |
| :--- | :--- |
| **Install scripts** | A `postinstall` appearing is the loudest thing here, because it runs on every machine that types `npm install`, before anyone has read a line. |
| **Capabilities** | Spawning processes, opening sockets, writing files, evaluating code at runtime, reading the environment. Gained, not merely present. |
| **Hosts** | A new domain in the source, ignoring the ones every package mentions. |
| **The publisher** | A release published by somebody who has never published this package before. No amount of reading the code gives you that. |
| **Provenance** | A package that carried npm provenance and stopped is now being published by hand rather than from a workflow. |
| **Shape** | New binaries, files that became single enormous lines, a patch that doubled in size. |

## Nothing runs, nothing lands on disk

The tarballs are fetched into memory, gunzipped, and read with a tar parser written by hand in this repository. **No install script is ever given the chance to execute**, and nothing is written anywhere.

That is also why it has no dependencies. A tool whose job is to inspect packages you have not decided to trust should not install a tree of its own to do the inspecting. A supply chain inspector with a supply chain is an argument in a circle.

## Changes, never verdicts

It will never call a package malicious. That word requires knowing intent, and a tool that guesses at intent is the tool people stop reading.

Severity ranks **how much a change deserves your attention**, not how dangerous it is:

- `!` worth reading before you upgrade
- `~` worth knowing, usually fine
- `.` background

Most `!` findings have an ordinary explanation. The point is that you get thirty seconds to decide, rather than finding out later.

## It is lexical, and says so

Capabilities are found by looking for the shapes that reach outside the process. A commented-out `require('child_process')` matches. A parser would be more precise and would mean shipping one.

The cost is low because nothing here produces a verdict, and because **the line it was found on is printed underneath**, so a false positive is obvious in one second rather than after you open the package:

```
  ! it now runs other programs, and the previous version did not
      // const cp = require('child_process'); // removed in v2
```

Documentation is never scanned. The first live run of this tool reported four findings on a chalk upgrade and three were badge URLs in the readme. That is how a tool gets uninstalled in a week: a reader wrong-footed three times stops reading the fourth line, which was the one that mattered. There is a test for it now.

## In CI

```yaml
- uses: catidegla/bumpdiff@v0.1.0
  with:
    lockfile: package-lock.json
```

On a pull request it diffs against the base automatically. A base it cannot
reach, a lockfile that did not move, and a registry that is down all pass
quietly rather than blocking a merge on something that is not about your
dependencies.

Or in one line, which is all the action does:

```bash
git diff origin/main -- package-lock.json | npx bumpdiff lockfile
```

```bash
git diff origin/main -- package-lock.json | npx bumpdiff lockfile
```

Every version change in the diff, checked. Exit codes:

| | |
| :--- | :--- |
| `0` | nothing worth stopping for |
| `1` | something worth reading |
| `2` | the command or the package was wrong |
| `3` | the registry could not be reached |

Three is separate on purpose. A job that treats *could not check* as *nothing changed* is worse than no check at all.

## What it cannot do

It cannot see what a package does at runtime, only what its source reaches for. Code fetched after install is invisible to it, which is precisely why a **new host** and a **new install script** are the two loudest findings.

It cannot read minified or obfuscated code usefully. It reports that a file became one enormous line and leaves the reading to you.

It cannot tell you a change is safe. It tells you a change happened.

## Testing

```bash
npm test    # 67 tests, nothing to install
```

The suite never touches the registry: tarballs are built in memory so the tests cannot fail because somebody published something, and cannot pass because a network was down. CI has a separate job that runs against real packages and is allowed to fail, because a registry outage is not a defect in this repository.

## Requirements

Node 20 or later. No other dependency, which is the whole point.

## License

MIT.
