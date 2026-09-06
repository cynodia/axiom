# Axiom 0.16pt4 — Implementation report

*Maintainer artifact. Not shipped in any npm tarball.*

Spec: `specs/spec16pt4.md` — **CLI JSON Error Contract Corrective**. Target:
`0.16.0-alpha.4`. Baseline: `0.16.0-alpha.3`, which the spec records as having already
reached `D1 / E1 / S1` with zero release-blocking findings.

## Status at the end of this pass

```text
Axiom 0.16.0-alpha.4

F-CLI-JSON-NOT-HONORED-ON-ERROR fixed
internal tests green (1671 fast-tier tests, all eight testable workspaces — cli is
                        newly one of them)
local packaging verified (pack / verify-packages / consumer-test)

0.16 semantic tooling contract unaffected — still D1 / E1 / S1 at the alpha.3 baseline
ready for the targeted CLI-only external recheck the spec asks for (§10), then stable
0.16.0 packaging
```

**Actual `npm publish` of `0.16.0-alpha.4` was not performed in this session** — same
standing reason as every prior 0.16 corrective pass: a real registry publish under the
authenticated `cynodia` account is held for explicit maintainer confirmation, independent
of how ready the tooling is.

## The defect

`F-CLI-JSON-NOT-HONORED-ON-ERROR`: several CLI error paths ignored `--json` and printed
plain prose (or, worse for a script parsing stdout, propagated a raw `Error.message`
through the generic top-level `.catch()` with no JSON wrapping at all). Concretely, before
this pass:

| Path | Behavior under `--json` before this pass |
| --- | --- |
| `explain <kind> <unknown-id> <file> --json` | Plain string on stdout (`No action node "foo" in this graph`), no JSON |
| `analyze <file> --export=<unknown> --json` | Thrown `Error` reached the top-level `.catch()`, printed as plain `error.message` to stderr |
| `diff <file> --json` (no `--against`) | Same — plain text via the top-level catch |
| missing model file (`explain <kind> <id> --json`, no file) | `parseArguments` returned `null` before `--json` was even consulted; `USAGE` text dumped to stderr |
| unknown command (`bogus <file> --json`) | `console.error('Unknown command: …')`, unconditionally plain |
| `validate --json` on an invalid graph | **Already correct** — `validateGraph` never throws, so `console.log(JSON.stringify(result))` always ran regardless of validity. No fix needed here; kept as a pinned regression case. |

## Fix

One structured shape, one central place it is produced (`packages/cli/src/index.ts`):

```json
{
  "ok": false,
  "error": { "code": "UNKNOWN_NODE", "message": "No action node \"foo\" in this graph" }
}
```

- **`CliError`** (`code: CliErrorCode`, extends `Error`) — thrown at every CLI-level
  failure site instead of a bare `Error`, so the failure carries a stable, documented code
  rather than forcing a caller to pattern-match a message string. Codes: `INVALID_ARGUMENTS`,
  `UNKNOWN_COMMAND`, `UNKNOWN_NODE`, `MISSING_ARGUMENT`, `MODEL_LOAD_FAILED`,
  `COMMAND_FAILED` (the generic fallback for anything not raised as a `CliError` — e.g. a
  native error from a dependency, still reported cleanly, never with its stack).
- **`fail(json, code, message)`** — the one function that emits a failure: JSON on stdout
  (`console.log`, matching where every successful `--json` result already goes — so a
  caller parsing stdout never has to branch on which channel to read) or plain text on
  stderr, exactly the prior human-mode behavior. Always sets `process.exitCode = 1`.
- **`main()`** now computes `--json` presence directly from `process.argv` (`wantsJson`)
  *before* calling `parseArguments`, because a missing model file or an unparseable
  command line means `parseArguments` returns `null` — there is no `Options.json` to read
  yet at that point. The command switch itself moved into a new `runCommand(options)`,
  called from inside a `try`/`catch` in `main()` so every thrown error — `CliError` or
  otherwise — is caught with `options.json` in scope. The top-level `main().catch()` is
  now a last-resort safety net using the same `fail()` path (re-deriving `--json` from
  `process.argv` since nothing else is in scope there), rather than the unconditional
  plain-text handler it was.
- **`loadGraphModule`** — the single loader every command (`explain`/`analyze`/`diff`/
  `validate`/`inspect`/`build`/`serve`) goes through — now wraps the dynamic `import()` in
  `try`/`catch` and raises `CliError('MODEL_LOAD_FAILED', …)` uniformly, whether the
  failure is a nonexistent file, an unresolvable `--export` name, or a module that exports
  several ambiguous candidates. One error class covers "analyze unknown --export" and "a
  model file that does not exist" identically.
- **`explainCommand`** — the "no such node" case (previously a returned string, printed via
  `console.log` regardless of mode) now throws `CliError('UNKNOWN_NODE', …)` **only** when
  `options.json` is set; human mode is untouched byte-for-byte (still returns the string,
  still exits nonzero, still lands on stdout via `console.log` — an existing quirk this
  pass deliberately preserved per spec §6 rather than "fixing" it into a different
  channel, which would have been an unrequested behavior change). The two usage-error
  throws (`missing kind/id`, `unknown kind`) became `CliError('INVALID_ARGUMENTS', …)`.
- **`diffCommand`** — the missing-`--against` throw became
  `CliError('MISSING_ARGUMENT', …)`.
- **`main()`**'s unknown-command branch now checks `options.json` and calls `fail()`
  instead of unconditionally writing to stderr.

## Non-goals honored

