# Axiom 0.16pt2 Specification
## Validation Totality, Security-Diff Completeness & CLI Completion

**Target:** `0.16.0-alpha.2`  
**Baseline:** `0.16.0-alpha.1`  
**Milestone:** Axiom 0.16 — Tooling / Explainability / AI Authoring  
**Corrective release:** `spec16pt2`  
**Server IR:** `axiom.server.v9` — unchanged  
**Tooling conformance:** `axiom.conformance.v10` — extended, contract id unchanged unless the public machine contract itself must change  
**External validation:** full blind 0.16 campaign rerun required  
**Target verdict:** `D1 / E1 / S1`

---

# 1. Alpha.1 external validation result

Blind external validation of:

```text
@cynodia/*@0.16.0-alpha.1
```

returned:

```text
D2 / E1 / S3

377 checks
372 passed
98.7%

NOT EXTERNALLY VALIDATED
DO NOT FREEZE
```

Three HIGH release-blocking defects were confirmed.

---

# 2. Confirmed alpha.1 blockers

## F1 — malformed `ActionDef.operations` crashes `validateGraph`

Malformed graph:

```text
ActionDef.operations = non-array
```

causes a native exception:

```text
TypeError:
(action.operations ?? []).some is not a function
```

instead of a structured validation result.

---

# 3. F2 — null operation target crashes `validateGraph`

Malformed operation:

```text
SetOperation.target = null
```

causes a native exception:

```text
TypeError:
Cannot read properties of null (reading 'kind')
```

instead of a structured validation result.

---

# 4. F1/F2 systemic evidence

A seeded 500-variant malformed-input campaign reproduced the same two underlying crash classes:

```text
73 / 500 variants
```

This establishes that the problem is not merely two isolated test cases.

The affected invariant is:

```text
validateGraph must be total over malformed public graph input.
```

---

# 5. F3 — `semanticDiff` misses authorization classification

Removing:

```text
QueryDef.readPolicyId
```

correctly causes:

```text
semanticFingerprintChanged = true
authorityCompatibilityAffected = true
```

but the corresponding semantic diff entry is classified only as:

```text
query
```

and not:

```text
authorization
```

A security-review consumer filtering:

```text
entries[].categories.includes("authorization")
```

can therefore miss removal of row-level authorization.

This is release blocking.

---

# 6. Discoverability gap

The alpha.1 campaign also returned:

```text
D2
```

because no published Axiom CLI exists even though spec16 includes the CLI as part of the required tooling/discoverability surface.

The absence was honestly documented and therefore was not an obscurity problem.

It remains a specification-completeness gap.

0.16pt2 closes this gap.

---

# 7. Purpose

0.16pt2 is a narrow corrective release.

It MUST close:

```text
F1  validateGraph non-array operation collection crash
F2  validateGraph null operation target crash
F3  semanticDiff authorization classification gap
D2  missing published CLI
```

without redesigning the 0.16 semantic tooling model.

---

# 8. Non-goals

0.16pt2 does NOT introduce:

```text
new application semantics
new graph vocabulary
new authorization semantics
new query semantics
new workflow semantics
new distributed semantics
new provider semantics
new Server IR execution semantics
new AgentAPI conceptual architecture
```

It hardens and completes the already-defined 0.16 contract.

---

# 9. Primary corrective invariants

After pt2:

```text
1. Public validation never crashes on malformed graph structure that
   falls within the accepted public input boundary.

2. Every supported authorization-bearing graph change is classified
   as authorization-relevant by semanticDiff.

3. The documented CLI surface is actually published and usable by a
   fresh external consumer.

4. Frozen 0.15 runtime semantics and successful 0.16 alpha.1 tooling
   semantics remain unchanged.
```

---

# 10. Validation totality principle

`validateGraph` is a boundary from:

```text
untrusted / malformed candidate graph representation
```

to:

```text
structured semantic diagnostics
```

It MUST NOT assume that TypeScript compile-time types have already guaranteed graph shape.

This is particularly important because 0.16 explicitly supports:

```text
AI-generated candidate graphs
serialized graphs
external tooling
graph edits
machine-generated structures
```

---

# 11. Public validation boundary

Any value accepted by the public validation entry point at runtime must result in one of:

```text
valid graph result
structured invalid graph result
structured validation error
```

It MUST NOT result in:

```text
uncaught TypeError
uncaught RangeError
uncaught implementation exception
process crash
partial semantic mutation
```

for ordinary malformed input.

---

# 12. TypeScript types are not validation

The implementation MUST NOT rely on:

```text
ActionDef.operations: Operation[]
```

as proof that runtime input is actually an array.

Equivalent principle applies recursively to nested graph structures.

---

# 13. F1 required fix

Before any operation traversal such as:

```text
.some(...)
.map(...)
.forEach(...)
for ... of
```

the relevant collection shape must be safely established.

For malformed:

```text
operations = {}
operations = "foo"
operations = 123
operations = null
operations = true
```

validation must fail structurally.

No native exception.

---

# 14. F1 diagnostic

The exact diagnostic code is implementation-defined unless an existing canonical code applies.

