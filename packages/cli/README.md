# Axiom CLI

Part of [Axiom](https://github.com/cynodia/axiom), an AI-native semantic web application
framework.

**Status: experimental / alpha.** The API may change between alpha releases.

**AI agents:** read `docs/AGENT_REFERENCE.md` and `docs/AGENT_API.md` inside the installed
`@cynodia/axiom` package before authoring or inspecting an application. This tool is a thin
renderer over that package's `AgentAPI` — it implements no semantic analysis of its own
(spec16pt2 §53).

## Installation

```bash
npm install --global @cynodia/axiom-cli
# or, without installing:
npx @cynodia/axiom-cli --help
```

This installs the `axiom` executable. Every command takes a **compiled** (built) JavaScript
module — `<modelFile>` — that exports an `ApplicationGraph`, or a function that builds one
(`export function createGraph() { … }`, `export default …`); pass `--export=<name>` when a
module exports more than one candidate.

## Commands

```text
axiom build    <modelFile> [--export=name]
axiom inspect  <modelFile> [--export=name]
axiom validate <modelFile> [--export=name] [--json]
axiom serve    <modelFile> [--export=name] [--port=3000] [--store=state.db]

axiom schema status  <modelFile> [--export=name]
axiom schema diff    <modelFile> --against=<prevFile> [--export=name] [--against-export=name]
axiom migrate plan   <modelFile> [--export=name] [--from=<version>]
axiom migrate        <modelFile> [--export=name] [--from=<version>] [--approve=op1,op2] [--sqlite=<path>]
axiom migrate status <modelFile> --sqlite=<path>

axiom explain <action|query|workflow|state> <id> <modelFile> [--json]
axiom analyze <modelFile> [--json]
axiom diff    <modelFile> --against=<prevFile> [--export=name] [--against-export=name] [--json]

axiom --help
```

`explain`, `analyze` and `diff` are the canonical tooling surface spec16 defines
(`docs/AGENT_API.md`'s "Semantic inventory, dependencies and explanation" section):

- **`explain`** renders `AgentAPI.explainAction` / `.explainQuery` / `.explainWorkflow` /
  `.explainState` for one node — reads/writes, authorization, invokers, live capability,
  and (for actions) whether static analysis is complete or a `NativeOperation` boundary
  prevents it.
- **`analyze`** renders a structural graph summary, required runtime capabilities, the
  `NativeOperation` inventory and the authorization coverage audit
  (`AgentAPI.explainGraph` / `.analyzeCapabilities` / `.summarizeNativeOperations` /
  `.analyzeAuthorization`).
- **`diff`** renders `AgentAPI.semanticDiff` between two graphs: every categorized change
  (`semantic` / `authorization` / `schema` / `provider` / `workflow` / `query` /
  `presentation` / `metadata`) and the compatibility impact — does it move
  `semanticFingerprint`, `schemaFingerprint`, or the required Server IR contract. An
  authorization-relevant change (attaching, detaching or editing a policy — including a
  `QueryDef`'s row-level `readPolicyId`) is always tagged `authorization`, in addition to
  its own category, never in place of it.

## Machine-readable output

Pass `--json` on `explain`, `analyze`, `diff` or `validate` for structured output —
parseable, deterministic, and (for `explain`/`analyze`/`diff`) semantically identical to
the corresponding `AgentAPI` result (no human terminal decoration reaches `--json` mode).
Everything else prints a concise human-readable rendering.

**`--json` also governs failure, not only success.** Every CLI-owned error path — an
unknown node id, a missing required flag, a model file that will not load, an unparseable
command line — emits one JSON value on stdout instead of prose, and never a native stack
trace:

```json
{
  "ok": false,
  "error": {
    "code": "UNKNOWN_NODE",
    "message": "No action node \"foo\" in this graph"
  }
}
```

`error.code` is one of `INVALID_ARGUMENTS`, `UNKNOWN_COMMAND`, `UNKNOWN_NODE`,
`MISSING_ARGUMENT`, `MODEL_LOAD_FAILED` or `COMMAND_FAILED` (an uncategorized failure).
Match on `code`, never on `message` — the same discipline as every other structured
diagnostic in Axiom. Exit code is always nonzero on failure, in `--json` mode and out of
it. Without `--json`, error text is unchanged prose on stderr (or, for a handful of
pre-existing "not found"-style results, stdout — see the source), exactly as before.

## Exit codes

```text
0        the requested operation completed (including a successful `explain`/`analyze`/`diff`,
         and `validate` on a graph that is valid)
nonzero  invalid input, an invalid graph (`validate`), or a tooling failure
```

`--help` (or no arguments) always prints usage and exits `0`.

## Side effects

`explain`, `analyze`, `diff`, `inspect` and `validate` are read-only static analysis: they
load the graph and never invoke an action, start a workflow, create an effect or write
persistence. `build` writes a compiled HTML file to `./dist`; `migrate` (without `--sqlite`)
only plans and prints — it executes only when given `--sqlite=<path>`; `serve` starts a real
HTTP server and, if the graph has server authority, a real authoritative runtime.

## Scope

This is a development and inspection tool, not a production hosting mechanism. Publishing
it does not imply exposing `AgentAPI` over an unauthenticated network endpoint — `serve`'s
own semantic endpoint is the only network surface any command opens, and only when asked to
`serve` in the first place.
