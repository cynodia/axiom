# Axiom 0.16pt3 Specification
## Published CLI Completion, Documentation Consistency & Final 0.16 Freeze Candidate

**Target:** `0.16.0-alpha.3`  
**Baseline:** `0.16.0-alpha.2`  
**Milestone:** Axiom 0.16 — Tooling / Explainability / AI Authoring  
**Corrective release:** `spec16pt3`  
**Server IR:** `axiom.server.v9` — unchanged  
**Authorization runtime:** `axiom.authz.v3` — unchanged  
**Tooling conformance:** `axiom.conformance.v10` — unchanged  
**Required external verdict:** `D1 / E1 / S1`  
**Intended outcome:** final 0.16 freeze candidate

---

# 1. Alpha.2 external validation result

Blind external validation of:

```text
@cynodia/*@0.16.0-alpha.2
```

returned:

```text
D2 / E1 / S1

376 / 377 checks passed
zero open release-blocking findings

NOT YET FULLY EXTERNALLY VALIDATED
DO NOT FREEZE
```

This is an improvement from alpha.1:

```text
alpha.1: D2 / E1 / S3
alpha.2: D2 / E1 / S1
```

The safety axis is now externally validated.

The expressibility axis remains externally validated.

The only incomplete axis is discoverability.

---

# 2. Alpha.1 blocker closure

The three HIGH release-blocking defects discovered in alpha.1 were re-tested against published alpha.2 and confirmed closed.

---

# 3. F1 closure — non-array operations

Alpha.1:

```text
ActionDef.operations = {}
```

caused a native exception from `validateGraph`.

Alpha.2:

```text
same malformed input
→ structured validation failure
→ no native exception
```

F1 is CLOSED.

---

# 4. F2 closure — null operation target

Alpha.1:

```text
SetOperation.target = null
```

caused a native exception from `validateGraph`.

Alpha.2:

```text
same malformed input
→ structured validation failure
→ no native exception
```

F2 is CLOSED.

---

# 5. Validation fuzz closure

The exact alpha.1 deterministic 500-variant fuzz seed changed from:

```text
alpha.1:
73 native crashes

alpha.2:
0 native crashes
```

The validation-totality corrective is therefore externally confirmed.

---

# 6. F3 closure — ReadPolicy semantic diff

Alpha.1:

```text
detach QueryDef.readPolicyId
```

produced only:

```text
query
```

classification.

Alpha.2 correctly produces:

```text
query
authorization
```

F3 is CLOSED.

---

# 7. Alpha.2 safety result

The external campaign therefore established:

```text
S1
```

with:

```text
zero open release-blocking findings
```

This result MUST be preserved by pt3.

---

# 8. Alpha.2 expressibility result

The external campaign retained:

```text
E1
```

The 0.16 semantic tooling model is sufficiently expressive for the required inspection, explanation, authorization, diff, authoring and graph-edit scenarios.

This result MUST be preserved by pt3.

---

# 9. Remaining discoverability result

The external campaign retained:

```text
D2
```

because the CLI required by spec16 was advertised as published but was not actually available to a fresh consumer from the public package registry.

---

# 10. F-CLI-PACKAGE-NOT-PUBLISHED

Alpha.2 shipped documentation advertising:

```text
@cynodia/axiom-cli
```

with commands including:

```text
explain
analyze
diff
inspect
validate
build
serve
```

but an external registry lookup/install returned:

```text
404 / package unavailable
```

This is a real public-contract gap.

Severity:

```text
MEDIUM
```

Safety blocker:

```text
NO
```

0.16 freeze blocker:

```text
YES
```

because spec16 requires the CLI for D1.

---

# 11. F-DOC-CLI-INCONSISTENT

Published alpha.2 documentation contradicts itself.

One shipped surface advertises a published CLI.

Another shipped surface states:

```text
There is no published CLI
```

Severity:

```text
LOW
```

Safety blocker:

```text
NO
```

Discoverability defect:

```text
YES
```

This must also be corrected before D1.

---

# 12. Purpose of pt3

0.16pt3 is intentionally narrow.

Its primary purpose is:

```text
make the already-implemented CLI genuinely available
to a fresh external consumer
```

and make all published documentation agree with that reality.

---

# 13. Primary pt3 invariant

After publication of alpha.3:

```text
A fresh external consumer can discover, install and execute
the documented Axiom CLI using only public published artifacts.
```

---

# 14. Secondary pt3 invariant

Every shipped statement about CLI availability must agree.

There must be no contradiction between:

```text
README
AGENT_REFERENCE
AGENT_API
package README
package metadata
CLI help
release documentation
```