It MUST be:

```text
structured
stable
machine-readable
associated with the malformed ActionDef/path
```

Recommended concept:

```text
INVALID_OPERATION_COLLECTION
```

or a more general existing structural diagnostic.

Do not expose a JavaScript `TypeError` as the validation contract.

---

# 15. Null operations collection

If:

```text
operations = null
```

is semantically equivalent to absent/empty under the existing graph contract, preserve that behavior.

If it is invalid, reject structurally.

pt2 MUST NOT accidentally redefine optionality merely to harden traversal.

---

# 16. F2 required fix

Operation validation MUST establish target shape before traversing:

```text
target.kind
target.*
```

For:

```text
target = null
```

return a structured invalid result.

No native exception.

---

# 17. F2 sibling operation audit

Do not patch only `SetOperation`.

Audit every operation kind that carries a target/location or nested operation collection.

At minimum inspect all currently supported equivalents of:

```text
set
insert
remove
update
for-each
conditional/nested operations
```

using the actual current Axiom operation vocabulary.

---

# 18. Null-target matrix

For every operation kind requiring a target, test:

```text
target = null
target = undefined
target = {}
target = primitive
target = malformed semantic object
```

Expected:

```text
structured invalid result
```

unless a particular value is explicitly valid by current semantics.

---

# 19. Nested operation collection audit

Any operation kind containing child operations must be tested with:

```text
operations = null
operations = {}
operations = string
operations = number
operations = array with malformed child
operations = array containing null
```

No native exceptions.

---

# 20. Recursive validation order

Validation MUST establish structural safety before semantic traversal.

Conceptually:

```text
shape validation
    ↓
safe traversal
    ↓
reference validation
    ↓
semantic validation
```

The implementation need not literally use separate passes.

The invariant is that later stages cannot dereference malformed structures before earlier shape checks have made traversal safe.

---

# 21. No blanket exception wrapper as primary fix

Forbidden primary solution:

```text
try {
  existing unsafe validateGraph(...)
} catch {
  return INVALID_GRAPH
}
```

A top-level containment boundary MAY exist as defense in depth.

It MUST NOT replace structural validation of known malformed shapes.

The returned diagnostics should retain useful semantic/path information where possible.

---

# 22. Defensive containment

Even after structural hardening, a final public-boundary containment mechanism MAY be used to ensure unexpected malformed structures cannot escape as native exceptions.

If implemented, it must:

```text
fail closed
return structured diagnostic
avoid secret/stack leakage
avoid mutation
```

But known malformed structures must have deterministic specific handling.

---

# 23. Validation side-effect invariant

Malformed graph validation MUST NOT:

```text
mutate graph
mutate runtime state
write persistence
invoke providers
create effects
start workflows
consume events
```

---

# 24. Validation totality scope

pt2 MUST audit at least the structures directly reachable from the two alpha.1 crash paths.

It SHOULD also inspect adjacent high-risk graph traversal code for the same pattern:

```text
assumed array
assumed object
assumed non-null reference
assumed expression shape
assumed operation shape
```

---

# 25. Required fuzz expansion

The alpha.2 internal suite MUST include a deterministic malformed-input fuzz/adversarial tier.

Minimum:

```text
1,000 generated malformed variants
```

across representative graph/operation shapes.

This is not probabilistic security fuzzing.

It is deterministic structural mutation testing.

---

# 26. Required fuzz mutation classes

At minimum:

```text
field deletion
null substitution
undefined substitution where representable
wrong primitive type
object-for-array
array-for-object
unknown kind
empty object
empty array
malformed nested child
null nested child
dangling semantic reference
wrong semantic reference kind
duplicate semantic id
invalid expression node
invalid location
invalid operation target
invalid nested operations collection
```

---

# 27. Fuzz seed reproducibility

Fuzz/adversarial generation MUST use a recorded deterministic seed.

Failures must be independently reproducible from:

```text
seed
mutation index
serialized candidate
```

---

# 28. Fuzz success criterion

For every malformed candidate:

```text
structured rejection
documented invalid result
```

is acceptable.

Forbidden:

```text
uncaught native exception
process termination
silent semantic acceptance of invalid structure
side effect
```

---

# 29. Fuzz valid controls

The fuzz suite must include valid controls.

Do not accidentally create a validator that rejects everything.

Representative known-valid graphs must continue to return:

```text
valid = true
```

---

# 30. Fuzz error diversity

The suite SHOULD assert that multiple malformed classes produce meaningful diagnostics rather than every case collapsing into one generic:

```text
INVALID_GRAPH
```

where structural provenance is reasonably available.

---

# 31. Validation totality regression fixture

Add conformance/tooling fixture(s) covering at least:

```text
non-array ActionDef.operations
null operation target
```

if malformed-input behavior belongs in the public conformance contract.

If malformed fixtures are intentionally outside conformance-v10 fixture shape, maintain equivalent published/public tests and document the boundary.

---

# 32. F3 semantic principle

`semanticDiff` exists so external tooling can reason about changes in application meaning.

