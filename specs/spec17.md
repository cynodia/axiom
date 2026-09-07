# Axiom 0.17 Specification — Independent Runtime & Cross-Runtime Conformance

**Milestone:** `0.17`  
**Target:** `0.17.0-alpha.1`  
**Baseline:** frozen Axiom `0.16` semantic tooling contract  
**Validated baseline:** `0.16.0-alpha.4` — D1 / E1 / S1  
**Current Server IR:** `axiom.server.v9`  
**Authorization runtime generation:** `axiom.authz.v3`  
**Current tooling conformance:** `axiom.conformance.v10`  
**Milestone type:** semantic portability, independent execution, runtime-neutral conformance  
**Prerequisite evidence:** Axiom 0.17 Phase A Independent Implementation Challenge

---

# 1. Purpose

Axiom 0.17 establishes that Axiom application semantics are defined by public contracts rather than by the implementation details of the TypeScript reference runtime.

A conforming Axiom application must be executable by independent runtime implementations and produce equivalent observable semantic meaning.

0.17 therefore formalizes three things:

1. a runtime-independent execution contract;
2. explicit portable-runtime capability semantics;
3. a cross-runtime conformance model capable of validating independent implementations.

The milestone is primarily a **conformance milestone**, not a feature milestone.

No new application-level semantic primitive should be introduced unless required to close a contract gap discovered by independent implementation.

---

# 2. Phase A evidence

Before this specification was written, the frozen 0.16 contract was subjected to a blind independent implementation challenge.

A second runtime was implemented in Python using only public artifacts:

```text
docs/*.md
dist/*.d.ts
schema/*.json
conformance/**
README / AGENTS / llms.txt
```

The independent implementation did not inspect or reuse reference-runtime execution source.

Phase A demonstrated independent reconstruction of the portable execution core:

```text
expressions
locations
state
actions
transactions
constraints
authorization
queries
row read policies
single-authority workflows
workflow timers
principal preservation
structured malformed-IR rejection
```

Differential campaign:

```text
116 fixtures

MATCH: 79
C1 explicit unsupported: 35

confirmed independent-runtime defects: 0
confirmed reference-runtime defects:   0

specification omissions:      2
discoverability failures:     1
native crashes in independent runtime: 0
```

The 79 MATCH fixtures use specification-derived expectations rather than reference-runtime output as their golden oracle.

Phase A therefore supports the following conclusion:

> The portable Axiom execution core can be independently reconstructed in another programming language from public contracts alone.

0.17 builds on that evidence rather than restarting semantic design.

---

# 3. Primary invariant

For every portable Axiom graph `G`, controlled execution environment `E`, and pair of conforming runtimes `RA` and `RB` supporting the required semantic profile:

```text
observableMeaning(execute(G, E, RA))
==
observableMeaning(execute(G, E, RB))
```

Observable meaning is defined by Axiom semantics, not runtime implementation structure.

---

# 4. Runtime independence

A conforming runtime MUST NOT depend on the reference runtime for semantic execution.

An independent runtime MUST NOT:

```text
import reference execution modules
delegate execution to the reference runtime
invoke the reference runtime through subprocesses
use AgentAPI as an execution proxy
replay reference-runtime outputs
copy private reference algorithms as its semantic implementation
```

A runtime MAY consume public Axiom contracts, schemas, serialized IR, conformance fixtures and public tooling metadata.

---

# 5. Reference runtime is not normative

The TypeScript reference runtime is an implementation of the Axiom contract.

It is not the definition of that contract.

When:

```text
public contract specifies X
reference runtime produces Y
```

the reference runtime is defective.

When:

```text
reference runtime produces X
independent runtime produces Y
public contract does not determine which is correct
```

the contract is incomplete or ambiguous.

Cross-runtime disagreement MUST NOT automatically be resolved in favor of the reference implementation.

---

# 6. Normative authority order

Runtime semantic meaning is determined by:

```text
1. normative Axiom semantic contract
2. normative serialized IR contract
3. normative conformance specification
4. normative public semantic API/type definitions
5. explanatory documentation
```

Reference implementation behavior is evidence, not normative authority.

Where public normative artifacts conflict, the conflict is a specification defect and MUST NOT be silently resolved by implementation convention.

---

# 7. Canonical portable execution artifact

`Server IR` is the canonical serialized execution artifact for portable Axiom execution.