---

# 15. Scope discipline

pt3 is a packaging/discoverability corrective.

It SHOULD NOT modify:

```text
runtime execution semantics
authorization semantics
workflow semantics
query semantics
distributed authority semantics
live-query semantics
validation semantics
semanticDiff semantics
AgentAPI analysis semantics
graph-edit semantics
semantic fingerprint semantics
authority compatibility semantics
```

unless a new defect is independently discovered.

---

# 16. No feature expansion

Do not use pt3 as an opportunity to add unrelated tooling features.

The goal is:

```text
publish what alpha.2 already claims exists
```

not:

```text
redesign the CLI
```

---

# 17. Version

The corrective release is:

```text
0.16.0-alpha.3
```

All coordinated packages that follow the monorepo release version MUST be updated consistently.

---

# 18. CLI package identity

The canonical package is:

```text
@cynodia/axiom-cli
```

unless the project intentionally changes the public package name before alpha.3 publication.

If the package name changes, every published reference must change atomically.

There must be exactly one canonical documented identity.

---

# 19. Registry availability

After release:

```text
@cynodia/axiom-cli@0.16.0-alpha.3
```

MUST be retrievable from the same public npm registry used by external Axiom consumers.

---

# 20. Registry is authoritative

Internal evidence such as:

```text
npm pack
local tarball
workspace execution
release dry-run
local npm link
```

does NOT satisfy this requirement.

The actual registry is the publication boundary.

---

# 21. Fresh consumer installation

The following conceptual operation must succeed in a fresh directory:

```text
npm install @cynodia/axiom-cli@0.16.0-alpha.3
```

using no:

```text
workspace links
repository paths
local tarballs
symlinks
NODE_PATH overrides
```

---

# 22. Exact-version installation

Validation MUST use the exact version:

```text
0.16.0-alpha.3
```

Do not rely on:

```text
latest
next
alpha
```

dist-tags to prove availability.

---

# 23. Package metadata

The published package MUST contain correct npm metadata for:

```text
name
version
files
bin
dependencies
license
repository where applicable
```

---

# 24. Package version

From the installed package:

```text
package.json.version
```

must report:

```text
0.16.0-alpha.3
```

---

# 25. CLI executable

The published package MUST expose an executable through npm's standard:

```text
bin
```

mechanism.

---

# 26. Canonical executable name

The intended command SHOULD be:

```text
axiom
```

if that is the current implementation contract.

If another executable name is intentionally used, all documentation and tests must use that exact name.

---

# 27. Fresh executable resolution

After normal npm installation, a consumer must be able to invoke the CLI using standard npm executable resolution, for example:

```text
npx axiom --help
```

or the exact documented equivalent.

No repository-specific bootstrap is allowed.

---

# 28. CLI help root

Required:

```text
axiom --help
```

Expected:

```text
exit 0
human-readable command overview
```

---

# 29. Required command discoverability

Root help must make the supported command surface discoverable.

At minimum the currently advertised command set must be represented consistently:

```text
explain
analyze
diff
inspect
validate
build
serve
```

if these remain public alpha.3 commands.

---

# 30. No phantom commands

A command MUST NOT appear in published documentation or root help unless the installed published package can actually execute it.

---

# 31. Command help

Each public command SHOULD support:

```text
axiom <command> --help
```

with:

```text
exit 0
```

and sufficient information to discover required arguments/options.

---

# 32. Machine-readable tooling commands

Commands corresponding to semantic tooling SHOULD support:

```text
--json
```

where spec16 requires machine-readable output.

At minimum ensure parity for the semantic tooling surfaces actually exposed by:

```text
explain
analyze
diff
inspect
validate
```

as applicable.

---

# 33. `validate --json`

Alpha.2 implementation work reportedly added:

```text
validate --json
```

This MUST be present in the actually published alpha.3 package.

---

# 34. Valid CLI validation

Given a valid supported graph input:

```text
axiom validate ... --json
```

must:

```text
exit 0
produce parseable JSON
report valid result
```

---

# 35. Invalid CLI validation

Given an invalid graph:

```text
axiom validate ... --json
```

must:

```text
exit nonzero
produce structured machine-readable diagnostics
not expose a native stack as the primary contract
```

---

# 36. Validation totality through CLI

The two historical alpha.1 crash shapes MUST remain safe through any CLI path that validates them:

```text
ActionDef.operations = {}
SetOperation.target = null
```

Expected:

```text
structured invalid result
no native exception
```

---

# 37. CLI semantic diff

The published CLI must expose the canonical semantic diff if `diff` is advertised.