Authorization classification must therefore include every change that modifies:

```text
who may observe
who may invoke
who may mutate
who may inspect
who may control
```

semantic resources or operations.

---

# 33. ReadPolicyDef is authorization semantics

`ReadPolicyDef` controls row-level observation.

Therefore:

```text
attach ReadPolicyDef
detach ReadPolicyDef
change ReadPolicyDef
change reference to ReadPolicyDef
```

are authorization-semantic changes.

They MUST be classified:

```text
authorization
```

in addition to other applicable categories such as:

```text
query
```

---

# 34. F3 required behavior

For:

```text
G1:
QueryDef Q
readPolicyId = P

G2:
QueryDef Q
readPolicyId = absent
```

required diff entry includes:

```text
query
authorization
```

or equivalent canonical multi-category representation.

---

# 35. Reverse F3 case

For:

```text
G1:
readPolicyId = absent

G2:
readPolicyId = P
```

required:

```text
authorization
```

classification.

Security classification must be symmetric.

---

# 36. ReadPolicy replacement

For:

```text
readPolicyId = P1
```

changed to:

```text
readPolicyId = P2
```

required:

```text
authorization
```

classification.

---

# 37. ReadPolicy definition mutation

If the `ReadPolicyDef` node itself changes while the QueryDef reference remains stable, semantic diff must classify the policy definition change as:

```text
authorization
```

---

# 38. Canonical authorization-surface audit

pt2 MUST audit every current authorization-bearing surface.

At minimum:

```text
ActionDef.authorization
ActionDef.authorizationPolicy

QueryDef.authorizationPolicy
QueryDef.readPolicyId / ReadPolicyDef

WorkflowDef.startPolicy
WorkflowDef.instanceAccessPolicy

AuthorizationPolicyDef.allow
ReadPolicyDef predicate/expression
```

plus any other current public authorization-bearing graph fields.

---

# 39. Required authorization-diff matrix

For each authorization surface test:

```text
attach
detach
replace
modify referenced policy definition
```

where structurally applicable.

Every meaning-changing case must contain:

```text
authorization
```

classification.

---

# 40. Multiple diff categories

A diff entry MAY correctly belong to multiple categories.

Example:

```text
QueryDef.readPolicyId detached

categories:
  query
  authorization
```

Do not force mutually exclusive categories.

---

# 41. Authorization classification must be semantic

Do not classify authorization changes solely through field-name substring matching.

Forbidden architecture:

```text
if fieldName.includes("authorization") => authorization
```

That is exactly how fields such as:

```text
readPolicyId
```

can be missed.

---

# 42. Preferred authorization classification source

Prefer one canonical definition of authorization-bearing semantic surfaces reused by:

```text
semanticDiff
AgentAPI authorization analysis
dependency derivation
semantic fingerprint projection where appropriate
authority compatibility analysis where appropriate
```

The exact implementation structure is not normative.

The semantic classification must not drift independently.

---

# 43. Do not derive diff classification from fingerprint alone

A changed fingerprint tells tooling:

```text
meaning changed
```

but not:

```text
authorization changed
```

Therefore fingerprint comparison alone is insufficient.

The diff engine needs semantic provenance.

---

# 44. Diff false-negative invariant

For any authorization-semantic graph change `Δ`:

```text
authorizationChanged(Δ)
```

implies:

```text
"authorization" ∈ semanticDiff(G, G + Δ).categories
```

where the public diff model exposes categories.

---

# 45. Diff false-positive control

Changing only:

```text
presentation metadata
source metadata
non-security descriptive metadata
```

must NOT be classified as authorization.

---

# 46. Query semantic control

Changing:

```text
sort
limit
presentation-only query metadata
```

must not become authorization merely because the node is a QueryDef.

---

# 47. Security review use case

A consumer MUST be able to safely implement:

```text
securityChanges =
  diff.entries.filter(
    e => e.categories.includes("authorization")
  )
```

and receive every authorization-semantic change represented by the graph.

This is a normative 0.16 use case.

---

# 48. Compatibility cross-check

For authorization diff cases:

```text
semanticDiff classification
semanticFingerprint impact
authorityCompatibility impact
```

must be mutually coherent.

Not every authorization change necessarily has identical compatibility consequences, but contradictions must be explainable by frozen rules.

---

# 49. Diff identity

Retain:

```text
semanticDiff(G, G)
```

=> no semantic changes.

---

# 50. Diff symmetry

For security change:

```text
diff(G1, G2)
diff(G2, G1)
```

must both identify authorization relevance.

Attach/detach direction must not alter security classification.

---

# 51. CLI completion objective

0.16 alpha.1 implemented public AgentAPI tooling but did not publish the CLI required by spec16.

pt2 MUST publish a usable CLI over the canonical AgentAPI.

---

# 52. Required CLI commands

At minimum provide equivalents of:

```text
axiom explain
axiom analyze
axiom diff
```

The exact binary/package invocation MAY follow existing project packaging conventions.

The shipped documentation must provide exact usage.

---

# 53. CLI architecture

The CLI is a renderer/consumer of canonical public tooling APIs.

