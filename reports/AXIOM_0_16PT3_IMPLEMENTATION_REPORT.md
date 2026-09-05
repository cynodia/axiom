# Axiom 0.16pt3 — Implementation report

*Maintainer artifact. Not shipped in any npm tarball.*

Spec: `specs/spec16pt3.md` — **Published CLI Completion, Documentation Consistency & Final
0.16 Freeze Candidate**. Target: `0.16.0-alpha.3`.

## Status at the end of this pass

```text
Axiom 0.16.0-alpha.3

CLI publication corrective implemented
internal tests green (1661 fast-tier tests, all seven testable workspaces)
local packaging verified (pack / verify-packages / consumer-test / discoverability-probe)

EXTERNAL VALIDATION REQUIRED
0.16 CONTRACT NOT FROZEN
```

This matches spec16pt3 §147's required interim status exactly. **Actual `npm publish` of
`0.16.0-alpha.3` was not run in this session** — see "What remains" below. D1 cannot be
declared from internal or local evidence (spec16pt3 §73, §147); it requires a real registry
lookup a blind external consumer performs, which by construction happens after publication.

## An important finding before starting: alpha.2 is already genuinely published

Before making any change, this session queried the real npm registry (read-only:
`npm view`) to establish ground truth rather than trust the spec's premise blindly:

```text
npm view @cynodia/axiom-cli@0.16.0-alpha.2
→ resolves; bin.axiom = dist/index.js; dist-tags.latest = 0.16.0-alpha.2

npm view @cynodia/{axiom,axiom-core,axiom-runtime,axiom-compiler,axiom-server,
                    axiom-agent-api,axiom-cli,axiom-ui}@0.16.0-alpha.2
→ all eight resolve
```

**The `0.16.0-alpha.2` package set, including `@cynodia/axiom-cli` with a correct `bin`
mapping, is already live on the public registry.** A fresh install-and-run smoke test in a
throwaway temp directory (`npm install @cynodia/axiom-cli@0.16.0-alpha.2`, then
`./node_modules/.bin/axiom --help`) succeeded, exit 0, correct usage text. This means the
`F-CLI-PACKAGE-NOT-PUBLISHED` finding's literal premise (a 404 at alpha.2) was **already
resolved by the time this session started** — spec16pt3's external-campaign snapshot
appears to have been taken before the alpha.2 publish (consistent with the 0.16pt2 report's
own closing note: "release:pack/consumer-test/release:probe were not executed... the
maintainer should run npm run release:prepare before any actual publish" — implying
publication happened afterward, outside that session).