It MUST NOT implement a second independent diff interpretation.

---

# 38. ReadPolicy regression through CLI

For:

```text
G1:
QueryDef.readPolicyId = P

G2:
QueryDef.readPolicyId = absent
```

CLI machine output MUST identify:

```text
authorization
```

as a diff category.

---

# 39. CLI authorization semantics

If the CLI exposes authorization explanation, its structured result must derive from the same canonical AgentAPI/evaluator path.

No alternate CLI authorization evaluator.

---

# 40. CLI-AgentAPI parity

For overlapping operations:

```text
AgentAPI result
CLI --json result
```

must be semantically equivalent after normalization of transport/presentation wrappers.

---

# 41. CLI is a renderer/consumer

Required architecture remains:

```text
CLI
 ↓
canonical public tooling / AgentAPI
 ↓
semantic graph
```

Not:

```text
CLI
 ↓
independent semantic implementation
```

---

# 42. CLI side-effect freedom

Static commands such as:

```text
explain
analyze
diff
inspect
validate
```

must not:

```text
mutate application state
write provider data
start workflows
create effects
consume events
advance scheduler state
```

---

# 43. `build` semantics

If `build` is publicly advertised, its meaning must be documented sufficiently to distinguish it from runtime semantic execution.

It must not be silently conflated with:

```text
validate
deploy
execute
```

---

# 44. `serve` semantics

If `serve` is publicly advertised, its trust/security boundary must be documented.

Publishing a `serve` command MUST NOT accidentally imply that deep AgentAPI inspection is safe to expose unauthenticated in production.

---

# 45. Security boundary preservation

The original 0.16 invariant remains:

```text
authoring permission != deployment permission
inspection capability != runtime authority
explanation != authorization token
```

The CLI must preserve these distinctions.

---

# 46. README requirement

`@cynodia/axiom-cli` MUST ship a README in its actual published tarball.

---

# 47. CLI README minimum content

The README must identify:

```text
package purpose
installation
executable name
command overview
machine-readable mode
basic examples
relationship to AgentAPI
```

---

# 48. LICENSE requirement

The CLI package must contain the intended license metadata/file consistently with the rest of the published Axiom packages.

---

# 49. `files` publication list

The npm package `files` configuration must include all runtime-required CLI artifacts and documentation.

It must not accidentally omit:

```text
compiled executable
support modules
README
required schemas/assets
```

---

# 50. No repository dependency

Inspect the published tarball/install.

The CLI must not require:

```text
../../packages/*
workspace:*
local file:
absolute repository path
unpublished build output
```

at runtime.

---

# 51. Published dependency closure

Every runtime dependency required by the CLI must itself be resolvable by a fresh public consumer.

---

# 52. Release pipeline integration

The release pipeline MUST treat:

```text
@cynodia/axiom-cli
```

as a real published package.

---

# 53. Release dry-run

Before actual publication, release tooling SHOULD verify:

```text
CLI included in package set
version correct
not private
tarball valid
bin present
```

---

# 54. Publication verification

After npm publish, the release process MUST perform a registry-backed verification.

Do not declare success immediately after the publish command returns.

---

# 55. Registry-backed verification

Required verification includes:

```text
registry lookup succeeds
exact version exists
fresh install succeeds
CLI executable resolves
--help exits 0
```

---

# 56. Consumer smoke

A clean consumer smoke test MUST install the CLI from the registry, not from the workspace.

---

# 57. Consumer smoke minimum

Run:

```text
install exact alpha.3
axiom --help
axiom validate --help
axiom explain --help
axiom analyze --help
axiom diff --help
```

plus representative JSON invocation.

---

# 58. Publication failure is release failure

If the CLI publish step fails or registry verification returns 404:

```text
0.16.0-alpha.3 release is incomplete
```

Do not publish/document the remaining package set as a successful pt3 candidate and proceed to freeze.

---

# 59. Atomic release expectation

Where practical, coordinated alpha.3 packages should become publicly available as one coherent release set.

If registry publication cannot be atomic, verification must ensure the complete set exists before announcing the candidate.

---

# 60. Documentation consistency objective

After alpha.3, a search across every shipped documentation artifact for CLI availability must yield a coherent answer:

```text
A published CLI exists.
```

---

# 61. Remove stale negative claims

Remove or update statements equivalent to:

```text
There is no published Axiom CLI.
No CLI is currently published.
CLI is planned but unavailable.
```

where they refer to current alpha.3 state.

---

# 62. `AGENT_REFERENCE.md`

The shipped:

```text
docs/AGENT_REFERENCE.md
```

must no longer contradict the published CLI.