It MUST NOT implement independent semantic analysis logic.

Conceptually:

```text
CLI
  ↓
AgentAPI / canonical tooling
  ↓
semantic graph
```

Forbidden:

```text
CLI-specific authorization evaluator
CLI-specific diff engine
CLI-specific dependency derivation
```

---

# 54. CLI machine output

Each relevant CLI command MUST support:

```text
--json
```

or equivalent documented machine-readable mode.

---

# 55. CLI JSON requirements

Machine output must be:

```text
parseable
deterministic
structured
semantically equivalent to corresponding AgentAPI output
```

Human terminal decoration must not pollute JSON mode.

---

# 56. CLI explain

CLI must support explaining at least representative:

```text
ActionDef
QueryDef
WorkflowDef
StateDef
graph
```

where the AgentAPI supports those explanations.

---

# 57. CLI analyze

CLI must expose useful canonical analyses, including enough to discover:

```text
inventory
dependencies
capabilities
NativeOperation boundaries
authorization/security information
```

Exact subcommand structure is implementation-defined.

---

# 58. CLI diff

CLI must accept two supported graph inputs and render:

```text
semanticDiff
```

including categories and compatibility impact.

---

# 59. CLI security diff

For the F3 regression:

```text
detach QueryDef.readPolicyId
```

CLI JSON diff must include:

```text
authorization
```

exactly as AgentAPI does.

---

# 60. CLI invalid input

Malformed graph input must result in:

```text
structured JSON diagnostic in --json mode
nonzero exit
```

No native stack trace as the primary machine contract.

---

# 61. CLI human mode

Human-readable output may be concise and formatted.

Its exact wording/layout is NOT part of frozen semantic meaning.

---

# 62. CLI exit semantics

Document and test at minimum:

```text
0 = successful requested operation
nonzero = invalid input / validation failure / tooling failure
```

If more detailed exit codes are exposed, document them.

---

# 63. CLI discoverability

A fresh consumer must be able to determine from published artifacts:

```text
which executable to run
available commands
input format
--json behavior
exit behavior
```

without repository access.

---

# 64. CLI help

At minimum:

```text
axiom --help
axiom explain --help
axiom analyze --help
axiom diff --help
```

or equivalent command hierarchy must succeed.

---

# 65. CLI package publication

The CLI executable must actually be present in the published package's:

```text
bin
```

or equivalent npm executable metadata.

Documentation of a non-published command does not satisfy D1.

---

# 66. CLI fresh-install test

Create a clean consumer.

Install published alpha.2.

Invoke CLI using documented npm/node mechanism.

No repository path may be required.

---

# 67. CLI-AgentAPI parity

For the same graph and analysis:

```text
normalize(CLI --json)
==
normalize(AgentAPI result)
```

semantically.

Presentation wrapper fields may differ if documented.

---

# 68. No CLI privilege

CLI analysis must remain side-effect free.

Running:

```text
explain
analyze
diff
```

must not execute application operations.

---

# 69. No production endpoint implication

Publishing a CLI does not imply exposing AgentAPI through an unauthenticated production network endpoint.

The spec16 trust boundary remains unchanged.

---

# 70. Server IR remains v9

pt2 introduces no new execution semantics.

Therefore:

```text
axiom.server.v9
```

remains the expected Server IR contract.

---

# 71. `requiredServerContractForGraph`

Existing alpha.1 behavior remains.

Tooling-only semantics must not force:

```text
axiom.server.v10
```

---

# 72. Conformance remains v10

The tooling conformance contract remains:

```text
axiom.conformance.v10
```

unless correcting the defects genuinely requires a breaking machine-contract change.

Preferred:

```text
extend v10 fixtures
do not bump identifier
```

for these corrective semantics.

---

# 73. Conformance additions

Add fixtures/tests covering at minimum:

```text
ReadPolicy attach authorization diff
ReadPolicy detach authorization diff
ReadPolicy replace authorization diff
```

and appropriate validation-totality fixtures if supported by the conformance format.

---

# 74. Existing conformance preservation

All alpha.1:

```text
13 / 13
```

tooling fixtures must remain green.

No expectation weakening.

---

# 75. AgentAPI contract preservation

Existing successful alpha.1 APIs remain semantically compatible unless a blocker cannot otherwise be fixed.

In particular preserve:

```text
inventory
dependencies
explain
capabilities
native-operations
authorization-decision
graph-edit
authoring-schema
semantic-diff
```

---

# 76. Authorization decision evaluator unchanged

The alpha.1 external campaign obtained:

```text
175 / 175
```

agreement between:

```text
explainAuthorizationDecision
live runtime authorization
```

pt2 MUST NOT change authorization decision semantics.

---

# 77. F1 authorization regressions remain closed

New policy:

```text
PRINCIPAL.role != "banned"
```

anonymous:

```text
DENY
```

---

# 78. F1-legacy remains closed

Legacy:

```text
ActionDef.authorization =
  PRINCIPAL.role != "banned"
```

anonymous:

```text
DENY
```

---

# 79. Constant-public control