**`F-DOC-CLI-INCONSISTENT` was still genuinely live, however** — and finding it required
checking the *installed tarball*, not repository HEAD (exactly spec16pt3 §70's point):

```text
npm install @cynodia/axiom@0.16.0-alpha.2 (fresh temp dir)
grep -rn "no published Axiom CLI|published CLI" node_modules/@cynodia/axiom/
→ node_modules/@cynodia/axiom/AGENTS.md:29: "...There is no published Axiom CLI."
```

`packages/axiom/AGENTS.md` — the facade's vendor-neutral agent instruction file — still
carried the stale claim, and it shipped in the actually-published alpha.2 tarball. This is
a genuine, currently-live discoverability defect, closed in this pass (see below). A second
stale claim was found the same way, by re-auditing repository source directly:
`docs/AGENT_REFERENCE.md` line 18, "There is no published CLI." (no "Axiom" in the middle,
which is exactly why the 0.16pt2 regression test's regex — `no published Axiom CLI` — did
not catch it).

**Root cause of the miss:** the 0.16pt2 regression test
(`'the documentation does not claim the CLI is unpublished'`) only scanned `ALL_DOCS`
(`README.md` + `docs/*.md`), never the facade's `AGENTS.md`/`llms.txt`/package `README.md`
files, and its regex required the literal substring `"Axiom CLI"` rather than "CLI" alone.
Both gaps are fixed in the test itself (below), not just in the two documents — the goal is
that this exact class of miss cannot recur silently.

## Documentation consistency (spec16pt3 §60-72)

- **`packages/axiom/AGENTS.md`** — "There is no published Axiom CLI" → names
  `@cynodia/axiom-cli` and its install command.
- **`docs/AGENT_REFERENCE.md`** (two separate stale spots, both found and fixed):
  - Line 18 (`## Start here`): "There is no published CLI." → names the package and its
    command surface.
  - Line 606 (the "PORTABILITY" truth-table entry): claimed `axiom.server.v7` as
    current — corrected to `axiom.server.v9`.
  - Two more spots ("Server IR stays `axiom.server.v7`", in the DISTRIBUTED AUTHORITY and
    LIVE QUERIES sections) reworded to state the actually-timeless fact ("this feature adds
    no Server IR vocabulary of its own") instead of a specific number that goes stale every
    time the *overall* current contract advances for an unrelated reason.
- **`docs/DISTRIBUTED_AUTHORITY.md`**, **`docs/LIVE_QUERIES.md`** — the same
  "Server IR stays `axiom.server.v7`" pattern, same fix.
- **`README.md`**, **`packages/axiom/README.md`** — the `ServerIR` glossary row claimed
  `axiom.server.v7` as current; corrected to `v9`.
- **Left deliberately unchanged** (verified accurate, not stale): `docs/AUTHORITY.md`'s
  Server IR contract table (a complete v1–v9 history, each row paired with the milestone
  that introduced it — historically correct by construction);
  `docs/MIGRATIONS.md`/`docs/LIVE_QUERIES.md`'s conformance-fixture descriptions (accurately
  describing what those specific fixtures actually compile to, which genuinely is v7 since
  migration/live-query fixtures use no v8/v9 vocabulary); `docs/ANTI_PATTERNS.md`'s example
  (illustrative arbitrary values, not a claim about current state); `CLAUDE.md`'s
  spec-changelog entries (a deliberate historical record of what each past milestone said
  at the time — not itself a shipped, consumer-facing document).
- **Regression test hardened**
  (`packages/demo/test/documentation.test.ts`,
  `'the documentation does not claim the CLI is unpublished'`): now scans
  `ALL_DOCS` **and** `PACKAGE_READMES` **and** `facadeEntryPoints` (previously `ALL_DOCS`
  only — the exact gap that let the `AGENTS.md` claim ship), and the regex now matches
  `no published CLI` as well as `no published Axiom CLI` (previously required the literal
  word "Axiom" in the middle — the exact gap that let the `AGENT_REFERENCE.md` claim ship).

## Release-pipeline hardening (spec16pt3 §52-59, §106-107, §156-160)

The alpha.2 defect was precisely "implementation says published, actual registry says
404" (well, in this case, actual registry says fine, but the *documentation* didn't know
it). Spec16pt3 §106 is explicit that a successful local `npm pack` is necessary but not
sufficient — the pipeline needed a real post-publish check, not just a local one, and this
was genuinely missing before this pass.

- **`scripts/verify-registry.mjs`** (new) — for every `publishable` package, queries the
  real npm registry (`npm view <name>@<version> version`) with bounded retry
  (`AXIOM_REGISTRY_VERIFY_ATTEMPTS`/`_DELAY_MS` env overrides, default 5×3s, for ordinary
  propagation lag per §158) and fails loudly — never silently — if any package does not
  resolve at the exact release version. For `@cynodia/axiom-cli` specifically, additionally
  confirms the registry-visible manifest carries a `bin.axiom` entry (the specific artifact
  D2 turns on), not merely that the version string resolves. Exposed as
  `npm run release:verify-registry`, runnable standalone (spec16pt3 §108's "post-publish
  registry gate" before starting a blind campaign) or as part of publish.
- **`scripts/publish.mjs`** — now runs `verify-registry.mjs` automatically immediately
  after the publish loop (skipped only in `--dry-run`, where nothing was actually
  published) and refuses to report success if it fails — "publication failure is release
  failure" (§58) is now enforced by the tool, not left to the operator to remember.
- **`scripts/consumer-test.mjs`** — gained `--from-registry` (`npm run
  release:consumer-test-registry`): installs `name@version` from the **real registry**
  instead of local tarballs, the only thing that actually proves spec16pt3 §56's "a clean
  consumer smoke test MUST install the CLI from the registry, not from the workspace" (the
  existing tarball-based mode remains the pre-publish local sanity check it always was —
  necessary, not sufficient, per §106). Also extended the CLI smoke it runs: per-command
  `axiom <cmd> --help` for `validate`/`explain`/`analyze`/`diff` (§57), and a
  `validate --json` invocation alongside the existing plain one.

## Preserved from alpha.1/alpha.2 (spec16pt3 §80-104, no scope creep)

