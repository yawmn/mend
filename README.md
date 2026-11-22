# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/yawmn/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/yawmn/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit an AI model wrote to a tree of text files, in the four formats models write: unified diffs
(including the wrong line numbers models make up), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls
as JSON. It is one command-line tool, one written contract, and it changes every file or none.

`SPEC.md` is the whole contract. It defines the command line, the exact standard output and exit codes, safe
paths, CRLF and missing final line breaks, the three matching tiers (exact, trailing whitespace, leading and
trailing whitespace), how each format is read, and the all-or-nothing write.

## Run it

Node 22 and its standard library alone: nothing to install, no dependencies, no network.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is a patch file, or `-`/absent for standard input.
- `--format=unified|search-replace|v4a|json` reads one format; `auto` (the default) detects it.
- `--check` does everything but write, with the same output and exit code.
- `--strict` matches lines exactly, with no whitespace tolerance.

Examples:

```sh
git diff | node main.ts --check
node main.ts --format=search-replace edits.txt
node main.ts --strict large.patch
```

Exit codes: `0` when the tree is written (or checked), `1` when any edit failed (nothing is written, and every
failure is named), `2` for a usage, patch-reading, format or parse error.

## Layout

- `main.ts`: the CLI. Node 22, the standard library alone.
- `runner.ts`: the trial runner the kit supplies; it runs `main.ts` over a trial's checks and posts the results.
- `check.ts`: the kit's local practice checker.
- `SPEC.md`: the specification mend implements, version 1.
- `LICENSE`: MIT.

## Testing

`check.ts` runs the public practice set on a machine:

```sh
node check.ts /path/to/program/generator/practice.json
```

This entry passes all 100 public practice checks, and a separate adversarial suite of 138 hand-derived checks
covers command-line faults, format detection, parse line numbers, unsafe paths, tier matching, CRLF and missing
final newlines, moves and `R` lines, creation and deletion, JSON array and JSON Lines forms, V4A anchors and
end-of-file chunks, atomic rollback, output ordering, and determinism.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