Explicit:

```text
literal(true)
```

must continue to allow where frozen semantics say it does.

Do not harden malformed validation by changing authorization behavior.

---

# 80. F2 authorization validation remains closed

Malformed:

```text
AuthorizationPolicyDef.allow
```

continues to return:

```text
AUTHORIZATION_INVALID_POLICY
```

or canonical equivalent.

---

# 81. F3 authentication boundary remains closed

Throwing:

```text
host.authenticate()
```

continues to produce:

```text
AUTHORIZATION_DENIED
reason = authentication-error
```

with no mutation or credential leak.

---

# 82. Candidate graph edit preservation

Alpha.1 candidate edit behavior was externally clean.

Preserve:

```text
valid add
atomic policy attachment
invalid reference rejection
wrong-kind reference rejection
dangling removal rejection
precondition conflict
original graph immutability
prototype-pollution resistance
```

---

# 83. Candidate validation now benefits from totality

Candidate graph edits can produce malformed runtime shapes through:

```text
external tools
AI generation
deserialization
manual tampering
```

Therefore the F1/F2 totality correction is directly part of the AI-authoring safety model.

---

# 84. Malformed candidate edit

If an edit creates:

```text
ActionDef.operations = {}
```

candidate validation must return structured invalid result.

No crash.

---

# 85. Null target candidate edit

If edit creates:

```text
operation.target = null
```

candidate validation must return structured invalid result.

No crash.

---

# 86. Original graph preservation on malformed candidate

Even if candidate validation fails:

```text
original graph
```

must remain unchanged.

---

# 87. NativeOperation behavior unchanged

Alpha.1 externally confirmed:

```text
analysisComplete = false
```

when NativeOperation prevents complete static analysis.

pt2 MUST preserve this.

---

# 88. Secret hygiene unchanged

All tooling and CLI outputs must preserve zero disclosure of:

```text
credentials
tokens
provider secrets
sentinel secrets
```

---

# 89. Determinism unchanged

Existing AgentAPI deterministic output remains required.

New validation diagnostics and CLI JSON must also be deterministic for identical input.

---

# 90. Dependency derivation unchanged

Alpha.1 externally confirmed corrected edges:

```text
WorkflowDef → ActionDef
WorkflowDef → EventDef
authorization-bearing node → AuthorizationPolicyDef
```

pt2 must preserve them.

---

# 91. Dependency false-negative counter

Must remain:

```text
0
```

---

# 92. Diff classification centralization test

Create a mechanically enumerated list of every authorization-bearing surface.

For each:

```text
mutate it
run semanticDiff
assert authorization category
```

The test list SHOULD derive from a canonical authorization-surface descriptor if one exists.

---

# 93. Future auth-surface drift prevention

Where practical, add a test asserting that every semantic field identified by authorization analysis has corresponding semantic-diff authorization classification behavior.

The goal is to prevent future additions from recreating F3.

---

# 94. Validation traversal audit test

Where practical, enumerate all operation kinds and automatically inject malformed:

```text
target
operations
location
expression
```

fields according to their shape.

This should prevent another operation kind from retaining the same F1/F2 defect.

---

# 95. No arbitrary JS escape

None of the corrective changes may introduce raw JS callbacks into:

```text
validation
semantic diff classification
CLI analysis
authoring metadata
```

Semantic tooling remains portable.

---

# 96. Machine-readable diagnostics

The two formerly crashing shapes must now produce diagnostics usable by an AI authoring client.

At minimum the client must be able to determine:

```text
candidate invalid
location/path of malformed field
stable diagnostic category/code
```

---

# 97. Diagnostic prose not frozen

Exact human error text need not be frozen.

Tests should primarily assert:

```text
code
path
severity
structured metadata
```

where available.

---

# 98. Diagnostic totality

If malformed input prevents precise semantic identity determination, a broader structured diagnostic is acceptable.

Native exception is not.

---

# 99. CLI diagnostic parity

CLI `--json` should expose the same underlying diagnostic codes as AgentAPI/core validation.

Do not translate them into CLI-only error taxonomies without preserving canonical code.

---

# 100. Internal alpha.2 preflight

Before publication, run focused tests:

```text
F1 exact reproduction
F2 exact reproduction
F3 exact reproduction
F3 reverse attach
F3 replacement
all auth-surface diff matrix
operation sibling malformed matrix
1,000+ malformed fuzz variants
CLI fresh-package smoke
CLI-AgentAPI parity
```

All must pass.

---

# 101. F1 exact reproduction gate

Input:

```text
ActionDef.operations = {}
```

Expected:

```text
no throw
valid = false
structured diagnostic
```

---

# 102. F2 exact reproduction gate

Input:

```text
SetOperation.target = null
```

Expected:

```text
no throw
valid = false
structured diagnostic
```

---

# 103. F3 exact reproduction gate

Input:

```text
G1 QueryDef.readPolicyId = P
G2 QueryDef.readPolicyId = absent
```

Expected:

```text
semanticDiff entry categories contains:
  query
  authorization
```

---

# 104. F3 compatibility gate