No change was made to `validateGraph`, `semanticDiff`, the authorization evaluator,
dependency derivation, graph-edit semantics, `semanticFingerprint`, authority
compatibility, or the Server IR. Confirmed by the full existing regression suite remaining
green throughout this pass:

- `packages/core`: 364 tests (F1/F2 validation-totality regressions, the 1175-variant fuzz
  suite, the F3 semantic-diff-authorization regressions) — unchanged, all green.
- `packages/agent-api`: 131 tests (including the `axiom.conformance.v10` tooling suite) —
  unchanged, all green.
- `packages/server`: 697 tests (authorization adversarial/distributed matrices, workflow
  crash matrices, live-query, migrations) — unchanged, all green.
- Full fast-tier workspace suite: **1661 tests, 0 failures**, re-run after every
  substantive change in this pass.
- **Contract identifiers explicitly unchanged**: Server IR `axiom.server.v9`, authorization
  runtime `axiom.authz.v3`, tooling conformance `axiom.conformance.v10` — no bump, because
  nothing in this pass touches execution or analysis semantics (spec16pt3 §98-102).

## Local packaging verification performed this session (all read-only or scratch-local; no publish)

```text
npm run release:pack     → 8/8 tarballs built, including @cynodia/axiom-cli
npm run release:verify   → 8/8 packages ok (structure, files, license, no forbidden paths)
node scripts/consumer-test.mjs        → fresh temp-dir install from local tarballs;
                                          type-checks, runs; axiom --help / per-command
                                          --help / validate (+--json) / explain --json /
                                          analyze --json / diff --json all succeed;
                                          materialization gate (axiom-ui removed) passes
npm run release:probe    → facade discoverability intact (30 docs, 179 references, all
                                          three AI entry points route to AGENT_REFERENCE.md)
```

Additionally, as described above, this session performed genuine **registry** reads (no
writes) against the already-published `0.16.0-alpha.2` set to establish ground truth before
deciding what pt3 actually needed to fix.

## What remains — explicitly not done in this session

**Actual publication of `0.16.0-alpha.3` was not performed.** `npm publish` is a real,
externally-visible, materially irreversible action against a public registry under the
`cynodia` npm account — exactly the class of action this session's operating rules require
explicit user confirmation for before executing, independent of how mechanically ready the
tooling is. Everything that can be prepared, verified and tested *without* that action has
been (above). Once the user confirms, the remaining sequence is exactly
`scripts/publish.mjs`'s existing nine-step flow (version check → pre-release-suffix check →
clean-tree check → `npm whoami` check → `release:prepare` → publish each tarball in
dependency order, skipping any already at this exact version → **the new registry-backed
verification** → dist-tag report), run via `npm run release:publish`.

After a real publish, still outstanding before the milestone can freeze (spec16pt3 §111-113,
§146, unchanged from the spec's own requirements — none of this is newly discovered scope):

- The corrective external preflight (§111): registry lookup, install, `--help`, per-command
  help, JSON invocation, CLI-AgentAPI parity, documentation consistency — against the real
  published `0.16.0-alpha.3`, not local tarballs.
- The full preserved blind external campaign (§112-113) — a targeted CLI-only rerun does
  not satisfy freeze; this requires a genuine separate blind evaluation this session cannot
  itself conduct, as was true for alpha.1 and alpha.2.

Until that campaign returns `D1 / E1 / S1` against the actually-published `0.16.0-alpha.3`,
per spec16pt3 §166 the milestone status remains:

```text
Axiom 0.16 — Tooling / Explainability / AI Authoring
E1 VALIDATED
S1 VALIDATED
D1 PENDING
SEMANTIC TOOLING CONTRACT NOT FROZEN
```

## Test counts (net new/changed, this pass)

- `packages/demo`: 1 test broadened (`documentation.test.ts`'s CLI-unpublished-claim check
  now covers `PACKAGE_READMES`/`facadeEntryPoints` and a wider phrase match).
- `scripts/`: `verify-registry.mjs` (new), `publish.mjs` (+registry-verification step),
  `consumer-test.mjs` (+`--from-registry`, +4 CLI smoke invocations), `package.json`
  (+2 npm scripts: `release:verify-registry`, `release:consumer-test-registry`).
- No changes to any `packages/*/src` file — this pass is packaging/documentation/release-
  tooling only, per spec16pt3's own scope discipline (§15-16).