0.17 does not introduce a second portable execution IR.

A conforming independent runtime MUST be capable of consuming valid serialized Server IR without requiring:

```text
TypeScript source objects
builder execution
reference-runtime classes
JavaScript callbacks
host-language reflection
reference-runtime preprocessing
```

---

# 8. Server IR version

The initial 0.17 implementation MUST attempt to preserve:

```text
axiom.server.v9
```

The Server IR version MUST NOT be bumped merely because an independent runtime exists.

A new Server IR version is required only if a Phase B/C finding demonstrates that the current serialized representation cannot express or unambiguously carry required execution semantics.

Documentation clarification alone does not require an IR version bump.

---

# 9. Normalized Server IR

Executable Server IR is normalized semantic input.

Compilation is responsible for transforming authoring conveniences into the canonical executable representation required by authorities.

A conforming authority MUST NOT depend on authoring-only representation where the Server IR contract defines a normalized executable form.

---

# 10. Action guards — normative clarification

`ActionDef.guards` is an authoring-level semantic representation.

Compilation MUST lower guards into aligned executable:

```text
preconditions
failureModes
```

The executing authority evaluates the normalized:

```text
preconditions
failureModes
```

representation.

The authority does not independently execute `guards[]` in addition to the lowered representation.

This prevents duplicate evaluation and establishes one executable action lifecycle.

---

# 11. Meaning of "evaluate action guards"

Where existing documentation states:

> Action guards MUST be evaluated in declaration order.

the normative execution meaning is:

```text
actionGuards(action)
```

as represented by the normalized executable preconditions/failure modes.

The statement MUST NOT be interpreted as requiring an authority to independently evaluate both:

```text
guards[]
and
preconditions[]
```

for a normalized Server IR.

---

# 12. Guard normalization invariant

For an action containing authoring guards, compilation MUST produce an executable representation preserving their semantic meaning and declaration order.

A conformant executable Server IR MUST NOT contain guard semantics that are absent from the executable precondition/failure-mode representation.

Conceptually:

```text
meaning(guards)
==
meaning(lowered preconditions + failureModes)
```

for every successfully compiled action.

---

# 13. Non-normalized Server IR

An authority receiving Server IR in which guard semantics are not represented consistently in the executable normalized form MUST reject the IR fail-closed.

Example:

```text
guards.length > preconditions.length
```

where the additional guards represent executable checks.

Required outcome:

```text
structured malformed/non-normalized Server IR failure
no action execution
no mutation
no external effect
```

The authority MUST NOT silently execute the action while skipping the unmatched guard semantics.

A stable diagnostic such as:

```text
SERVER_IR_NOT_NORMALIZED
```

SHOULD be used.

The final diagnostic code MUST be standardized by the implementation/conformance work.

---

# 14. No silent semantic repair

An authority MUST NOT attempt to guess how malformed or non-normalized IR was intended to compile.

Forbidden behavior includes:

```text
silently lowering guards at execution time
dropping unmatched guards
inventing missing failure modes
executing a partially normalized action
```

The runtime either executes valid normalized semantics or rejects the input.

---

# 15. Server IR structural validity

Every executable Server IR collection has structural validity requirements.

For maps/collections containing semantic nodes, each entry MUST satisfy the structural shape required by its node kind.

Examples include:

```text
actions
states
constraints
queries
workflows
authorizationPolicies
readPolicies
```

A key being present does not make an invalid value a valid semantic node.

---

# 16. Malformed map entries

A `null`, primitive or otherwise structurally invalid semantic-node entry MUST NOT cause a native host-language exception.

Example:

```json
{
  "actions": {
    "a": null
  }
}
```

Required behavior:

```text
structured Server IR diagnostic
no semantic execution
no partial mutation
no native TypeError / panic / equivalent
```

This closes the Phase A `F1-B` specification omission.

---

# 17. Totality boundary

The following public semantic surfaces MUST be total over untrusted serialized semantic input:

```text
validation
compilation
analysis
AgentAPI inspection where applicable
Server IR admission
conformance execution
runtime execution admission
```

Malformed semantic input may produce structured failure.

It MUST NOT produce an uncaught host-language exception merely because the malformed value occurs inside a semantic node collection.

---

# 18. Typed API distinction

A strongly typed in-process API may document that callers are required to provide already-valid typed objects.

However, any surface accepting:

```text
JSON
deserialized Server IR
conformance fixture data
network-provided semantic artifacts
untrusted persisted semantic artifacts
```

MUST perform structural admission before semantic execution.

Language-level type declarations are not runtime validation.

---

# 19. Malformed IR failure semantics

Malformed Server IR MUST fail before application semantic execution.

Required properties:

```text
structured diagnostic
deterministic failure classification
no application state mutation
no provider mutation
no logical effect creation
no workflow advancement
no external side effect
```

---

# 20. Diagnostic stability

Cross-runtime conformance compares stable diagnostic semantics, not prose.

Where diagnostics are normative, runtimes MUST agree on:

```text
diagnostic code
semantic category
relevant semantic path/id where specified
```

They need not agree on:

```text
human wording
stack traces
internal exception types
runtime-local metadata
```

---

# 21. Conformance expectation matching

`ConformanceExpectation` matching semantics MUST be explicit.

Unless a fixture explicitly requests exact-set equality:

```text
diagnosticCodes
failureModes
```

are matched as required subsets.

Therefore:

```text
expected = [A]
actual   = [A, B]
```

satisfies a subset expectation.

Where exact equality is semantically important, the fixture MUST explicitly request exact matching.

The conformance schema MUST expose this distinction rather than relying on harness convention.

---

# 22. Portable semantic profile

0.17 defines the concept of a **Portable Semantic Profile**.

A portable profile is a named set of Axiom semantic capabilities that can be executed without runtime-specific native semantics.

The baseline portable core includes:

```text
expressions
locations
StateDef
ActionDef
portable operations
transactions
constraints
AuthorizationPolicyDef
legacy authorization where retained
QueryDef
ReadPolicyDef
WorkflowDef
portable events/timers
structured diagnostics
```

The final 0.17 profile MUST be derived from the complete frozen portable semantic vocabulary.

---

# 23. Capability declaration

Every runtime participating in cross-runtime conformance MUST expose a machine-readable capability declaration.

For each semantic capability:

```text
supported
unsupported
```

MAY be supplemented by precisely defined subprofiles.

A runtime MUST NOT claim support for a capability it only approximates.

---

# 24. Partial conformance

A runtime may claim partial Axiom conformance when:

```text
its supported profile is explicit
every claimed semantic capability conforms
unsupported capabilities are rejected before execution
no unsupported capability is silently approximated
```

Partial conformance MUST identify the exact profile.

---

# 25. Full conformance

A runtime may claim full 0.17 portable conformance only when it supports every capability in the required 0.17 portable profile and passes the complete runtime-neutral conformance suite.

---

# 26. Unsupported semantics

When a graph requires semantics outside a runtime's declared profile, the runtime MUST return an explicit unsupported-capability result.

Required:

```text
fail before unsupported semantic execution
structured capability/diagnostic information
no partial approximation
```

Forbidden:

```text
ignore node
skip operation
replace with no-op
best-effort execution
silently use weaker semantics
```

---

# 27. NativeOperation

`NativeOperation` is not portable Axiom execution semantics.

A portable runtime encountering a required NativeOperation without an explicit compatible native adapter MUST report it as unsupported/opaque.

It MUST NOT invent portable meaning.

NativeOperation therefore does not prevent partial portable conformance, but a graph requiring it is outside the portable profile unless an extension profile explicitly defines it.

---

# 28. Observable meaning

Cross-runtime conformance compares **observable semantic meaning**.

Depending on the fixture this includes:

```text
action result
semantic failure
state mutation
persistent mutation
changed-state identity
query result
query ordering where defined
authorization decision
row visibility
constraint outcome
workflow state
workflow history
workflow terminal outcome
logical event handling
logical timer firing
logical effect creation
diagnostic classification
```

---

# 29. Non-observable implementation details

Conformance MUST NOT require equality of:

```text
memory layout
class structure
object identity
internal database schema
thread model
process model
internal cache implementation
private logging
stack trace
private exception class
lease representation
internal polling strategy
performance characteristics
```

unless explicitly promoted into the semantic contract.

---

# 30. Runtime-neutral observation model

0.17 MUST define a deterministic serialized observation model for conformance.

Conceptually:

```json
{
  "outcome": {},
  "state": {},
  "queries": {},
  "authorization": {},
  "workflow": {},
  "effects": [],
  "events": [],
  "diagnostics": []
}
```