Same graph pair must continue to report appropriate:

```text
semanticFingerprintChanged
authorityCompatibilityAffected
```

No regression in compatibility analysis.

---

# 105. F3 CLI gate

Run same graph pair through:

```text
axiom diff ... --json
```

Expected security classification matches AgentAPI.

---

# 106. Full internal suite

After focused preflight:

```text
all package unit tests
all integration tests
all conformance tiers
all soak tests
```

must pass.

---

# 107. Existing environmental real-process flake

The previously observed real-8-process environmental flake may remain classified as environmental only if:

```text
same failure signature
isolated rerun passes
no semantic invariant violation
no correlation with pt2 changes
```

Record it explicitly.

Do not silently ignore a changed failure signature.

---

# 108. Release package verification

Before external campaign:

```text
pack
verify
probe
consumer-test
```

or current equivalents must pass.

---

# 109. Version

All coordinated packages intended to move together must report:

```text
0.16.0-alpha.2
```

No stale alpha.1 package in the published consumer set unless intentionally independent and documented.

---

# 110. Documentation updates

Update shipped docs to reflect:

```text
0.16.0-alpha.2
CLI availability
CLI commands
--json
exit behavior
validation totality
semanticDiff authorization classification
Server IR v9
conformance v10
```

---

# 111. Stale server README

The alpha.1 external campaign observed a stale server README claiming:

```text
axiom.server.v7
```

while current contract is:

```text
axiom.server.v9
```

pt2 SHOULD correct this documentation defect.

It was non-blocking in alpha.1, but there is no reason to carry known contradictory documentation into a D1-targeting corrective release.

---

# 112. Dependency multiplicity documentation

Alpha.1 observed that:

```text
getDependencies()
getDependents()
```

may return multiple edges to the same semantic node when distinct provenance edges exist.

If this is intentional, document explicitly:

```text
results are dependency edges, not a deduplicated node set
```

Do not change semantics merely to satisfy intuition unless the public contract actually requires deduplication.

---

# 113. Workflow timer follow-up

Alpha.1 workflow timer completion was inconclusive rather than failed.

pt2 SHOULD add a deterministic documented runtime regression test for the relevant timer/due-work polling mechanism if practical.

This is not a pt2 release blocker unless a real frozen workflow regression is reproduced.

---

# 114. External campaign requirement

Because pt2 modifies:

```text
validateGraph
semanticDiff
published tooling surface
```

a full external 0.16 campaign rerun is required.

Targeted testing alone is insufficient for freeze.

---

# 115. Harness preservation

The alpha.1 blind harness MUST be copied unchanged before adding alpha.2-specific regression tests.

Conceptually:

```text
alpha1 harness snapshot
        ↓ copy
alpha2 harness
        +
corrective tests
```

Do not rewrite previous expectations.

---

# 116. Exact alpha.1 reproductions retained

Keep permanent tests for:

```text
non-array operations
null operation target
ReadPolicy detachment classification
```

These become lineage regressions.

---

# 117. Broader validation rerun

Re-run every alpha.1 validation/diagnostic/fuzz test against alpha.2.

Increase malformed coverage around sibling operation structures.

---

# 118. Broader semantic diff rerun

Re-run every alpha.1 semantic diff case plus the full authorization-surface matrix.

---

# 119. Authorization agreement rerun

Repeat the alpha.1:

```text
11 actions × 5 principals
175-check authorization-decision-agreement matrix
```

or equivalent unchanged matrix.

Required:

```text
0 mismatches
```

---

# 120. Candidate edit rerun

Repeat all alpha.1 candidate edit tests.

Add malformed operation candidate cases.

---

# 121. NativeOperation rerun

Repeat opacity tests.

Required:

```text
opaque_boundary_hidden = 0
```

---

# 122. Secret-hygiene rerun

Run sentinel secret checks over:

```text
AgentAPI
CLI
diagnostics
validation
authorization explanation
```

Required:

```text
0 disclosures
```

---

# 123. Determinism rerun

Repeat deterministic analysis calls and include:

```text
validation diagnostic determinism
CLI --json determinism
```

---

# 124. Conformance rerun

Run all published:

```text
axiom.conformance.v10
```

fixtures.

Expected:

```text
100% PASS
```

---

# 125. Runtime preservation rerun

Repeat representative frozen runtime semantics:

```text
actions
queries
authorization
workflows
live
distributed
```

0.16pt2 remains tooling-only.

---

# 126. Real-process stage

Run at least the scaled 0.16 external real-process smoke:

```text
1 authority
2 authorities
8 authorities
cross-principal race
workflow failover
live failover
rolling deployment
```

Given alpha.1 skipped the full multi-process stage, alpha.2 freeze validation SHOULD complete this gap rather than carrying it into freeze.

---

# 127. Real-process authorization

No tooling change may affect:

```text
axiom.authz.v3
```

runtime semantics.

Required:

```text
unauthorized commits = 0
```

---

# 128. Mixed-build behavior

Because no execution semantics change between alpha.1 and alpha.2, authority compatibility SHOULD remain governed by existing frozen keys.