---

# 63. Main README

The main Axiom README must describe CLI availability consistently with the actual registry state.

---

# 64. AgentAPI documentation

AgentAPI docs should make the relationship clear:

```text
AgentAPI = canonical programmatic semantic tooling
CLI = command-line consumer/renderer of that tooling
```

---

# 65. No documentation fork

Documentation must not imply that CLI and AgentAPI define separate semantic contracts.

---

# 66. Version documentation

Where current package version is stated, update to:

```text
0.16.0-alpha.3
```

as appropriate.

---

# 67. Server IR documentation

Known stale references to:

```text
axiom.server.v7
```

must not survive if they claim to describe the current alpha.3 Server IR.

Current:

```text
axiom.server.v9
```

---

# 68. Tooling conformance documentation

Current tooling conformance remains:

```text
axiom.conformance.v10
```

---

# 69. Authorization runtime documentation

Where relevant:

```text
axiom.authz.v3
```

remains the current authorization evaluator compatibility generation.

---

# 70. Documentation tarball verification

Documentation consistency must be checked against the files actually present in the published npm tarballs.

Checking repository HEAD alone is insufficient.

---

# 71. Documentation search gate

Before publication, search published-package candidates for phrases such as:

```text
no published CLI
CLI unavailable
planned CLI
server.v7
```

and review every occurrence.

---

# 72. Contradiction gate

There must be zero known cases where two current shipped documents make incompatible claims about:

```text
CLI availability
CLI package name
CLI executable name
Server IR version
tooling conformance version
```

---

# 73. D1 is external

Internal publication scripts reporting success do not establish D1.

D1 requires that a blind external consumer can actually find and use the package.

---

# 74. Discoverability test

A fresh evaluator should be able to answer:

```text
Does Axiom have a CLI?
What npm package provides it?
How do I install it?
What command do I run?
What semantic tooling commands exist?
How do I request JSON?
```

using only shipped public artifacts.

---

# 75. Expected answers

Expected:

```text
Yes.

Package:
@cynodia/axiom-cli

Install:
public npm registry

Executable:
axiom

Machine output:
--json where supported
```

subject to the final documented command syntax.

---

# 76. No maintainer knowledge

The evaluator must not need:

```text
repository access
implementation report
release script source
maintainer explanation
private package registry
```

to discover the CLI.

---

# 77. D1 package navigation

The main Axiom package/docs SHOULD provide a clear route to:

```text
@cynodia/axiom-cli
```

so a consumer does not have to guess the package name.

---

# 78. D1 help navigation

Once installed:

```text
axiom --help
```

must provide sufficient navigation to the command surface.

---

# 79. D1 JSON navigation

The consumer should be able to discover `--json` from:

```text
help
README
or command documentation
```

without source inspection.

---

# 80. E1 preservation

pt3 must not regress any alpha.2 expressibility result.

Required final:

```text
E1
```

---

# 81. S1 preservation

pt3 must not regress any alpha.2 safety result.

Required final:

```text
S1
```

---

# 82. Validation totality preservation

Repeat exact alpha.1 crash regressions.

Required:

```text
0 native exceptions
```

---

# 83. Fuzz preservation

Repeat the exact external 500-variant seed.

Required:

```text
0 native crashes
```

---

# 84. Expanded internal fuzz preservation

The internal pt2 suite reported:

```text
1175 variants
0 exceptions
```

This or a superset must remain green.

---

# 85. Semantic diff preservation

Repeat ReadPolicy detach:

```text
categories includes authorization
```

---

# 86. ReadPolicy predicate preservation

Changes to a `ReadPolicyDef` predicate must continue to produce a semantic diff entry classified as authorization-relevant.

---

# 87. Authorization agreement preservation

Repeat the alpha.2 authorization-decision agreement matrix.

At minimum preserve the externally established cases covering:

```text
constant public
positive role
neq deny-list
NOT(eq) deny-list
anonymous
attribute-less principal
legacy authorization
new policy
legacy ∧ policy
```

Required:

```text
0 mismatches
```

---

# 88. Explanation remains advisory

The prior non-token test remains required:

```text
explain ALLOW
change relevant principal/resource context
invoke
runtime reauthorizes
```

No cached grant.

---

# 89. Candidate edits preservation

Repeat:

```text
valid add
policy attachment
invalid reference
wrong-kind reference
dangling removal
stale precondition
original graph immutability
prototype-pollution attempt
```

No regression.

---

# 90. NativeOperation preservation

Required:

```text
opaque boundary remains explicit
analysisComplete = false
```

where static analysis cannot see through NativeOperation.