The final schema MUST include only semantic observations required for conformance.

It MUST NOT expose reference-runtime internals.

---

# 31. Normalization

Cross-runtime normalization may remove only explicitly non-semantic variation.

Every normalization rule MUST be documented.

Normalization MUST NOT erase differences in:

```text
ALLOW vs DENY
committed vs rolled back
state values
query rows
defined query ordering
workflow transitions
logical effect identity
semantic error category
unsupported capability behavior
```

---

# 32. Deterministic execution environment

Conformance fixtures MUST control semantic sources of nondeterminism.

These include where applicable:

```text
clock
UUID generation
random values
provider responses
external events
scheduler instants
effect-adapter responses
subscription updates
```

Two runtimes must receive equivalent controlled semantic inputs.

---

# 33. Host-language independence

Axiom semantics MUST NOT inherit host-language behavior unless explicitly specified.

In particular, runtimes MUST implement Axiom-defined semantics for:

```text
truthiness
absence
null
equality
comparison
number conversion
text conversion
collection behavior
ordering
```

rather than JavaScript, Python or another host language's defaults.

---

# 34. Expression contract

The frozen expression contract remains normative.

Phase A demonstrated independent agreement for all public expression kinds and built-ins.

0.17 MUST preserve explicit rules for:

```text
truthiness
required/presence
is-empty
numeric vs textual comparison
structural equality
nullish coalescing
absent vs explicit null
arithmetic conversion
case-insensitive textual contains
```

No host-language coercion may replace these rules.

---

# 35. Ordinary absence vs security absence

Ordinary expression evaluation and authorization security-value evaluation remain distinct semantic domains.

Ordinary field evaluation may treat absent and explicit `null` according to the frozen Expression contract.

Authorization continues to use the frozen three-valued security absence semantics from:

```text
axiom.authz.v3
```

A runtime MUST NOT collapse the authorization model into ordinary expression truthiness.

---

# 36. Authorization equivalence

For identical:

```text
graph
principal
resource
operation
controlled state
```

all conforming runtimes MUST produce the same authorization decision.

Authorization conformance includes:

```text
AuthorizationPolicyDef
legacy ActionDef.authorization
legacy + policy conjunction
QueryDef authorization
WorkflowDef authorization
ReadPolicyDef
missing principal
missing security attributes
principal preservation
```

---

# 37. Authorization failure safety

Unsupported or malformed security semantics MUST fail closed.

A runtime MUST NOT weaken authorization because:

```text
a field is absent
a capability is unsupported
a policy node is malformed
a workflow crosses an async boundary
a runtime uses different host-language truthiness
```

---

# 38. Action lifecycle

The portable action lifecycle remains:

```text
resolve
→ bind
→ authorize
→ preconditions
→ confirmation where applicable
→ transaction
→ operations
→ entity/transition constraints
→ postconditions
→ atomic commit or rollback
```

All runtimes MUST preserve the same observable ordering.

---

# 39. Operation ordering

Operations execute in declaration order where the semantic contract defines ordered execution.

Operation `N` observes provisional writes produced by operations `< N` in the same action transaction.

A runtime MUST NOT parallelize operations in a way that changes observable semantics.

---

# 40. Transaction semantics

Where an ActionDef is transactional:

```text
all semantic mutations commit
or
none commit
```

A failed transaction MUST NOT expose partial persistent state.

Cross-runtime conformance MUST include rollback probes.

---

# 41. Constraints

Constraint timing and failure semantics are portable.

Conformance MUST distinguish at least:

```text
precondition failure
entity constraint failure
transition constraint failure
postcondition failure
authorization denial
```

where the frozen contract distinguishes them.

---

# 42. Query semantics

Portable QueryDef semantics include as applicable:

```text
source
filter
projection
sort
pagination
aggregation
grouping
relationships
authorization
ReadPolicyDef
```

Cross-runtime results MUST agree wherever ordering or cardinality is semantically defined.

---

# 43. Row authorization ordering

Row authorization MUST occur at the frozen semantic point relative to:

```text
filter
sort
limit
pagination
aggregation
```

A runtime MUST NOT move authorization later merely as an optimization if doing so can affect observable query meaning or information disclosure.

---

# 44. Workflow semantics

Portable WorkflowDef semantics remain defined independently of runtime scheduling architecture.

Conformance includes:

```text
action
wait-event
timer
branch
complete
fail
bindings
retry
cancellation
principal preservation
```

---

# 45. Workflow timer semantics

The single-authority timer contract is normative and considered resolved.

A timer target instant is computed at activation and persisted.

It MUST NOT be recomputed from restart time.

An authority discovers due workflow work and advances it.

Applications do not need to poll timers to make them semantically fire.

Observable timer semantics are represented by the logical workflow transition/history, not by the number of physical wakeups.

---

# 46. Workflow physical vs logical execution

Physical timer/action attempts may repeat where the frozen workflow contract permits retries.

Logical workflow meaning MUST remain stable.

Conformance compares:

```text
logical invocation identity
logical timer firing
workflow history
bindings
terminal outcome
```

rather than physical attempt count unless attempt count is explicitly semantic.

---

# 47. Provider boundary

Portable conformance MUST use deterministic provider fixtures/adapters.

Different runtimes may implement provider infrastructure differently.

They MUST agree on provider-visible semantic results.

---

# 48. Effects

Effects are compared at the logical semantic boundary.

Conformance SHOULD use fake deterministic effect adapters.

It MUST NOT depend on uncontrolled real external side effects.

Compare where applicable:

```text
logical effect creation
effect payload semantics
logical identity
completion/failure semantics
```

Physical transport behavior is not required to match unless contractually observable.

---

# 49. Events and triggers

Portable event/trigger conformance MUST control:

```text
event identity
source
payload
principal where applicable
delivery order where specified
deduplication identity
```

Runtimes MUST agree on logical semantic outcomes.

---

# 50. Subscriptions and live queries

0.17 cross-runtime conformance MUST expand beyond Phase A to cover the frozen live-query/subscription semantics from 0.13 and later authorization work.

At minimum:

```text
initial result
provider/state mutation
update emission
authorization gain
authorization revocation
resume
cursor/principal binding
```

Transport protocol details are not portable semantics unless explicitly specified.

---

# 51. Schema evolution and migrations

Migration semantics remain portable where defined by the frozen 0.11 contract.

Conformance compares:

```text
accepted/rejected schema transition
semantic migration outcome
resulting application-visible data
```

It does not require identical database DDL or storage layout.

---

# 52. Blob semantics

Blob capabilities MAY use different physical storage implementations.

Portable conformance compares only public blob semantics such as:

```text
metadata
commit
delete
reference preservation
```

where defined.

Storage backend implementation is non-semantic.

---

# 53. Distributed authority

Distributed deployment topology remains non-application semantics.

The frozen invariant remains:

```text
observableMeaning(execute(G, oneAuthority))
==
observableMeaning(execute(G, N authorities))
```

for portable semantics covered by distributed execution.

---

# 54. Independent runtime and clustering

An independent runtime is not required to implement multi-authority execution merely to demonstrate core partial conformance.

However, it MUST NOT claim the distributed profile unless it passes distributed conformance.

Full 0.17 conformance SHOULD include independent evidence for distributed semantics or an explicitly separated distributed capability profile.

---

# 55. Distributed workflow timers

0.17 MUST add runtime-neutral conformance coverage for multi-authority workflow timer advancement.

The test must verify semantic topology transparency without requiring identical:

```text
lease algorithms
database locks
worker loops
coordination implementation
```

Compare logical workflow history/outcome.

---

# 56. Logical effects under distributed execution

Where distributed execution is claimed, cross-runtime conformance MUST preserve the frozen distinction:

```text
LogicalEffect
vs
EffectAttempt
```

Exactly-once logical effect creation and documented physical retry semantics remain normative.

---

# 57. Live distributed semantics

Where a runtime claims both live-query and distributed profiles, failover/topology changes MUST NOT weaken:

```text
authorization
query freshness contract
resume semantics
principal binding
logical update meaning
```

---

# 58. Runtime-neutral conformance corpus

0.17 MUST publish a language-neutral conformance corpus.

Fixtures MUST be consumable without TypeScript execution.

Preferred representation:

```text
JSON semantic fixture
+
controlled input/environment
+
expected normalized semantic observation
```

---

# 59. Golden oracle

The reference runtime MUST NOT be the sole golden oracle.

Canonical expected results MUST be derived from normative semantic rules.

A fixture should record:

```text
semantic rule/provenance
input graph/IR
controlled environment
expected observation
```

Both reference and independent runtimes are tested against that expectation.