Do not introduce a new runtime semantic discriminator merely for:

```text
validator behavior
semanticDiff behavior
CLI availability
```

unless execution meaning actually changes.

---

# 129. semanticFingerprint

For the same graph:

```text
semanticFingerprint(alpha.1)
==
semanticFingerprint(alpha.2)
```

because pt2 changes tooling/validation behavior, not graph meaning.

---

# 130. Server IR

Required:

```text
axiom.server.v9
```

No v10 bump.

---

# 131. Authorization runtime

Required:

```text
axiom.authz.v3
```

unchanged.

---

# 132. Tooling contract

Expected:

```text
axiom.conformance.v10
```

unchanged.

If the public AgentAPI result schema itself must break to fix pt2, explicitly version the affected tooling contract rather than silently changing it.

No such break is expected.

---

# 133. External D1 requirement

The alpha.2 fresh consumer must discover:

```text
AgentAPI
machine contract/version
inventory
dependencies
explainability
capabilities
NativeOperation analysis
authorization decision analysis
semantic diff
authoring schema
graph edits
diagnostics
published CLI
conformance v10
missing-security-field semantics
Server IR v9
```

Required:

```text
16 / 16
```

---

# 134. External E1 requirement

All alpha.1 E1 cases must remain expressible.

Required:

```text
E1
```

No reduction in authoring/tooling capability to fix safety bugs.

---

# 135. External S1 requirement

Required:

```text
F1 closed
F2 closed
F3 closed

validateGraph native crashes = 0
semanticDiff security false negatives = 0
authorization explanation mismatches = 0
invalid edit acceptance = 0
stale silent overwrite = 0
opaque boundary hidden = 0
secret disclosure = 0
analysis side effects = 0
material nondeterminism = 0
runtime regression = 0
```

---

# 136. New forbidden counters

Ensure explicit counters include:

```text
validate_graph_native_exception
operation_collection_native_exception
operation_target_native_exception

read_policy_diff_missed_authorization
authorization_diff_false_negative

cli_agentapi_semantic_mismatch
cli_native_crash
cli_invalid_input_zero_exit
```

All:

```text
0
```

---

# 137. Existing forbidden counters

Carry forward every alpha.1 forbidden counter.

Do not delete counters simply because they passed previously.

---

# 138. Counter explicitness

Final campaign output must explicitly contain every counter.

Missing counter != zero.

---

# 139. Fuzz result reporting

External report must record:

```text
number of variants
seed(s)
native exception count
structured rejection count
unexpected acceptance count
```

---

# 140. Expected F1 closure evidence

External report should show:

```text
alpha.1:
ActionDef.operations non-array
=> native TypeError

alpha.2:
same input
=> structured diagnostic
```

---

# 141. Expected F2 closure evidence

External report should show:

```text
alpha.1:
operation.target = null
=> native TypeError

alpha.2:
same input
=> structured diagnostic
```

---

# 142. Expected F3 closure evidence

External report should show:

```text
alpha.1:
detach QueryDef.readPolicyId
=> categories = [query]

alpha.2:
same diff
=> categories includes [query, authorization]
```

---

# 143. Expected D2 closure evidence

External report should show:

```text
alpha.1:
published CLI absent

alpha.2:
published CLI present
documented
--help works
--json works
fresh-consumer invocation works
```

---

# 144. Finding closure rules

A prior finding is CLOSED only if its exact alpha.1 reproduction passes against published alpha.2.

Implementation-unit tests alone are insufficient.

---

# 145. New findings

Any new release-blocking finding discovered during alpha.2 campaign results in:

```text
NOT EXTERNALLY VALIDATED
DO NOT FREEZE
```

regardless of prior finding closure.

---

# 146. Full rerun requirement

Even if focused preflight closes all four gaps:

```text
F1
F2
F3
D2
```

the complete campaign must run before freeze.

Reason:

```text
validateGraph is canonical
semanticDiff is canonical
CLI broadens public tooling exposure
```

---

# 147. No pass-rate override

A high aggregate pass percentage cannot override a release blocker.

Required freeze state is categorical:

```text
zero open blockers
```

---

# 148. Target campaign result

Desired:

```text
Axiom 0.16.0-alpha.2

D1 / E1 / S1

ALL REQUIRED SECTIONS GREEN
ALL FORBIDDEN COUNTERS = 0
OPEN RELEASE BLOCKERS = 0

EXTERNALLY VALIDATED
FREEZE RECOMMENDED
```

---

# 149. Implementation phases

Recommended:

```text
Phase A
Reproduce F1/F2 exactly.

Phase B
Audit operation/location traversal and harden structural validation.

Phase C
Run expanded deterministic malformed-input fuzzing.

Phase D
Reproduce F3 exactly.

Phase E
Centralize/audit authorization-diff classification.

Phase F
Run full authorization-surface semantic-diff matrix.

Phase G
Publish CLI over canonical AgentAPI.

Phase H
Update docs and known alpha.1 documentation defects.

Phase I
Run complete internal suites/conformance/soak.

Phase J
Pack/publish 0.16.0-alpha.2.

Phase K
Run focused external corrective preflight.

Phase L
Run full preserved blind external campaign.
```