No edit reaches `AgentAPI`, `validateGraph`, `semanticDiff`, authorization, workflow,
distributed or Server IR code. `schemaDiff`/`migratePlan`/`migrateStatus`/`migrateRun`
were **not** touched — they never had `--json` wiring at all, and the spec's six required
error cases don't name them; adding JSON support there would have been unrequested scope
expansion. Every existing successful `--json` output (`explain`/`analyze`/`diff`/
`validate`) is provably unchanged — see the parity test below, and no line producing a
success path was edited.

## Tests (new: `packages/cli/test/`)

The `cli` package had **no test infrastructure at all** before this pass (no
`tsconfig.test.json`, no `test` npm script, no `packages/cli/test/` directory) — it was
silently skipped by `npm test --workspaces --if-present`. Added, following the same
`tsconfig.test.json` → `dist-test/**/*.test.js` pattern every other package already uses:

- `packages/cli/tsconfig.test.json`, `package.json` gained `"test": "node --test
  dist-test/**/*.test.js"` and `"build": "tsc -b tsconfig.json tsconfig.test.json"`.
- `packages/cli/test/fixtures/model.ts` — a minimal valid graph (one state, one action).
- `packages/cli/test/fixtures/invalid-model.ts` — a graph that loads but fails
  `validateGraph` (an action's `set` targets a nonexistent state), for the "invalid graph"
  case.
- `packages/cli/test/json-errors.test.ts` (9 tests) — spawns the **compiled CLI as a real
  subprocess** (`node dist/index.js …`) against the fixtures, exactly how an external
  consumer invokes it; never imports `dist/index.js` as a module, since it runs `main()`
  against `process.argv` at import time. Covers, one test per spec §3 required case plus
  the success-parity requirement of §5:
  - `explain` unknown node id, with and without `--json` (the paired test pins that human
    mode is unchanged, per §6).
  - `analyze` unknown `--export`, and a model file that does not exist on disk — both
    resolve to `MODEL_LOAD_FAILED`.
  - `diff` missing `--against` → `MISSING_ARGUMENT`.
  - Missing model file (parse failure before any command runs) → `INVALID_ARGUMENTS`.
  - Unknown command → `UNKNOWN_COMMAND`.
  - `validate --json` on an invalid graph → still `{valid: false, errors: […]}`, nonzero
    exit (regression pin — this path was already correct).
  - `explain`/`analyze`/`diff`/`validate --json` on a valid graph all still exit `0` with
    parseable JSON (CLI↔AgentAPI parity unchanged, §5).

  Every error-path assertion parses the **entire trimmed stdout** as one JSON value
  (`JSON.parse(stdout)`) — this is what actually proves "no plain prose on stdout" and "no
  native stack trace" (§3): either would have broken the parse, so a passing assertion is
  sufficient proof of both, not just of "some JSON appeared somewhere."

`packages/cli/package.json`'s `files` whitelist is unchanged (`dist/**/*.js`,
`dist/**/*.d.ts`, README, LICENSE) — `scripts/verify-packages.mjs` confirms the tarball is
still exactly 5 files after adding `dist-test/`; test output was never at risk of shipping
since it compiles to `dist-test/`, not `dist/`, same as every other package.

## Verification performed this session

```text
npm run build                    → clean across all 8 workspaces, cli's new tsconfig.test.json included
npm test                         → 1671 tests, 0 failures (cli: 0 → 9, all new; every other
                                     workspace unchanged: agent-api 131, compiler 149, core 364,
                                     demo 214, runtime 28, server 697, ui-toolkit 79)
npm run version:set -- 0.16.0-alpha.4   → 123 files, 147 substitutions (root+workspace manifests,
                                     docs, package READMEs, AGENTS.md, llms.txt, the graph.ts
                                     default version, conformance manifests) — used in preference
                                     to a hand-written sed pass, since this tool (added between
                                     the pt3 and pt4 sessions) is now the documented, single-command
                                     way to keep the ~123 copies of the version string in sync
npm run build && npm test (rerun at alpha.4)  → identical 1671/1671 green
npm run release:pack             → 8/8 tarballs at 0.16.0-alpha.4, including
                                     cynodia-axiom-cli-0.16.0-alpha.4.tgz
npm run release:verify           → 8/8 ok; @cynodia/axiom-cli still exactly 5 files, 10.9 KiB —
                                     confirms dist-test/ did not leak into the tarball
node scripts/consumer-test.mjs   → full success from local tarballs: fresh install, type-check,
                                     axiom --help + per-command --help + validate/explain/analyze/
                                     diff (incl. --json), materialization gate — all pass unchanged
```

Registry-backed verification (`release:verify-registry`) and a real `npm publish` were not
run — there is nothing to verify yet at `0.16.0-alpha.4` until a publish happens, and that
publish itself is the withheld action (see below).

## What remains

**Actual publication of `0.16.0-alpha.4` was not performed.** Once the maintainer
confirms, the sequence is `npm run release:publish` (which now includes the spec16pt3-added
automatic post-publish `verify-registry.mjs` gate) followed by
`npm run release:consumer-test-registry` for genuine registry-backed evidence.

Per spec16pt4 §10-11, this pass explicitly does **not** rerun the full 0.16 blind campaign
— alpha.3 already holds `D1 / E1 / S1`, and this corrective targets only the CLI JSON
surface. After a real publish, the targeted recheck the spec asks for is: the existing CLI
section of the campaign, plus the specific `--json` error paths this pass added coverage
for, confirming `F-CLI-JSON-NOT-HONORED-ON-ERROR CLOSED` and no new CLI blockers against
the actually-published artifact (not local tarballs) — at which point, per §11, `0.16.0`
is ready for stable packaging/release.