---

# 60. Runtime-neutral candidates from Phase A

The 79 Phase A MATCH fixtures are candidates for promotion into the runtime-neutral conformance corpus.

Before promotion each candidate MUST have:

```text
normative semantic provenance
language-neutral input
runtime-neutral expected observation
no dependency on reference-runtime output
```

---

# 61. Conformance corpus expansion

The 35 Phase A C1 cases define a primary expansion backlog.

0.17 SHOULD progressively convert those unsupported domains into independently tested profiles covering:

```text
integrations
effects
triggers
subscriptions
blob storage
schema migrations
live queries
distributed authority
multi-authority workflows
navigate/native boundary where applicable
```

Native semantics remain explicitly nonportable where appropriate.

---

# 62. Malformed corpus

The runtime-neutral suite MUST include malformed serialized IR.

At minimum cover:

```text
non-object Server IR
non-array required collections
null node-map entries
primitive node-map entries
null operation
non-object operation
invalid location
invalid expression
invalid workflow step
wrong-kind reference
unknown semantic kind
non-normalized guard representation
```

Expected result:

```text
structured rejection
zero semantic mutation
zero native crash
```

---

# 63. Differential fuzzing

0.17 SHOULD include deterministic cross-runtime fuzzing.

Two categories:

```text
valid portable semantic graphs
malformed serialized semantic graphs
```

For valid graphs, compare normalized semantic outcomes.

For malformed graphs, compare required structured rejection semantics.

Every failure MUST preserve a deterministic seed/reproducer.

---

# 64. Differential adjudication

Cross-runtime mismatches MUST be classified before implementation changes.

Required categories:

```text
R1 — independent runtime defect
R2 — reference runtime defect
S1 — specification ambiguity
S2 — specification omission
D1 — discoverability failure
C1 — unsupported capability correctly rejected
H1 — harness defect
N1 — intentional non-semantic difference
```

Equivalent machine-readable identifiers MAY be used.

---

# 65. Specification findings are first-class

An S1, S2 or D1 is not merely a documentation inconvenience.

If an independent conforming implementation cannot determine observable semantic meaning from public contracts, it is an architectural conformance finding.

Such findings MUST be resolved before 1.0 if they can affect portable application meaning.

---

# 66. Discoverability

Normative execution rules MUST be discoverable without reconstructing intent across unrelated artifacts.

Critical invariants MUST NOT depend on:

```text
one sentence in an architecture document
inspection of reference-runtime behavior
reverse engineering a generated fixture
maintainer oral knowledge
```

The guard-normalization rule discovered in Phase A is the canonical example.

0.17 MUST consolidate such execution invariants into the primary semantic contract.

---

# 67. Public-contract sufficiency

For every portable semantic construct, a competent independent implementer must be able to determine:

```text
valid serialized representation
admission requirements
execution semantics
ordering
failure semantics
observable result
unsupported behavior
security boundary
```

without inspecting reference execution code.

---

# 68. Conformance package/version

0.17 MUST introduce a new runtime-neutral conformance generation after the Phase A contract decisions are implemented.

Expected identifier:

```text
axiom.conformance.v11
```

`v11` SHOULD cover both:

```text
existing AgentAPI/tooling conformance
runtime-neutral execution conformance
```

or provide clearly separated profiles under one versioned conformance generation.

The final structure may be implementation-defined, but runtime execution conformance MUST be public and machine-readable.

---

# 69. Existing tooling conformance

`axiom.conformance.v10` remains the validated 0.16 tooling baseline.

0.17 MUST NOT weaken or silently redefine it.

The transition to v11 must preserve all validated v10 guarantees or explicitly version any incompatible change.

---

# 70. AgentAPI

AgentAPI remains a semantic inspection interface.

It MAY be used by:

```text
humans
AI agents
IDEs
conformance tooling
independent runtime authors
```

It MUST NOT become a hidden execution dependency for independent runtimes.

---

# 71. Semantic fingerprint

0.17 MUST preserve the principle that execution-affecting semantic changes participate in the canonical semantic fingerprint.

Pure conformance metadata and implementation-local capability declarations MUST NOT alter application semantic identity unless they change graph meaning.

---

# 72. Runtime compatibility

A runtime MUST reject execution when:

```text
required semantic contract version unsupported
required authorization generation unsupported
required Server IR version unsupported
required portable capability unsupported
```