---

# 91. Secret hygiene preservation

Run sentinel-secret checks over both:

```text
AgentAPI
CLI
```

Required:

```text
0 disclosures
```

---

# 92. CLI secret hygiene

CLI errors, JSON output and human output must not print:

```text
raw credential
token
secret
private provider value
```

merely because it is present in authorization context or host exceptions.

---

# 93. Determinism preservation

AgentAPI deterministic outputs remain unchanged.

CLI `--json` output must also be semantically deterministic.

---

# 94. CLI determinism

Run representative CLI JSON analysis repeatedly.

After normalizing explicitly non-semantic fields, required:

```text
one semantic result
```

---

# 95. Side-effect preservation

Static CLI operations must join the existing zero-side-effect tooling invariant.

---

# 96. Side-effect counters

Run:

```text
explain
analyze
inspect
diff
validate
```

against instrumented graph/runtime where applicable.

Required:

```text
state_mutation = 0
provider_mutation = 0
effect_creation = 0
workflow_start = 0
event_consumption = 0
scheduler_mutation = 0
revision_advance = 0
```

---

# 97. Conformance preservation

All existing:

```text
axiom.conformance.v10
```

fixtures must pass.

---

# 98. No conformance version bump

Publishing the CLI does not create new graph execution or AgentAPI semantic meaning.

Therefore:

```text
axiom.conformance.v10
```

remains unchanged.

---

# 99. No Server IR bump

pt3 does not change application execution semantics.

Therefore:

```text
axiom.server.v9
```

remains unchanged.

---

# 100. No authorization runtime bump

pt3 does not change authorization evaluation.

Therefore:

```text
axiom.authz.v3
```

remains unchanged.

---

# 101. No semantic fingerprint change

For the same graph:

```text
semanticFingerprint(alpha.2)
==
semanticFingerprint(alpha.3)
```

---

# 102. No authority compatibility change

The CLI publication state is tooling infrastructure.

It MUST NOT alter authority compatibility for an application graph.

---

# 103. Mixed alpha.2/alpha.3 runtime

Where alpha.2 and alpha.3 runtime packages differ only by pt3 tooling/release changes, existing authority compatibility behavior should remain unchanged.

No new runtime discriminator should be introduced for CLI publication.

---

# 104. Package-set consistency

Check every coordinated `@cynodia/*` package in the alpha.3 consumer.

Unexpected mixture of:

```text
alpha.2
alpha.3
```

should be flagged unless explicitly allowed by package dependency semantics.

---

# 105. Internal implementation gate

Before publication:

```text
all fast tests green
all package tests green
all relevant integration tests green
all tooling conformance tests green
fuzz green
CLI local-pack smoke green
```

---

# 106. Local pack is preflight only

A successful:

```text
npm pack
```

is necessary but not sufficient.

The historical alpha.2 defect was specifically:

```text
implementation says published
actual registry says 404
```

pt3 must test the real boundary.

---

# 107. Publication sequence

Recommended release sequence:

```text
1. version coordinated packages to alpha.3
2. build
3. test
4. pack
5. inspect tarballs
6. publish packages
7. query registry
8. create completely fresh consumer
9. install exact published versions
10. run CLI smoke
11. only then mark alpha.3 ready for external validation
```

---

# 108. Post-publish registry gate

Do not begin the blind campaign until:

```text
npm registry lookup for @cynodia/axiom-cli@0.16.0-alpha.3
```

succeeds from a clean external context.

---

# 109. Exact F-CLI reproduction

Preserve alpha.2 reproduction:

```text
lookup/install @cynodia/axiom-cli@0.16.0-alpha.2
→ unavailable / 404
```

Then alpha.3:

```text
lookup/install @cynodia/axiom-cli@0.16.0-alpha.3
→ success
```

This is required closure evidence.

---

# 110. Exact documentation reproduction

Preserve alpha.2 evidence showing contradictory claims.

For alpha.3:

```text
all current shipped docs agree CLI is published
```

---

# 111. Corrective external preflight

Before full campaign, run a small external preflight:

```text
CLI registry lookup
CLI install
CLI --help
CLI command help
CLI JSON invocation
CLI-AgentAPI parity
documentation consistency
```

If any fails, stop.

Do not spend time on the full campaign until D1 corrective preflight is green.

---

# 112. Full campaign still required

After corrective preflight, run the complete preserved 0.16 blind external campaign.

A targeted CLI-only rerun is insufficient for freeze.

---

# 113. Why full rerun remains required

pt3 SHOULD be packaging-only, but freeze is a statement about the published alpha.3 artifact set.