---

# 150. Phase A gate

Both alpha.1 native crashes reproduced before fixing:

```text
operations non-array
target null
```

This ensures tests prove the actual finding.

---

# 151. Phase B gate

Every audited operation kind handles malformed structure without native exception.

---

# 152. Phase C gate

At least:

```text
1,000 malformed variants
0 native exceptions
0 invalid silent accepts
```

subject to correct distinction between genuinely valid mutations and invalid ones.

---

# 153. Phase D gate

Exact ReadPolicy detach false-negative reproduced before correction.

---

# 154. Phase E gate

All known authorization-bearing surfaces have canonical classification coverage.

---

# 155. Phase F gate

Authorization diff matrix:

```text
attach
detach
replace
definition mutation
```

green for every applicable surface.

---

# 156. Phase G gate

Fresh packed consumer can execute:

```text
axiom --help
axiom explain ...
axiom analyze ...
axiom diff ...
```

and machine-readable variants.

---

# 157. Phase H gate

Published docs contain no known contradiction about:

```text
Server IR current version
CLI availability
dependency edge multiplicity
```

---

# 158. Phase I gate

Required:

```text
all unit tests green
all integration tests green
conformance green
soak green
authorization agreement green
expanded fuzz green
```

---

# 159. Phase J gate

Published packages resolve coherently to:

```text
0.16.0-alpha.2
```

and no workspace source is needed.

---

# 160. Phase K gate

Fresh consumer focused reproduction:

```text
F1 PASS
F2 PASS
F3 PASS
CLI PASS
```

before spending time on full campaign.

---

# 161. Phase L gate

Full blind campaign:

```text
D1 / E1 / S1
```

or no freeze.

---

# 162. Freeze rule

Axiom 0.16 may freeze after alpha.2 only if:

```text
[ ] F1 CLOSED
[ ] F2 CLOSED
[ ] F3 CLOSED
[ ] CLI discoverability gap CLOSED

[ ] D1
[ ] E1
[ ] S1

[ ] all forbidden counters zero
[ ] no open release-blocking findings
[ ] published-package blind campaign complete
```

---

# 163. Freeze interpretation

Successful alpha.2 validation freezes the 0.16 tooling semantic contract established by spec16:

```text
semantic inventory
dependency analysis
explainability
authorization decision explanation
capability analysis
NativeOperation opacity
semantic diff
authoring schema
candidate graph edits
structured diagnostics
CLI machine-facing tooling
```

---

# 164. What pt2 does not freeze independently

pt2 does not create a separate semantic milestone.

It completes:

```text
Axiom 0.16
```

There is no separate:

```text
Axiom 0.16pt2 semantic model
```

after successful freeze.

---

# 165. Corrective lineage

Expected historical record:

```text
0.16.0-alpha.1
  ↓
D2 / E1 / S3
  ↓
F1 validateGraph operations crash
F2 validateGraph null-target crash
F3 ReadPolicy semanticDiff authorization omission
D2 published CLI absent
  ↓
spec16pt2
  ↓
0.16.0-alpha.2
  ↓
blind external rerun
  ↓
D1 / E1 / S1
```

---

# 166. Final validation invariant

After pt2, an external AI/tooling consumer must be able to safely do:

```text
construct malformed candidate
        ↓
validateGraph
        ↓
structured diagnostic
```

never:

```text
construct malformed candidate
        ↓
validateGraph
        ↓
native TypeError
```

---

# 167. Final semantic-diff invariant

For every supported authorization-bearing semantic change:

```text
G → G'
```

the public semantic diff must make the security significance discoverable through structured data.

In particular:

```text
remove QueryDef.readPolicyId
```

must never look like merely an ordinary query edit.

---

# 168. Final CLI invariant

A fresh external consumer must be able to use published Axiom tooling from the command line without repository knowledge.

The CLI must expose canonical tooling semantics.

It must not create an alternate interpretation of the graph.

---

# 169. Final compatibility invariant

Because pt2 changes tooling correctness rather than application execution meaning:

```text
Server IR              = axiom.server.v9
authorization runtime  = axiom.authz.v3
graph semantic meaning = unchanged
semanticFingerprint    = unchanged for same graph
```

No runtime compatibility discriminator bump is expected.

---

# 170. Final milestone gate

Until blind external alpha.2 validation returns:

```text
D1 / E1 / S1
```

status remains:

```text
Axiom 0.16 — Tooling / Explainability / AI Authoring

IMPLEMENTED WITH CORRECTIVE WORK
NOT EXTERNALLY VALIDATED
SEMANTIC TOOLING CONTRACT NOT FROZEN
```

After successful validation:

```text
Axiom 0.16 — Tooling / Explainability / AI Authoring

EXTERNALLY VALIDATED
D1 / E1 / S1
SEMANTIC TOOLING CONTRACT FROZEN
```

Then proceed to:

```text
Axiom 0.17 — Independent Runtime + Cross-runtime Conformance
```