It MUST NOT silently downgrade semantic interpretation.

---

# 73. Security floor

No runtime may claim conformance while implementing weaker security semantics than the portable contract.

Security mismatch is release-blocking.

This includes:

```text
authorization
row visibility
workflow ownership
principal preservation
cursor binding
event authority
effect authority
```

---

# 74. Failure equivalence

Cross-runtime failure comparison is semantic.

Runtimes MUST agree where specified on:

```text
success vs failure
authorization vs validation vs constraint vs unsupported failure
commit vs rollback
stable diagnostic code/category
```

Human-readable message text does not need to match.

---

# 75. Side-effect safety during conformance

Conformance execution MUST avoid uncontrolled external effects.

Tests SHOULD use:

```text
fake providers
virtual clocks
deterministic event sources
captured effect adapters
isolated storage
```

The conformance suite itself must be safely repeatable.

---

# 76. Independence evidence

An implementation claiming independent-runtime validation MUST publish enough evidence to establish independence.

At minimum:

```text
implementation language
dependencies
public Axiom artifacts consumed
whether reference execution source was accessible
measures used to avoid semantic implementation reuse
```

---

# 77. Different-language implementation

A different implementation language is not required for conformance.

However, the Python Phase A runtime is retained as high-value evidence because it demonstrates that Axiom semantics are not dependent on JavaScript/TypeScript host behavior.

The independent Python runtime SHOULD continue as the principal second implementation through 0.17.

---

# 78. No shared semantic evaluator

The reference and independent runtime MUST NOT share a semantic evaluator merely to make conformance pass.

Shared language-neutral fixture/schema definitions are permitted.

Shared execution implementation is not.

---

# 79. Symmetric testing

Where possible, the same runtime-neutral fixture runner contract SHOULD be implemented independently for both runtimes.

A test should conceptually evaluate:

```text
fixture
   │
   ├── expected semantic observation
   │
   ├── reference runtime observation
   │
   └── independent runtime observation
```

and report all three.

---

# 80. Phase B — contract closure

The first implementation phase after this specification MUST close the two Phase A specification findings.

Required:

### F1-B

Define and implement structured rejection for structurally invalid semantic-node map entries on serialized execution/conformance surfaces.

### F2

Define and implement:

```text
guard lowering ownership
normalized Server IR invariant
authority execution of preconditions/failureModes
fail-closed rejection of non-normalized executable IR
```

Both findings must become explicit conformance fixtures.

---

# 81. Phase B regression

After F1/F2 closure rerun:

```text
all 79 Phase A runtime-neutral candidates
all malformed totality probes
all expression leakage probes
authorization matrix
workflow timer probes
guard normalization probes
```

No previously conforming portable semantic behavior may regress.

---

# 82. Phase C — capability expansion

After core closure, expand independent execution into the Phase A C1 domains.

Recommended order:

```text
1. effects / triggers / events
2. integrations / provider-backed operations
3. subscriptions
4. live queries
5. blobs
6. migrations
7. distributed authority
8. multi-authority workflow execution
```

The order MAY change based on dependency structure.

---

# 83. Capability expansion rule

A capability moves from:

```text
C1 unsupported
```

to:

```text
supported
```

only when:

```text
public contract is sufficient
independent implementation exists
runtime-neutral fixtures exist
reference passes
independent runtime passes
no silent approximation exists
```

---

# 84. Specification-gap stop rule

If capability expansion reaches a point where the independent runtime cannot determine required observable meaning from public contracts:

```text
stop implementation for that semantic boundary
record S1/S2/D1
resolve contract
add normative fixture
then resume
```

Do not infer behavior from the reference implementation.

---

# 85. Reference defects discovered during 0.17

When a runtime-neutral contract clearly establishes expected meaning and the reference differs:

```text
classify R2
fix reference runtime
retain reproducer permanently
```

The independent runtime MUST NOT be changed merely to reproduce the defect.

---

# 86. Independent defects discovered during 0.17

When the contract clearly establishes expected meaning and the independent runtime differs:

```text
classify R1
fix independent runtime
retain reproducer permanently
```

This is expected and does not invalidate the independence exercise.

---

# 87. Contract changes discovered during implementation

If 0.17 requires changing execution semantics rather than merely clarifying them:

1. classify the prior ambiguity/defect;
2. explicitly document the chosen semantic rule;
3. determine compatibility impact;
4. update semantic fingerprint behavior where required;
5. bump Server IR only if representation changes;
6. update both runtimes independently;
7. add runtime-neutral conformance.

No semantic change may be disguised as a documentation fix.

---

# 88. Formal runtime conformance result

The 0.17 campaign MUST produce a machine-readable result for each runtime.

Conceptually:

```json
{
  "contract": "axiom.conformance.v11",
  "runtime": "example-runtime",
  "profiles": {
    "core": "PASS",
    "authorization": "PASS",
    "workflow": "PASS",
    "live": "UNSUPPORTED",
    "distributed": "UNSUPPORTED"
  },
  "fixtures": {
    "passed": 0,
    "failed": 0,
    "unsupported": 0
  },
  "nativeCrashes": 0,
  "silentApproximations": 0
}
```

Exact schema is implementation-defined during alpha and frozen before final 0.17 validation.

---

# 89. Cross-runtime campaign report

Produce a report containing:

```text
runtime versions
implementation languages
independence evidence
supported profiles
fixture counts
semantic matches
R1 findings
R2 findings
S1 findings
S2 findings
D1 findings
C1 cases
H1 findings
N1 differences
fuzz results
totality results
security results
open portability boundaries
```

---

# 90. Required 0.17 release properties

Before the 0.17 semantic contract can freeze:

```text
two independent runtimes execute the required portable profile
runtime-neutral conformance corpus is public
no unexplained cross-runtime mismatch remains
no HIGH/CRITICAL semantic ambiguity remains
no silent unsupported execution exists
authorization equivalence is demonstrated
transaction equivalence is demonstrated
workflow equivalence is demonstrated
malformed serialized IR fails structurally without native crash
guard normalization contract is explicit and tested
```

---

# 91. Distributed/full-profile release decision

If the independent Python runtime has not implemented all advanced profiles by the first 0.17 release candidate, conformance claims MUST distinguish:

```text
Core Portable Conformance
Full Portable Conformance
Distributed Conformance
```

0.17 MUST NOT falsely label partial coverage as full runtime equivalence.

However, the milestone SHOULD aim to independently exercise all frozen portable semantics before final freeze if practical.

---

# 92. D/E/S external validation

Final 0.17 validation targets:

```text
D1 / E1 / S1
```

Interpretation remains consistent with prior milestone campaigns:

```text
D — determinism / semantic correctness
E — external reproducibility / independence
S — security / fail-closed correctness
```

The external evaluator MUST have access to public artifacts sufficient to reproduce the independent-runtime conformance campaign.

---

# 93. Release-blocking findings

The following are release-blocking:

```text
unexplained cross-runtime semantic mismatch
authorization mismatch
transaction/rollback mismatch
persistent-state mismatch
query visibility mismatch
workflow terminal-outcome mismatch
logical effect duplication mismatch
silent unsupported semantic execution
native crash on malformed serialized IR where totality applies
HIGH/CRITICAL unresolved S1/S2
independent runtime secretly depending on reference execution semantics
```

---

# 94. Non-blocking differences

Examples:

```text
diagnostic prose
internal logs
runtime architecture
storage schema
performance
physical retry count where non-semantic
unspecified ordering
implementation language
```

provided they cannot change application-observable meaning.

---

# 95. 0.17 freeze statement

0.17 may be frozen only when the project can truthfully state:

> Axiom application semantics are defined by public, runtime-neutral contracts and conformance fixtures. At least two independent runtime implementations can execute the required portable semantic profile and produce equivalent observable meaning without sharing semantic execution implementation.

---

# 96. Relationship to 1.0

0.17 is the final architectural proof before the 1.0 Contract Freeze + Hardening milestone.

1.0 MUST NOT rely on:

```text
reference-runtime behavior as undocumented specification
host-language accidental semantics
private maintainer knowledge
silent fallback for unsupported constructs
```

The intended progression is:

```text
0.16
semantic meaning is inspectable
        ↓
0.17
semantic meaning is independently executable
        ↓
1.0
semantic contract can be frozen
```

---

# 97. Final invariant

The architectural test for Axiom is no longer:

> Can the reference runtime execute this graph?

It is:

> Can any conforming runtime, implemented independently from the public contract, execute this graph with the same observable semantic meaning?

For every graph inside the portable profile, the required answer after Axiom 0.17 is:

```text
yes
```