The final candidate itself must demonstrate:

```text
D1
E1
S1
```

---

# 114. Harness preservation

Copy the alpha.2 external harness unchanged before adding pt3 tests.

Conceptually:

```text
alpha.2 harness snapshot
       ↓ copy
alpha.3 harness
       +
CLI publication regression tests
```

---

# 115. Do not weaken alpha.2 assertions

All alpha.2 successful assertions remain.

Do not change expected behavior to accommodate alpha.3.

---

# 116. Alpha.1 lineage regressions remain

Keep:

```text
non-array operations
null operation target
ReadPolicy detach classification
```

permanently in the campaign.

---

# 117. Alpha.2 lineage regressions added

Add permanent checks for:

```text
CLI package actually published
CLI documentation consistent
```

---

# 118. Fresh consumer requirement

The alpha.3 external harness must be created/run in a fresh consumer environment using published packages only.

---

# 119. No repository source

Blind evaluator MUST NOT use:

```text
repository source
implementation report
internal tests
release script source
maintainer explanation
```

for verdict determination.

---

# 120. Published docs are evidence

The evaluator SHOULD inspect documentation from the actual installed package tarballs.

This is especially important for closing:

```text
F-DOC-CLI-INCONSISTENT
```

---

# 121. Registry metadata is evidence

Record:

```text
resolved package version
registry package metadata
installed package.json
bin mapping
dependency tree
```

for the CLI.

---

# 122. CLI execution evidence

Persist raw output for:

```text
axiom --help
axiom explain --help
axiom analyze --help
axiom diff --help
axiom inspect --help
axiom validate --help
axiom build --help
axiom serve --help
```

for every command actually advertised as public.

---

# 123. CLI JSON evidence

Persist representative machine outputs from:

```text
explain --json
analyze --json
diff --json
validate --json
```

where supported.

---

# 124. CLI parity evidence

For at least:

```text
semantic explanation
semantic diff
validation
```

compare CLI structured output with corresponding canonical programmatic API behavior.

---

# 125. CLI malformed-input evidence

Run the historical malformed shapes through the CLI path where feasible.

Required:

```text
structured error
nonzero exit
no crash
```

---

# 126. Documentation consistency evidence

Search the installed alpha.3 artifact set for relevant terms:

```text
CLI
published CLI
no published CLI
axiom-cli
server.v7
server.v9
```

Record results.

---

# 127. D1 checklist

Final D1 requires all of:

```text
[ ] AgentAPI public entry point discoverable
[ ] machine contract/version discoverable
[ ] inventory discoverable
[ ] dependencies discoverable
[ ] explainability discoverable
[ ] capabilities discoverable
[ ] NativeOperation analysis discoverable
[ ] authorization-decision analysis discoverable
[ ] semantic diff discoverable
[ ] authoring schema discoverable
[ ] graph edits discoverable
[ ] diagnostics discoverable
[ ] CLI discoverable
[ ] CLI actually installable
[ ] conformance v10 discoverable
[ ] missing-security-field semantics documented
[ ] Server IR v9 discoverable
```

The exact checklist count may follow the canonical external harness, but no required item may remain unresolved.

---

# 128. D1 package criterion

A documented package that returns registry 404 does NOT count as discoverable tooling.

It is absent.

---

# 129. D1 documentation criterion

Contradictory current documentation prevents D1 if a fresh consumer cannot reliably determine the public contract.

---

# 130. E1 checklist preservation

Every alpha.2 E1 capability must remain:

```text
StateDef analysis
ActionDef analysis
QueryDef analysis
WorkflowDef analysis
authorization analysis
legacy authorization analysis
ReadPolicy analysis
workflow policy analysis
provider capability analysis
NativeOperation opacity
direct/reverse/transitive dependencies
semantic diff
authoring metadata
candidate edit
atomic edit set
precondition conflict
structured diagnostics
```

---

# 131. S1 checklist preservation

Required:

```text
[ ] validation totality
[ ] zero authorization-decision mismatches
[ ] zero dependency security false negatives
[ ] zero semanticDiff security false negatives
[ ] zero invalid edit acceptance
[ ] zero stale silent overwrite
[ ] zero hidden NativeOperation boundaries
[ ] zero secret disclosure
[ ] zero analysis side effects
[ ] zero material nondeterminism
[ ] malformed public input contained
[ ] frozen runtime semantics preserved
```

---

# 132. CLI-specific forbidden counters

Add:

```text
cli_package_registry_missing
cli_install_failure
cli_bin_missing
cli_help_failure
cli_documentation_contradiction
cli_agentapi_semantic_mismatch
cli_json_parse_failure
cli_native_exception
cli_secret_disclosure
cli_analysis_side_effect
```

All required:

```text
0
```

---

# 133. Existing forbidden counters

Carry forward every alpha.2 forbidden counter.

No previously green safety counter may be dropped.

---

# 134. Explicit counters

Every required counter must appear in final machine-readable evidence.

Missing counter does not mean zero.

---

# 135. Finding closure — CLI package

`F-CLI-PACKAGE-NOT-PUBLISHED` may be marked CLOSED only if:

```text
@cynodia/axiom-cli@0.16.0-alpha.3
```

is retrieved and installed from the public registry by the blind external consumer.

---

# 136. Finding closure — documentation

`F-DOC-CLI-INCONSISTENT` may be marked CLOSED only if the installed alpha.3 artifact set contains no contradictory current claims about CLI publication status.

---

# 137. No source-based closure

Neither finding can be closed merely because repository source has been corrected.

The published artifacts are authoritative.

---

# 138. New finding handling

If the CLI becomes published but exposes a new semantic/safety defect, record it normally.

Publication success does not override safety.

---

# 139. Example new blocker

If:

```text
axiom diff --json
```

disagrees with AgentAPI about authorization classification, that is a new release-blocking semantic-fidelity finding even though D1 is fixed.

---

# 140. Example non-blocker

A typo in:

```text
axiom --help
```

may be LOW/non-blocking if it does not materially impair discoverability or machine semantics.

---

# 141. Freeze verdict is multidimensional

Do not replace:

```text
D / E / S
```

with pass percentage.

Required:

```text
D1 / E1 / S1
```

---

# 142. Pass percentage cannot waive D1

Even:

```text
99.9% checks passed
```

is insufficient if the published CLI remains unavailable.

---

# 143. Safety remains categorical

Any new release-blocking safety finding forces:

```text
S3
DO NOT FREEZE
```

regardless of D1 closure.

---

# 144. Expressibility remains categorical

Any regression that makes required semantic tooling unrepresentable forces loss of:

```text
E1
```

---

# 145. Expected alpha.3 result

Target:

```text
Axiom 0.16.0-alpha.3

External validation:
  D1 / E1 / S1

All alpha.1 blockers:
  CLOSED

Alpha.2 CLI package finding:
  CLOSED

Alpha.2 CLI documentation finding:
  CLOSED

Open release-blocking findings:
  0

Open freeze-blocking contract gaps:
  0

EXTERNALLY VALIDATED
FREEZE RECOMMENDED
```

---

# 146. Freeze gate

Axiom 0.16 may freeze after alpha.3 only if:

```text
[ ] CLI package exists in public registry
[ ] exact alpha.3 CLI installs in fresh consumer
[ ] executable resolves
[ ] CLI help works
[ ] documented commands exist
[ ] JSON tooling works where required
[ ] CLI and AgentAPI agree
[ ] shipped docs agree on CLI availability

[ ] F1 remains closed
[ ] F2 remains closed
[ ] F3 remains closed

[ ] D1
[ ] E1
[ ] S1

[ ] all forbidden counters zero
[ ] no open release-blocking findings
[ ] no open freeze-blocking contract gaps
[ ] full published-package blind campaign complete
```

---

# 147. Internal implementation status before external validation

After implementation but before registry-backed blind validation, the strongest allowed status is:

```text
Axiom 0.16.0-alpha.3

CLI publication corrective implemented
internal tests green
release candidate published

EXTERNAL VALIDATION REQUIRED
0.16 CONTRACT NOT FROZEN
```

Do not declare D1 from internal evidence.

---

# 148. Registry-backed preflight status

After successful external registry/install smoke but before full campaign:

```text
CLI publication gap appears closed
full external campaign pending
```

Still do not freeze.

---

# 149. Successful final status

After full campaign returns D1/E1/S1:

```text
Axiom 0.16 — Tooling / Explainability / AI Authoring

Validated version:
  0.16.0-alpha.3

Server IR:
  axiom.server.v9

Authorization runtime:
  axiom.authz.v3

Tooling conformance:
  axiom.conformance.v10

External verdict:
  D1 / E1 / S1

EXTERNALLY VALIDATED
SEMANTIC TOOLING CONTRACT FROZEN
```

---

# 150. Relationship to stable 0.16.0

Successful alpha.3 validation establishes the contract intended for:

```text
0.16.0
```

A stable release may then package the frozen contract without semantic changes.

If stable packaging changes public behavior, perform appropriate release verification before treating it as equivalent.

---

# 151. No `0.16.1` corrective before freeze

This work remains part of:

```text
0.16.0-alpha.*
```

because the 0.16 contract has not yet been frozen as stable.

---

# 152. Corrective lineage

Historical lineage should record:

```text
0.16.0-alpha.1
  D2 / E1 / S3
  ↓
  validation totality defects
  ReadPolicy semanticDiff defect
  CLI absent

0.16.0-alpha.2
  D2 / E1 / S1
  ↓
  validation defects CLOSED
  semanticDiff defect CLOSED
  CLI implemented/documented but not actually published
  shipped documentation contradictory

spec16pt3
  ↓

0.16.0-alpha.3
  ↓
  publish CLI for real
  align published docs
  preserve E1/S1
  full blind rerun
  ↓

target:
  D1 / E1 / S1
```

---

# 153. Architecture interpretation

The alpha.2 result does NOT justify redesigning 0.16.

External evidence already supports:

```text
authorization explanation correctness
validation totality
semantic diff security correctness
candidate-edit safety
NativeOperation opacity
secret hygiene
determinism
side-effect freedom
tooling conformance
```

pt3 should therefore minimize semantic churn.

---

# 154. Change budget

Preferred pt3 changes are limited to:

```text
package publication metadata
release pipeline
registry verification
consumer smoke
CLI packaging defects
CLI help/JSON packaging defects if discovered
documentation consistency
version updates
tests directly required to prove publication
```

---

# 155. Changes requiring reconsideration

If implementation of pt3 unexpectedly requires modification of:

```text
authorization evaluator
semanticDiff core
validateGraph semantics
dependency derivation
graph-edit semantics
semanticFingerprint
authority compatibility
Server IR
```

stop treating pt3 as a packaging-only corrective.

Document why the semantic change is required and broaden external validation accordingly.

---

# 156. Release-pipeline invariant

A package described by the release as published MUST be externally resolvable before the release is considered complete.

This should become a general Axiom release invariant, not merely a one-off CLI fix.

---

# 157. Recommended general publication check

For every intended public package:

```text
expectedPackages
  ↓
publish
  ↓
registry query exact version
  ↓
fresh install
```

and assert:

```text
publishedPackages == expectedPackages
```

---

# 158. Registry lag handling

If the registry has normal propagation delay, release verification may retry for a bounded documented interval.

It must not silently convert persistent 404 into success.

---

# 159. Publication retry safety

Retry logic must not accidentally publish a different version or create inconsistent package versions.

Exact version identity must remain:

```text
0.16.0-alpha.3
```

---

# 160. Dist-tag independence

The freeze campaign should install exact versions.

A wrong or delayed dist-tag is a separate release-quality issue but must not obscure whether the exact alpha.3 artifact exists.

---

# 161. Tarball reality principle

The semantic/public contract seen by external users is:

```text
what is actually in the installed package
```

not:

```text
what repository HEAD intended to publish
```

This principle applies equally to:

```text
code
schemas
README
docs
package metadata
bin entries
```

---

# 162. Final D1 invariant

The following sequence must work for someone with no Axiom repository access:

```text
discover Axiom CLI
        ↓
identify @cynodia/axiom-cli
        ↓
install exact public package
        ↓
run axiom --help
        ↓
discover semantic tooling commands
        ↓
run machine-readable analysis
```

---

# 163. Final E1 invariant

The CLI publication corrective must not reduce the already validated ability to represent and analyze every required 0.16 semantic case.

---

# 164. Final S1 invariant

The CLI must expose the validated semantic tooling safely rather than create a new path around it.

In particular:

```text
CLI explanation == canonical explanation
CLI diff == canonical semanticDiff
CLI validation == canonical validation
CLI analysis has zero semantic side effects
```

---

# 165. Final pt3 invariant

The gap between:

```text
"the framework says a CLI exists"
```

and:

```text
"a fresh external consumer can actually install and use it"
```

must be zero.

---

# 166. Final milestone rule

Until the published alpha.3 blind campaign returns:

```text
D1 / E1 / S1
```

the milestone remains:

```text
Axiom 0.16 — Tooling / Explainability / AI Authoring

E1 VALIDATED
S1 VALIDATED
D1 PENDING

SEMANTIC TOOLING CONTRACT NOT FROZEN
```

After successful alpha.3 validation:

```text
Axiom 0.16 — Tooling / Explainability / AI Authoring

D1 / E1 / S1
EXTERNALLY VALIDATED
SEMANTIC TOOLING CONTRACT FROZEN
```

Then proceed to:

```text
Axiom 0.17 — Independent Runtime + Cross-runtime Conformance
```