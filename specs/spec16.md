# Axiom 0.16 Specification
## Tooling, Explainability & AI Authoring

**Target:** `0.16.0-alpha.1`  
**Baseline:** `0.15.0-alpha.3` — externally validated and frozen  
**Milestone:** Axiom 0.16 — Tooling / Explainability / AI Authoring  
**Expected Server IR:** `axiom.server.v10` if new serialized inspection/authoring contract requires it; otherwise retain v9  
**Expected Conformance:** `axiom.conformance.v10`  
**External validation:** required before 0.16 semantic freeze

---

# 1. Status entering 0.16

Axiom 0.15 — Authorization Completeness completed with:

```text
0.15.0-alpha.3

D1 / E1 / S1
918 / 918 external checks PASS
15 / 15 sections PASS
25 / 25 forbidden counters = 0
open findings = 0

EXTERNALLY VALIDATED
SEMANTIC MODEL FROZEN
```

The authorization model entering 0.16 includes:

```text
AuthorizationPolicyDef
legacy ActionDef.authorization
canonical authorization-aware expression evaluation
fail-closed absent-value semantics
workflow authorization
query authorization
live authorization
principal-bound continuation/idempotency
axiom.authz.v3 runtime compatibility
```

0.16 MUST preserve these semantics.

---

# 2. Purpose

Axiom already provides a semantic application model.

0.16 makes that model substantially easier for:

```text
humans
developer tools
IDEs
AI agents
external analyzers
future independent runtimes
```

to understand and author correctly.

The milestone is not primarily about adding application capabilities.

It is about making existing Axiom semantics:

```text
discoverable
explainable
navigable
diagnosable
machine-authorable
machine-verifiable
```

without requiring source-code inspection or runtime implementation knowledge.

---

# 3. Primary invariant

For every semantic construct represented in an Axiom graph:

```text
meaning(G)
```

must be discoverable through public semantic tooling without requiring:

```text
repository source
runtime internals
provider implementation details
host-language reflection
execution of arbitrary application code
```

A sufficiently capable tool or AI agent should be able to answer:

```text
What exists?
What does it depend on?
Who can invoke/read/change it?
What can it affect?
Why is this allowed or denied?
What happens if this executes?
What is invalid?
What would this graph edit change?
```

from the public semantic contract.

---

# 4. Core design principle

Axiom 0.16 treats explainability as a semantic capability, not documentation prose.

Required direction:

```text
Graph
  ↓
canonical semantic analysis
  ↓
structured machine-readable explanation
  ↓
human / IDE / AI rendering
```

Forbidden direction:

```text
Graph
  ↓
LLM guesses what it probably means
```

AI tooling consumes semantic truth.

It does not define semantic truth.

---

# 5. Non-goals

0.16 does NOT primarily add:

```text
new persistence semantics
new distributed-authority semantics
new workflow step kinds
new authorization mechanisms
new query semantics
new live-query semantics
new provider semantics
arbitrary code generation
a proprietary IDE
an AI agent runtime
an autonomous deployment system
```

Those may use 0.16 tooling, but are not the milestone.

---

# 6. Three pillars

0.16 consists of three tightly related capabilities:

```text
A. Semantic Inspection
B. Explainability / Static Analysis
C. AI-safe Authoring
```

They MUST share one canonical semantic model.

There must not be separate interpretations for:

```text
runtime
AgentAPI
CLI
AI authoring
documentation
```

---

# 7. AgentAPI becomes a first-class semantic interface

The existing `AgentAPI` evolves into the canonical machine-facing interface for semantic graph understanding.

It MUST be usable by:

```text
AI agents
IDEs
CLI tooling
test harnesses
external analyzers
future language servers
```

without requiring direct runtime internals.

---

# 8. AgentAPI design requirement

AgentAPI results MUST be:

```text
structured
serializable
deterministic
stable enough for tooling
explicitly versioned where contract stability requires it
```

Avoid APIs whose primary result is prose.

Preferred:

```text
structured semantic result
+
optional human-readable rendering
```

not:

```text
string explanation only
```

---

# 9. Semantic inventory

AgentAPI MUST provide a canonical inventory of graph entities.

At minimum:

```text
StateDef
ActionDef
QueryDef
WorkflowDef
AuthorizationPolicyDef
ReadPolicyDef
ConstraintDef
provider-backed resources
subscriptions
events
schedules
effects
presentation/UI semantic nodes
```

where present in the current graph vocabulary.

---

# 10. Inventory information

For each semantic node, tooling SHOULD expose at least:

```text
id
kind
name/description where semantic metadata exists
source/reference location where available
dependencies
dependents
authority/security relevance
provider relevance
execution relevance
```

The inventory must not invent fields that are not represented semantically.

---

# 11. Canonical references

All semantic relationships returned by tooling MUST use stable semantic identifiers.

Do not expose runtime object identity as the primary relationship mechanism.

Example:

```json
{
  "kind": "ActionDef",
  "id": "approveInvoice",
  "dependsOn": [
    { "kind": "StateDef", "id": "currentUser" }
  ]
}
```

Exact JSON shape is illustrative, not normative.

---

# 12. Dependency graph

AgentAPI MUST expose semantic dependency relationships.

At minimum answer:

```text
What does X depend on?
What depends on X?
```

Dependencies include semantic references through:

```text
expressions
locations
queries
actions
workflows
authorization
constraints
effects
subscriptions
presentation bindings
```

as applicable.

---

# 13. Transitive dependency analysis

Tooling SHOULD support:

```text
direct dependencies
transitive dependencies
direct dependents
transitive dependents
```

with cycle-safe traversal.

Results must be deterministic.

---

# 14. Dependency provenance

A dependency result SHOULD explain why the edge exists.

Example:

```text
ActionDef.updateOrder
  → StateDef.currentUser

reason:
  authorization expression references currentUser
```

or:

```text
WorkflowDef.checkout
  → ActionDef.chargeCard

reason:
  workflow step payment invokes chargeCard
```

---

# 15. Semantic impact analysis

AgentAPI MUST support analysis of:

```text
If semantic node X changes, what may be affected?
```

This is static impact analysis, not runtime prediction.

At minimum classify affected:

```text
actions
queries
workflows
authorization policies
live queries
provider interactions
presentation nodes
```

---

# 16. Change impact is conservative

Impact analysis MAY over-approximate.

It MUST NOT silently under-approximate known semantic dependencies.

If certainty cannot be established:

```text
possiblyAffected
```

is preferable to omission.

---

# 17. Explain action

Tooling MUST be able to explain an `ActionDef`.

The structured result SHOULD answer:

```text
What is this action?
What inputs does it accept?
What semantic state can it read?
What semantic state can it mutate?
What providers can it touch?
What logical effects can it create?
What authorization applies?
What constraints can prevent execution?
What workflows/schedules/events can invoke it?
Is NativeOperation involved?
```

---

# 18. Explain query

Tooling MUST be able to explain a `QueryDef`.

The result SHOULD answer:

```text
What source does it query?
What parameters exist?
What filters apply?
What authorization applies?
What row-level policy applies?
What ordering/limit/aggregation exists?
Is it live-capable?
What provider capabilities are required?
What semantic dependencies exist?
```

---

# 19. Explain workflow

Tooling MUST explain a `WorkflowDef`.

At minimum:

```text
inputs
bindings
steps
branch conditions
action invocations
wait-event steps
timers
terminal outcomes
authorization
principal behavior
retry behavior
cancellation behavior
durable state dependencies
```

---

# 20. Workflow graph rendering model

Workflow explanation SHOULD expose a structured control-flow representation suitable for rendering as:

```text
graph
tree
timeline
diagram
```

The canonical result remains structured data.

A renderer is presentation.

---

# 21. Explain state

For `StateDef`, tooling SHOULD answer:

```text
type/schema
initialization
persistence behavior
authority-local/cache behavior
who reads it
who writes it
constraints
authorization where applicable
```

---

# 22. Explain authorization

0.15 already introduced authorization analysis.

0.16 makes authorization explanation a first-class capability.

Given a protected semantic operation, AgentAPI MUST answer:

```text
Which authorization mechanisms apply?
```

including:

```text
AuthorizationPolicyDef
legacy ActionDef.authorization
ReadPolicyDef
workflow owner baseline
WorkflowDef.instanceAccessPolicy
other frozen 0.15 mechanisms
```

---

# 23. Effective authorization explanation

For an action containing both:

```text
ActionDef.authorization
ActionDef.authorizationPolicy
```

tooling MUST make the conjunction explicit:

```text
legacy authorization
AND
authorization policy
```

It must not merely list both without explaining effective composition.

---

# 24. Authorization dependency analysis

For each policy, tooling SHOULD identify referenced:

```text
PRINCIPAL fields
RESOURCE fields
OPERATION
other permitted semantic inputs
```

Example:

```text
requires principal.role
requires resource.tenantId
```

This is structural dependency information.

It does not imply those fields are always present.

---

# 25. Authorization absent-value explanation

Tooling MUST reflect frozen 0.15 semantics.

For a policy:

```text
PRINCIPAL.role != "banned"
```

the explanation must not suggest:

```text
anonymous is allowed because undefined != banned
```

The semantic explanation must reflect:

```text
missing referenced security field => cannot manufacture ALLOW
```

---

# 26. Explain authorization decision

Where concrete evaluation context is supplied, tooling SHOULD support:

```text
explainAuthorizationDecision(...)
```

or equivalent.

Input may include:

```text
operation
principal
resource
```

Output SHOULD include:

```text
ALLOW / DENY
applicable policies
policy result
legacy authorization result
effective composition
safe reason/provenance
```

---

# 27. No secret leakage in authorization explanation

Authorization explanation MUST NOT disclose secrets merely because tooling is introspective.

Do not return:

```text
raw credentials
secret values
tokens
provider secrets
host authentication internals
```

Static policy structure may be exposed according to existing graph inspection permissions/trust boundary.

---

# 28. Static versus runtime explanation

AgentAPI MUST distinguish:

```text
static semantic explanation
```

from:

```text
runtime observation
```

Example:

```text
"This action may write StateDef.orders"
```

is static.

```text
"This invocation wrote order #123"
```

is runtime observation.

0.16 focuses primarily on static semantic explanation.

---

# 29. No simulated certainty

Tooling must not claim:

```text
"This action will execute effect X"
```

when control flow only means:

```text
"This action may execute effect X."
```

Analysis should distinguish where possible:

```text
always
conditionally
possibly
unknown
```

---

# 30. Capability analysis

AgentAPI MUST expose required runtime/provider capabilities for a graph or semantic node.

Examples:

```text
persistence
coordination
mutation observation
live queries
workflow store
event journal
scheduler
effect execution
provider transaction
```

Use actual current Axiom capability vocabulary.

---

# 31. Capability provenance

Tooling SHOULD explain why a capability is required.

Example:

```text
mutationObservation required because QueryDef.orders is live and provider-backed
```

rather than returning only:

```text
["mutationObservation"]
```

---

# 32. Runtime compatibility analysis

Tooling SHOULD expose the semantic runtime compatibility requirements of a graph.

At minimum include relevant frozen compatibility dimensions such as:

```text
semantic fingerprint
server IR contract
authorization runtime discriminator
other semantic runtime compatibility keys
```

where publicly meaningful.

---

# 33. Fingerprint explanation

Given two graphs:

```text
G1
G2
```

AgentAPI SHOULD be able to explain why:

```text
semanticFingerprint(G1) != semanticFingerprint(G2)
```

or why they remain equal.

This is essential for debugging distributed compatibility.

---

# 34. Semantic diff

0.16 MUST introduce canonical semantic graph diffing.

Conceptually:

```text
diff(G1, G2)
```

returns structured changes.

At minimum classify:

```text
added
removed
changed
```

semantic nodes.

---

# 35. Meaningful diff

Diff MUST operate on semantic meaning, not merely serialized object layout.

Reordering semantically unordered data SHOULD NOT produce a semantic change.

Presentation-only changes SHOULD be distinguishable from executable semantic changes.

---

# 36. Diff categories

Changes SHOULD be classified into categories such as:

```text
semantic
authorization
schema
provider
workflow
query
presentation
metadata
```

A change may belong to multiple categories.

---

# 37. Compatibility impact of diff

Diff SHOULD indicate whether a change is expected to affect:

```text
semanticFingerprint
authority compatibility
Server IR
persistence/schema migration
authorization meaning
```

based on canonical framework rules.

---

# 38. Explain fingerprint delta

Example desired result:

```text
semanticFingerprint changed because:

ActionDef.transfer.authorizationPolicy
changed from policy.employee to policy.manager
```

not:

```text
hash changed.
```

---

# 39. Graph validation as tooling foundation

`validateGraph` remains the canonical structural/semantic validity gate.

0.16 MUST make its output sufficiently structured for:

```text
IDE diagnostics
AI correction
CLI rendering
CI
```

---

# 40. Diagnostic structure

Each diagnostic SHOULD provide:

```text
code
severity
message
semantic node id
semantic node kind
path/location
related semantic ids
suggested remediation metadata where deterministic
```

Not every field is required for every diagnostic.

---

# 41. Stable diagnostic codes

Tooling MUST rely on stable diagnostic codes rather than parsing human messages.

Example:

```text
AUTHORIZATION_INVALID_POLICY
```

Human wording may evolve.

Machine behavior should key on the code.

---

# 42. Diagnostic severity

Canonical severities SHOULD include:

```text
error
warning
info
```

or an equivalent small closed set.

Only `error` prevents a graph from being valid unless an existing contract says otherwise.

---

# 43. No fake warnings

Do not create heuristic warnings merely because an AI might find them interesting.

Warnings should correspond to deterministic, documented analysis.

Example of acceptable warning:

```text
semantic node is unreachable
```

if reachability is well-defined.

Example of unacceptable warning:

```text
this workflow seems complicated
```

---

# 44. Graph reachability

AgentAPI SHOULD provide reachability analysis.

Potential roots include:

```text
public actions
server routes/operations
event ingress
schedules
workflow starts
presentation entry points
```

according to actual graph semantics.

---

# 45. Unreachable semantic nodes

Where deterministic, tooling SHOULD identify semantic nodes that cannot be reached from any executable/public root.

This is a tooling diagnostic, not necessarily a graph validity error.

---

# 46. NativeOperation analysis

`NativeOperation` remains a controlled escape boundary.

0.16 MUST make every NativeOperation discoverable.

AgentAPI MUST support:

```text
listNativeOperations()
```

or equivalent semantic analysis.

---

# 47. NativeOperation impact

For each NativeOperation, tooling SHOULD expose:

```text
where it occurs
what semantic node contains it
what declared inputs/outputs exist
what static guarantees stop at the boundary
```

It MUST NOT invent hidden side effects that cannot be known.

---

# 48. NativeOperation risk classification

Tooling MAY classify NativeOperation as:

```text
opaque semantic boundary
```

but SHOULD NOT use subjective security scores unless deterministically defined.

The important fact is:

```text
static semantic analysis cannot see through this boundary.
```

---

# 49. Target-zero visibility

AgentAPI SHOULD make it trivial to answer:

```text
How many NativeOperations exist in this graph?
```

because long-term framework direction remains:

```text
target zero where semantic primitives exist.
```

---

# 50. Provider dependency inspection

Tooling MUST distinguish:

```text
application semantics
```

from:

```text
provider implementation/adapters.
```

A graph may require provider capabilities without embedding provider-specific meaning.

---

# 51. Provider portability analysis

Where deterministically possible, AgentAPI SHOULD identify:

```text
semantic requirements that prevent a provider from supporting a graph
```

without hardcoding specific provider brands into graph semantics.

Example:

```text
QueryDef X requires mutation observation
Provider capability set lacks mutationObservation
```

---

# 52. Schema inspection

AgentAPI MUST provide structured inspection of semantic schemas/types.

An AI agent should be able to discover:

```text
fields
types
nullability/optionality
constraints
references
enum-like values
```

where represented by the current type system.

---

# 53. Writable location inspection

Axiom distinguishes values from writable locations.

Tooling MUST preserve this distinction.

For a writable target, AgentAPI SHOULD identify:

```text
location
value type
allowed write operation
owning semantic node
```

Do not describe every expression as writable.

---

# 54. Expression inspection

AgentAPI SHOULD expose normalized expression structure.

It should be possible to ask:

```text
What does this expression reference?
What type does it produce?
Is it deterministic?
Does it contain authorization security-scope reads?
```

without executing arbitrary host code.

---

# 55. Expression determinism

Where current semantics define deterministic/nondeterministic expression vocabulary, tooling SHOULD expose that classification.

Authorization restrictions remain as frozen in 0.15.

---

# 56. Action mutation set

Static analysis SHOULD derive a conservative mutation set:

```text
ActionDef X may mutate:
  StateDef A
  provider resource B
```

If NativeOperation prevents certainty:

```text
mutation set incomplete due to opaque boundary
```

must be represented explicitly.

---

# 57. Action effect set

Likewise derive:

```text
may create logical effect E
```

and distinguish:

```text
logical effect
physical effect attempt
```

according to frozen 0.12 semantics.

---

# 58. Query read set

For QueryDef and action/query expressions, tooling SHOULD derive a conservative read set.

This is useful for:

```text
impact analysis
authorization review
AI graph editing
debugging
```

---

# 59. Workflow action set

For each WorkflowDef, expose:

```text
actions reachable from workflow
```

with conditional/control-flow provenance.

---

# 60. Workflow event set

Expose:

```text
events awaited/consumed
```

and stable semantic identifiers where present.

---

# 61. Workflow timer set

Expose:

```text
timer steps
timer semantics
```

without exposing provider/runtime implementation details as graph meaning.

---

# 62. Workflow terminal outcomes

Tooling SHOULD enumerate reachable:

```text
complete
fail
```

terminal outcomes where statically knowable.

---

# 63. Explain external ingress

Tooling SHOULD identify semantic ingress points such as:

```text
direct action invocation
workflow start
event ingress
subscription
schedule
```

according to current graph vocabulary.

---

# 64. Explain external egress

Tooling SHOULD identify:

```text
provider mutation
logical effect
external query
subscription
```

where represented.

---

# 65. Security boundary inventory

AgentAPI MUST support a security-focused inventory.

At minimum identify:

```text
protected actions
public actions
protected queries
public queries
workflow start policies
workflow instance access policies
row policies
legacy authorization
NativeOperations
external ingress
```

---

# 66. Public/protected terminology

Tooling must use semantic definitions.

Do not infer:

```text
not rendered in UI => protected
```

UI visibility is not authorization.

This frozen principle remains explicit.

---

# 67. AI authoring objective

An AI agent should be able to construct and modify Axiom applications without needing to guess:

```text
valid node shapes
valid references
available semantic primitives
required fields
type constraints
authorization attachment points
provider requirements
```

---

# 68. Authoring is graph authoring

AI authoring MUST target semantic graph structures.

Preferred:

```text
create ActionDef
attach AuthorizationPolicyDef
reference StateDef
validate
analyze
```

not:

```text
generate arbitrary runtime JavaScript.
```

---

# 69. Canonical authoring schema

0.16 MUST expose machine-readable authoring information sufficient to construct every public semantic node.

This MAY be:

```text
JSON Schema
AgentAPI schema descriptors
typed semantic metadata
```

or an equivalent canonical representation.

The exact serialization is implementation-defined for alpha.1.

---

# 70. Authoring schema completeness

For every public semantic node kind, machine-readable authoring metadata MUST identify:

```text
kind
required fields
optional fields
field types
reference targets
closed enums
nested semantic structures
constraints that can be expressed structurally
```

---

# 71. No handwritten duplicate schema

Avoid maintaining:

```text
runtime type definitions
validation definitions
AI authoring definitions
docs definitions
```

as four unrelated sources of truth.

0.16 SHOULD derive as much authoring metadata as possible from canonical semantic definitions.

---

# 72. Semantic vocabulary discovery

AgentAPI MUST allow a tool to ask:

```text
What semantic node kinds can I create?
```

and receive a structured answer.

---

# 73. Kind description

For each kind, tooling SHOULD provide:

```text
semantic purpose
allowed fields
reference rules
examples or templates where canonical
```

Descriptions are supplementary.

The structural contract remains authoritative.

---

# 74. Field discovery

A tool must be able to ask:

```text
What fields are valid on ActionDef?
```

without reading TypeScript declarations manually.

---

# 75. Reference target discovery

For a field containing semantic references, tooling MUST expose valid target kinds.

Example:

```text
authorizationPolicy:
  reference target => AuthorizationPolicyDef
```

---

# 76. Closed vocabulary

Where a field has a closed vocabulary:

```text
workflow step kind
operation kind
constraint operator
```

authoring metadata MUST enumerate valid values.

AI agents should not need to hallucinate identifiers.

---

# 77. Semantic templates

AgentAPI SHOULD provide minimal valid templates for semantic node kinds.

Example conceptually:

```json
{
  "kind": "ActionDef",
  "required": {
    "id": "<id>",
    "..."
  }
}
```

Templates MUST NOT introduce provider-specific or application-specific assumptions.

---

# 78. Templates are not defaults

A template helps construct valid structure.

It MUST NOT silently assign security-sensitive semantics.

For example, an ActionDef template must not implicitly create:

```text
public authorization
```

unless that is already the semantic default and clearly represented.

---

# 79. AI edit model

0.16 SHOULD define a structured graph-edit representation.

Examples:

```text
add node
remove node
replace field
add reference
remove reference
```

This allows AI agents to propose semantic edits without rewriting entire source files.

---

# 80. Edit representation requirements

A graph edit MUST be:

```text
serializable
inspectable
validatable
deterministic
```

It must identify semantic targets by stable semantic identity/path.

---

# 81. No direct mutation before validation

AI authoring workflow SHOULD support:

```text
propose edit
    ↓
apply to candidate graph
    ↓
validate
    ↓
analyze semantic diff
    ↓
accept/reject
```

rather than immediately mutating a live authoritative application.

---

# 82. Candidate graph

Tooling SHOULD support validation/analysis of an in-memory candidate graph without executing it.

This is essential for safe AI authoring.

---

# 83. Validate proposed edit

Given:

```text
G
edit E
```

tooling SHOULD be able to produce:

```text
candidate graph G'
validation diagnostics
semantic diff G → G'
impact analysis
```

before runtime execution.

---

# 84. Atomic edit sets

An AI often needs multiple coordinated edits.

Example:

```text
add policy
add action
attach policy to action
```

The authoring model SHOULD support an atomic edit set evaluated as one candidate graph.

Intermediate invalidity need not reject the edit if the final candidate is valid.

---

# 85. Edit preconditions

Structured edits SHOULD support preconditions where useful.

Example:

```text
replace ActionDef X.authorizationPolicy
only if current value == policy.old
```

This prevents stale AI edits from silently overwriting concurrent changes.

---

# 86. Conflict detection

Applying an edit to a graph that no longer satisfies its preconditions MUST fail explicitly.

Do not silently merge ambiguous semantic edits.

---

# 87. Semantic diff after edit

Every successful candidate edit SHOULD be able to produce:

```text
semanticDiff
```

so the author/agent can inspect actual meaning changes.

---

# 88. Security-sensitive edit classification

Diff analysis MUST identify edits affecting authorization meaning.

Examples:

```text
policy changed
policy detached
public action created
ReadPolicy removed
workflow instanceAccessPolicy changed
legacy authorization changed
```

---

# 89. Security-sensitive edit does not imply refusal

0.16 tooling identifies security-sensitive edits.

It does not define a deployment approval workflow.

That belongs to higher-level tooling/application policy.

---

# 90. Persistence-sensitive edit classification

Diff SHOULD identify changes potentially requiring:

```text
schema migration
data migration
```

based on frozen 0.11 semantics.

---

# 91. Distributed-compatibility-sensitive edit

Diff SHOULD identify changes affecting:

```text
semanticFingerprint
authority compatibility
```

based on frozen distributed semantics.

---

# 92. Workflow-sensitive edit

Diff SHOULD flag:

```text
WorkflowDef semantic changes
```

that may affect new workflow instances.

It MUST NOT claim existing durable instances automatically change unless that is actual frozen workflow behavior.

---

# 93. Existing workflow version semantics

Tooling explanations must reflect actual 0.14 workflow semantics.

Do not invent workflow migration/versioning behavior in 0.16.

---

# 94. AI authoring safety rule

An AI agent must not be able to bypass semantic validation merely because it uses AgentAPI.

AgentAPI authoring is not a privileged raw-runtime escape.

---

# 95. NativeOperation creation

If NativeOperation remains publicly authorable, authoring metadata MUST clearly identify it as an opaque semantic boundary.

AI tooling SHOULD prefer semantic primitives when an equivalent exists.

But 0.16 MUST NOT use nondeterministic AI judgment as a validity rule.

---

# 96. Suggested primitive discovery

AgentAPI SHOULD support discovering relevant semantic primitives.

Example:

```text
"I need to mutate state"
```

can be mapped by tooling to available semantic action/state constructs.

The canonical API may expose:

```text
capabilities
node kinds
field descriptions
```

rather than natural-language intent matching.

---

# 97. No LLM dependency in core

Axiom core/runtime MUST NOT require an LLM to:

```text
validate graphs
explain semantics structurally
calculate dependency graphs
calculate semantic diff
apply graph edits
```

AI is a consumer of these facilities.

---

# 98. Explainability determinism

For identical:

```text
graph
AgentAPI version
analysis request
```

structured analysis output MUST be semantically identical.

Ordering should be canonical where practical.

---

# 99. Analysis totality

AgentAPI analysis MUST be total over:

```text
valid graphs
invalid candidate graphs
malformed candidate edit requests
```

where the public API accepts them.

It must not assume validation already succeeded unless explicitly documented.

---

# 100. Invalid graph analysis

For invalid graphs, analysis MAY be partial.

It MUST explicitly mark:

```text
incomplete
invalid
unknown
```

rather than returning plausible-looking complete results.

---

# 101. Analysis confidence vocabulary

Where static analysis cannot determine a fact, use a closed semantic classification such as:

```text
definite
possible
unknown
```

or equivalent.

Do not use arbitrary floating-point confidence scores.

---

# 102. Opaque boundary propagation

If analysis encounters NativeOperation or another opaque boundary:

```text
unknown
```

must propagate where necessary.

Example:

```text
Action may have additional effects through NativeOperation X.
```

Do not report:

```text
no other effects
```

unless proven.

---

# 103. Explainability completeness

For every executable semantic root, AgentAPI MUST either:

```text
explain its reachable semantic behavior
```

or explicitly identify the boundary preventing complete analysis.

Silent omission is not acceptable.

---

# 104. Source provenance

Where graph builders/tooling can provide source metadata, diagnostics and explanations SHOULD retain:

```text
file
line/column
semantic builder path
```

or equivalent provenance.

Source provenance is tooling metadata.

It MUST NOT affect semanticFingerprint unless already semantic.

---

# 105. Source provenance optionality

Graphs constructed programmatically without source metadata remain valid.

Explainability cannot require source files.

Semantic identity is graph identity, not source identity.

---

# 106. CLI tooling

0.16 SHOULD provide or extend CLI commands around AgentAPI.

Suggested capabilities:

```text
axiom inspect
axiom validate
axiom explain
axiom diff
axiom analyze
```

Exact command names are not normative.

---

# 107. CLI is a renderer

CLI behavior MUST be implemented over canonical tooling APIs where practical.

Do not make CLI the only place semantic analysis exists.

---

# 108. Machine-readable CLI

CLI SHOULD support structured output such as:

```text
--json
```

for CI and external agents.

Structured output should correspond closely to AgentAPI results.

---

# 109. Explain command

Conceptually:

```text
axiom explain action approveInvoice
axiom explain workflow checkout
axiom explain query orders
```

should render canonical semantic explanation.

---

# 110. Diff command

Conceptually:

```text
axiom diff graphA graphB
```

should expose canonical semantic diff.

---

# 111. Validation command

Conceptually:

```text
axiom validate graph
```

should expose structured diagnostics and appropriate process exit status.

---

# 112. Exit semantics

Suggested:

```text
0 = graph valid / requested analysis completed
nonzero = invalid input / graph validation failure / tooling failure
```

Exact codes should be documented if exposed.

---

# 113. AI-oriented output size

AgentAPI SHOULD support scoped inspection.

An agent should not need to retrieve the entire graph to understand one ActionDef.

Support queries such as:

```text
inspect node
inspect dependencies
inspect dependents
inspect security
inspect workflow
```

This reduces token and tooling overhead.

---

# 114. Pagination

For very large semantic inventories, AgentAPI MAY support pagination.

Pagination must be deterministic and must not change semantic results.

---

# 115. Stable ordering

Collections returned for machine consumption SHOULD use canonical ordering where semantic order is not meaningful.

This improves:

```text
diff stability
testability
AI context efficiency
```

---

# 116. Large graph requirement

Tooling must not assume toy graph sizes.

A graph with:

```text
thousands of semantic nodes
```

should remain inspectable without requiring quadratic full-graph analysis for every request where avoidable.

No strict performance target is frozen in alpha.1, but pathological algorithms should be avoided.

---

# 117. Analysis caching

Implementations MAY cache semantic analysis.

Cache keys must account for:

```text
semantic graph identity
analysis contract/version
relevant analysis options
```

Caching must never return analysis for another semantic graph.

---

# 118. Analysis contract versioning

If structured AgentAPI result shapes become public machine contracts, they MUST carry explicit versioning.

Recommended concept:

```text
axiom.agent.v1
```

or equivalent.

Exact identifier is implementation-defined for alpha.1.

---

# 119. Why AgentAPI needs versioning

0.17 will require an independent runtime.

External tooling must therefore know which semantic inspection contract it consumes.

Do not rely solely on npm package version as the machine protocol.

---

# 120. AgentAPI contract scope

A versioned AgentAPI contract SHOULD cover:

```text
inventory
node inspection
dependency analysis
authorization analysis
capability analysis
semantic diff
diagnostics
authoring metadata
graph edits
```

where implemented.

---

# 121. Server IR relationship

AgentAPI and Server IR serve different purposes.

```text
Server IR
    execution-oriented semantic contract

AgentAPI
    inspection/analysis/authoring contract
```

Do not overload Server IR with tooling-only metadata merely because AgentAPI needs it.

---

# 122. Server IR v10 decision

Introduce:

```text
axiom.server.v10
```

ONLY if 0.16 adds serialized execution semantics required by runtimes.

If 0.16 changes only:

```text
inspection
analysis
authoring metadata
tooling APIs
```

retain:

```text
axiom.server.v9
```

This decision must be explicit in the implementation report.

---

# 123. Conformance v10

0.16 SHOULD introduce:

```text
axiom.conformance.v10
```

because tooling itself becomes a machine-facing semantic contract.

The conformance suite should validate both runtime preservation and AgentAPI semantics.

---

# 124. Conformance categories

Suggested v10 categories:

```text
inventory
dependencies
explain-action
explain-query
explain-workflow
authorization-analysis
capabilities
semantic-diff
diagnostics
authoring-schema
graph-edit
native-boundary
```

---

# 125. Independent expected results

Conformance fixtures MUST contain expected semantic results independently specified.

Do not generate expected output by calling the implementation under test.

---

# 126. Cross-tool consistency

For a graph:

```text
validateGraph
AgentAPI
CLI
Server IR
semanticFingerprint
```

must not disagree about semantic identity or validity.

Example forbidden inconsistency:

```text
validateGraph says ActionDef X does not exist
AgentAPI lists X
Server IR executes X
```

---

# 127. Runtime preservation

0.16 tooling must not alter application runtime meaning.

Primary preservation invariant:

```text
observableMeaning(execute(G, 0.15 runtime semantics))
==
observableMeaning(execute(G, 0.16 runtime semantics))
```

for graphs using no new execution semantics.

---

# 128. Authorization preservation

All frozen 0.15 authorization semantics remain unchanged.

Mandatory regressions include:

```text
F1 absent-value new policy
F1-legacy
F2 malformed policy
F3 authenticate boundary
legacy ∧ new-policy conjunction
live revocation
workflow authorization
principal isolation
```

---

# 129. Distributed preservation

All frozen distributed semantics remain unchanged:

```text
fencing
leases
logical effects
scheduler firing identity
event dedup
subscription cursor ownership
state coherence
mixed-runtime fail closed
```

---

# 130. Live preservation

All frozen live-query semantics remain unchanged:

```text
mutation observation
revision coherence
authorization reevaluation
resume
principal-bound cursor
failover
```

---

# 131. Workflow preservation

All frozen workflow semantics remain unchanged:

```text
durability
single-assignment bindings
action invocation identity
timer/event waits
retry
cancellation
principal behavior
failover
```

---

# 132. Migration preservation

0.11 migration/schema behavior remains unchanged unless 0.16 authoring analysis merely explains it.

Tooling must not execute migrations as part of static analysis.

---

# 133. Analysis must not cause semantic effects

Calling:

```text
inspect
analyze
explain
diff
validate candidate
```

MUST NOT:

```text
mutate state
write persistence
create workflow instances
emit logical effects
invoke providers
advance scheduler state
consume events
```

Static tooling is side-effect free.

---

# 134. Provider isolation during analysis

Static analysis MUST NOT require a live provider merely to understand graph structure.

Capability compatibility checks MAY accept a provider capability descriptor.

They should not invoke the provider to discover semantics unless explicitly a separate runtime-inspection API.

---

# 135. No credentials required for static graph meaning

Static graph analysis should not require application user credentials.

Authorization policy structure can be analyzed without authenticating a user.

Concrete decision explanation is separate and may accept an explicit principal/resource context.

---

# 136. Concrete authorization explanation side effects

`explainAuthorizationDecision` MUST evaluate authorization without executing the protected operation.

Required:

```text
decision explanation
mutation count = 0
effect count = 0
provider mutation count = 0
```

---

# 137. Counterfactual analysis

0.16 MAY support counterfactual questions such as:

```text
Would principal P be allowed to invoke action A?
```

provided this uses pure semantic evaluation.

This MUST NOT become a new authorization execution path.

---

# 138. Counterfactual warning

Counterfactual authorization is advisory.

The real operation MUST reauthorize through the canonical runtime boundary.

A prior tooling result is never an authorization token.

---

# 139. Explain denial

For concrete authorization analysis, safe denial reasons SHOULD distinguish:

```text
legacy authorization denied
authorization policy denied
workflow owner mismatch
instance access policy denied
row policy exclusion
authentication error where represented
```

without leaking secrets.

---

# 140. Explain allow

Likewise an ALLOW explanation SHOULD identify which applicable authorization mechanisms were satisfied.

Do not merely return:

```text
true
```

when structured provenance is available.

---

# 141. Policy truth provenance

For `AuthorizationPolicyDef`, tooling SHOULD expose safe expression-level provenance sufficient to explain:

```text
which branch allowed
which branch denied
which security field was absent
```

for trusted tooling contexts.

Public server responses need not expose this detail.

---

# 142. Trusted tooling boundary

Deep graph inspection is a developer/operator capability.

0.16 does NOT automatically expose AgentAPI inspection over an unauthenticated production HTTP endpoint.

Transport/exposure is separate from semantic API capability.

---

# 143. No automatic production introspection endpoint

Implementing AgentAPI MUST NOT silently create:

```text
GET /agent-api
```

or equivalent public production surface.

Any remote exposure requires explicit host/tool integration.

---

# 144. Authoring and production authority

The ability to author a graph does not imply permission to deploy it.

0.16 defines semantic authoring tools.

Deployment authorization is out of scope.

---

# 145. Graph edit safety

Applying a graph edit through tooling must not mutate the currently executing graph unless an explicit higher-level integration chooses to replace/redeploy it.

Default workflow:

```text
G
+
edit
=
candidate G'
```

---

# 146. Deterministic IDs

Authoring tooling MUST NOT silently invent unstable semantic IDs where stable IDs are required.

If ID generation is supported, it must be explicit and deterministic or clearly returned to the caller.

---

# 147. AI-friendly errors

When an AI proposes an invalid graph/edit, diagnostics SHOULD make correction mechanically possible.

Example:

```text
code: INVALID_REFERENCE_TARGET
path: actions.approve.authorizationPolicy
expectedKinds: [AuthorizationPolicyDef]
actualKind: QueryDef
```

This is preferable to:

```text
Invalid graph.
```

---

# 148. Suggested remediation

Diagnostics MAY include deterministic remediation hints.

Example:

```text
missing required field: resultType
```

may expose:

```text
requiredField: "resultType"
```

Do not generate speculative natural-language fixes inside core.

---

# 149. Enumerating valid alternatives

When invalid input uses a closed vocabulary, diagnostics SHOULD expose valid alternatives.

Example:

```text
invalid workflow step kind
validKinds:
  action
  wait-event
  timer
  branch
  complete
  fail
```

---

# 150. Reference search

AgentAPI SHOULD support semantic reference search:

```text
find all references to node X
```

with provenance.

This is essential for safe rename/removal tooling.

---

# 151. Removal analysis

Before removing semantic node X, tooling SHOULD identify:

```text
references that would become invalid
```

and candidate graph validation must reject unresolved references.

---

# 152. Rename

If semantic IDs are identity, rename semantics must be explicit.

Do not pretend changing:

```text
id
```

is presentation-only if it changes semantic references/identity.

Tooling MAY provide coordinated rename as an edit set.

---

# 153. Coordinated rename

A rename helper SHOULD:

```text
change node id
rewrite semantic references
validate candidate graph
show semantic diff
```

without changing unrelated nodes.

---

# 154. Semantic metadata edits

Changing only non-semantic tooling/source metadata SHOULD NOT change:

```text
semanticFingerprint
runtime compatibility
execution meaning
```

where those fields are explicitly non-semantic.

---

# 155. Presentation changes

Presentation changes remain distinct from execution/security semantics.

Diff must classify them appropriately.

A presentation change MUST NOT be described as an authorization change unless it actually changes authorization semantics.

---

# 156. Authorization change detection

These MUST be classified as authorization-semantic changes:

```text
attach policy
detach policy
change policy expression
change legacy ActionDef.authorization
change ReadPolicyDef
change WorkflowDef.startPolicy
change WorkflowDef.instanceAccessPolicy
```

---

# 157. Query change detection

Changes to:

```text
source
filter
sort
limit
aggregation
authorization
row policy
```

must be visible in semantic diff.

---

# 158. Workflow change detection

Changes to:

```text
step kind
action target
branch condition
timer
event wait
binding
terminal outcome
authorization
```

must be visible.

---

# 159. State change detection

Changes to:

```text
type
schema
persistence semantics
initial semantics
```

must be visible and appropriately classified.

---

# 160. Provider change detection

Tooling must distinguish:

```text
semantic provider requirement changed
```

from:

```text
deployment chose another adapter implementing same requirement.
```

Only the former is graph semantic change.

---

# 161. Explain graph

AgentAPI SHOULD support a high-level graph summary.

It should answer:

```text
What kind of application is represented structurally?
How many semantic nodes by kind?
What are executable roots?
What security boundaries exist?
What external capabilities are required?
What opaque boundaries exist?
```

The first question must remain structural; core must not invent business-domain prose unsupported by semantic metadata.

---

# 162. Statistics

Graph statistics MAY include:

```text
node counts
edge counts
NativeOperation count
protected/public root counts
workflow counts
provider capability counts
```

These are tooling facts, not semantic behavior.

---

# 163. Machine-readable documentation

0.16 SHOULD make semantic vocabulary documentation derivable from the same metadata used by authoring.

Goal:

```text
docs
types
validation
AgentAPI authoring schema
```

cannot silently drift.

---

# 164. Documentation generation

Generated reference documentation MAY be added.

Handwritten conceptual documentation remains useful.

Generated reference docs should cover closed structural vocabulary.

---

# 165. Self-description

Axiom tooling SHOULD be able to describe its supported semantic vocabulary without hardcoding that knowledge into an external AI prompt.

This is a central 0.16 objective.

---

# 166. AI bootstrapping

An AI agent with only:

```text
AgentAPI contract
an Axiom graph
```

should be able to discover enough vocabulary to perform a simple valid edit.

It should not require a maintainer-written hidden prompt enumerating every node kind.

---

# 167. AI authoring acceptance scenario A

Given a graph containing:

```text
StateDef.counter
```

and available semantic authoring metadata, an external agent is asked to add an action that increments the counter.

The agent must be able to discover:

```text
valid ActionDef structure
how to reference StateDef.counter
valid mutation semantics
required fields
```

construct a candidate edit, validate it, and receive a semantic diff.

No arbitrary JS.

---

# 168. AI authoring acceptance scenario B

Given a public action, an external agent is asked to protect it with a role policy.

The agent must be able to discover:

```text
AuthorizationPolicyDef
PRINCIPAL scope
valid expression vocabulary
ActionDef.authorizationPolicy reference
```

and construct a valid candidate graph.

---

# 169. AI authoring acceptance scenario C

Given an action protected by:

```text
PRINCIPAL.role == "admin"
```

an external agent is asked:

```text
Why can't an anonymous caller invoke this?
```

AgentAPI must provide enough structured information to answer correctly without guessing.

---

# 170. AI authoring acceptance scenario D

Given:

```text
PRINCIPAL.role != "banned"
```

an external agent asks whether anonymous is allowed.

Required semantic answer:

```text
DENY
```

because missing security fields cannot create ALLOW.

This explicitly preserves the 0.15 F1/F1-legacy closure.

---

# 171. AI authoring acceptance scenario E

Given two graph revisions differing only by presentation metadata:

```text
semantic diff:
  presentation change

semanticFingerprint:
  unchanged
```

Tooling must explain this correctly.

---

# 172. AI authoring acceptance scenario F

Given two graphs differing in authorization policy:

```text
semantic diff:
  authorization change

semanticFingerprint:
  changed
```

Tooling must identify the responsible policy edge/node.

---

# 173. AI authoring acceptance scenario G

Given an action containing NativeOperation, an agent asks:

```text
What can this action affect?
```

Required:

```text
known semantic effects listed
opaque NativeOperation boundary explicitly reported
analysis marked incomplete/unknown beyond boundary
```

Forbidden:

```text
"No other effects."
```

---

# 174. AI authoring acceptance scenario H

Agent proposes removal of a StateDef still referenced by an ActionDef.

Required:

```text
candidate graph invalid
structured unresolved-reference diagnostic
reference provenance points to ActionDef
```

---

# 175. AI authoring acceptance scenario I

Agent proposes three coordinated edits where intermediate states are invalid but final candidate is valid.

Required:

```text
atomic edit set accepted as candidate
final graph validated
semantic diff returned
```

---

# 176. AI authoring acceptance scenario J

Agent applies an edit with stale precondition.

Required:

```text
explicit conflict
no silent overwrite
```

---

# 177. External tooling acceptance

At least one fresh external consumer must be able to:

```text
install published packages
load/build a graph
inspect it
validate it
query authoring metadata
apply candidate edit
compute semantic diff
explain authorization
```

without repository source access.

---

# 178. Discoverability gate D1

A blind external evaluator using only shipped artifacts must be able to discover:

```text
AgentAPI entry points
analysis contract/version
semantic vocabulary
diagnostic codes
authoring metadata
graph edit representation
diff semantics
authorization explanation semantics
NativeOperation opacity behavior
```

No maintainer guidance.

---

# 179. Expressibility gate E1

External evaluation must demonstrate that tooling can represent/explain at least:

```text
state dependency
action mutation
query read
workflow action edge
authorization policy
legacy authorization
row policy
provider capability
NativeOperation boundary
semantic diff
candidate edit
```

without raw JS.

---

# 180. Safety gate S1

External evaluation must demonstrate:

```text
analysis causes no semantic effects
invalid edits fail explicitly
stale edits conflict explicitly
authorization explanation matches runtime
absence semantics remain fail closed
NativeOperation uncertainty is not hidden
secrets are not exposed
mixed-runtime semantics remain fail closed
```

---

# 181. Independent-runtime preparation

0.16 is the direct preparation milestone for:

```text
0.17 — Independent Runtime + Cross-runtime Conformance
```

Therefore every new analysis contract must avoid assumptions tied to the TypeScript runtime implementation.

---

# 182. No JavaScript object identity contract

AgentAPI output must not require consumers to understand:

```text
prototype chains
class instances
closures
function identity
```

Machine-facing semantics must be serializable.

---

# 183. No source-code dependency

An independent runtime/tool must not need to parse Axiom's TypeScript implementation to understand AgentAPI output.

---

# 184. Portable graph edits

If graph edits become a public contract, they must be expressible independently of:

```text
AST transforms
TypeScript source rewriting
JavaScript closures
```

They operate on semantic graph identity.

---

# 185. Source rewriting is adapter territory

A future IDE may translate:

```text
semantic graph edit
```

into:

```text
TypeScript source edit
```

That source transformation is tooling/adapter behavior.

It is not the semantic graph-edit contract itself.

---

# 186. Conformance: inventory

Fixture graph contains representative nodes.

Expected inventory must match exactly:

```text
ids
kinds
canonical relationships
```

---

# 187. Conformance: dependencies

Fixture includes multi-hop dependencies.

Validate:

```text
direct
transitive
reverse
provenance
```

---

# 188. Conformance: action explanation

Fixture ActionDef includes:

```text
reads
writes
authorization
effect
workflow caller
```

Expected explanation independently specified.

---

# 189. Conformance: query explanation

Fixture QueryDef includes:

```text
provider source
filter
row policy
limit
live capability
```

Expected explanation independently specified.

---

# 190. Conformance: workflow explanation

Fixture workflow includes all six frozen workflow step kinds where practical:

```text
action
wait-event
timer
branch
complete
fail
```

Expected control-flow analysis independently specified.

---

# 191. Conformance: authorization

Fixtures cover:

```text
new policy
legacy policy
new + legacy conjunction
anonymous absent field
owner/tenant policy
workflow owner baseline
instance policy
row policy
```

---

# 192. Conformance: semantic diff

Fixtures cover:

```text
add
remove
semantic change
authorization change
presentation-only change
reordering no-op
```

---

# 193. Conformance: NativeOperation

Fixture contains opaque boundary.

Expected analysis explicitly includes:

```text
opaque/incomplete
```

---

# 194. Conformance: candidate edits

Fixtures cover:

```text
valid add
valid coordinated edit
invalid reference
invalid kind
stale precondition
remove referenced node
```

---

# 195. Conformance: diagnostics

Validate stable:

```text
code
severity
path
semantic identity
```

Do not require exact prose wording unless explicitly part of contract.

---

# 196. Conformance: side-effect freedom

Instrument:

```text
state writes
provider writes
workflow starts
logical effects
event consumption
scheduler mutations
```

Run tooling analysis.

Required:

```text
all counters = 0
```

---

# 197. Conformance: runtime agreement

For representative authorization cases:

```text
AgentAPI explain decision
runtime actual decision
```

must agree.

Tooling explanation cannot define an alternate authorization evaluator.

---

# 198. Conformance: malformed input totality

Fuzz/adversarial malformed:

```text
graphs
expressions
edit operations
references
analysis requests
```

Expected:

```text
structured error/diagnostic
no native crash
```

---

# 199. Conformance: deterministic output

Run identical analysis repeatedly.

Canonical structured result must remain semantically identical.

---

# 200. External validation topology

External validation should use:

```text
fresh consumer project
published @cynodia/* packages only
no workspace links
no repository source
```

as established by prior campaigns.

---

# 201. Runtime regression topology

Runtime regression continues to exercise:

```text
memory
SQLite
1 authority
2 authorities
8 authorities
real OS processes
SIGKILL
SIGSTOP
rolling deployment
```

where relevant to preservation testing.

Tooling-only tests need not manufacture distributed topology where no runtime semantics are exercised.

---

# 202. Blindness

External evaluator may use:

```text
published package exports
.d.ts
generated schemas
shipped docs
AgentAPI
CLI
conformance fixtures
```

It may not use:

```text
repository source
internal implementation report
maintainer explanation of implementation details
internal tests
```

---

# 203. Validation report

External campaign must produce:

```text
environment
package versions
contract versions
discoverability result
expressibility result
safety result
section summaries
findings
forbidden counters
raw evidence
harness snapshot
final verdict
```

---

# 204. Forbidden counters

At minimum include:

```text
analysis_state_mutation
analysis_provider_mutation
analysis_effect_creation
analysis_workflow_start
analysis_event_consumption
analysis_scheduler_mutation

authorization_explanation_mismatch
authorization_fail_open
legacy_authorization_fail_open

secret_disclosure

invalid_edit_accepted
stale_edit_silent_overwrite
unresolved_reference_accepted

opaque_boundary_hidden
semantic_diff_false_negative
semantic_diff_false_security_classification

agentapi_native_exception
nondeterministic_analysis_result

mixed_runtime_semantic_acceptance
```

All must finish:

```text
0
```

---

# 205. Prior security forbidden counters

All relevant 0.15 forbidden counters remain zero.

0.16 tooling must not reopen:

```text
anonymous authorization bypass
cross-principal idempotency reuse
cross-principal cursor reuse
workflow principal bypass
credential fallback
authenticate exception leakage
```

---

# 206. Release-blocking finding classes

Examples:

```text
F1
AgentAPI explanation disagrees with runtime authorization.

F2
Analysis mutates semantic/runtime state.

F3
Semantic diff omits an authorization change.

F4
Invalid AI edit is accepted as a valid graph.

F5
NativeOperation opacity is silently hidden.

F6
Machine-readable authoring metadata cannot describe a public semantic node.

F7
Tooling requires repository/source implementation knowledge.

F8
AgentAPI leaks credentials/secrets.

F9
Structured analysis is nondeterministic for identical input.

F10
0.16 changes frozen 0.15 runtime semantics without explicit new milestone scope.
```

Any such substantive finding blocks freeze.

---

# 207. Internal implementation phases

Recommended implementation order:

```text
Phase A — AgentAPI contract + inventory
Phase B — dependency/reference graph
Phase C — explain action/query/workflow/state
Phase D — authorization/security analysis
Phase E — capability + NativeOperation analysis
Phase F — semantic diff
Phase G — authoring metadata
Phase H — graph edit/candidate validation
Phase I — CLI/renderers
Phase J — conformance v10
Phase K — adversarial + prior regression
Phase L — published external validation
```

---

# 208. Phase A gate

Before proceeding:

```text
AgentAPI contract versioned
inventory complete
stable semantic identities
structured output
deterministic ordering
```

---

# 209. Phase B gate

```text
direct dependency
reverse dependency
transitive dependency
reference provenance
cycle safety
```

green.

---

# 210. Phase C gate

Representative:

```text
StateDef
ActionDef
QueryDef
WorkflowDef
```

explanations complete enough to support external tooling.

---

# 211. Phase D gate

Authorization explanation agrees with canonical runtime for:

```text
new policy
legacy
combined
anonymous
missing attributes
workflow
query
row policy
```

---

# 212. Phase E gate

Capability and NativeOperation analysis:

```text
complete where knowable
explicitly unknown where opaque
```

---

# 213. Phase F gate

Semantic diff correctly classifies:

```text
semantic
security
presentation
metadata
no-op
```

changes.

---

# 214. Phase G gate

Machine-readable authoring metadata covers every public semantic node kind.

Coverage MUST be mechanically checked.

---

# 215. Phase H gate

Candidate edit system supports:

```text
valid edits
atomic edit sets
validation
preconditions
conflict
semantic diff
```

without runtime mutation.

---

# 216. Phase I gate

CLI or equivalent external tooling proves AgentAPI can be consumed without custom internal code.

CLI itself is not required to freeze if an equivalent public consumer demonstrates the contract, but is strongly recommended.

---

# 217. Phase J gate

`axiom.conformance.v10` or equivalent new tooling conformance tier is published and independently runnable.

---

# 218. Phase K gate

All:

```text
0.15 authorization
0.14 workflows
0.13 live
0.12 distributed
0.11 migrations
```

relevant regression suites remain green.

---

# 219. Phase L gate

Published-package blind validation returns:

```text
D1 / E1 / S1
```

with no release blockers.

---

# 220. Documentation requirements

Before external validation, shipped docs must explain:

```text
AgentAPI purpose
analysis contract/version
inventory
dependencies
explanation
semantic diff
authoring metadata
candidate edits
validation workflow
NativeOperation opacity
static vs runtime analysis
authorization decision explanation
```

---

# 221. Documentation must not overclaim

Do not say:

```text
AgentAPI can fully determine all effects
```

when NativeOperation exists.

Do not say:

```text
AI-generated graphs are safe
```

merely because they validate.

Correct framing:

```text
Axiom provides deterministic semantic validation and analysis of represented semantics.
```

---

# 222. Implementation report

Produce:

```text
reports/AXIOM_0_16_IMPLEMENTATION_REPORT.md
```

or current project equivalent.

It should map implementation to specification sections and identify:

```text
contract versions
public APIs
known limitations
NativeOperation analysis boundary
Server IR version decision
conformance version
test counts
release gates
```

---

# 223. Contract freeze discipline

Do not freeze AgentAPI result shapes prematurely during alpha implementation.

Before external validation, consolidate them into a deliberate machine contract.

After successful 0.16 external validation, breaking changes require explicit future contract versioning.

---

# 224. Relationship to 0.17

0.16 is successful if an independent implementer can inspect the published semantic contracts and reasonably begin implementing:

```text
graph loader
semantic analyzer
authorization explanation
conformance consumer
```

without reading Axiom runtime source.

0.17 will test whether that independence extends to execution.

---

# 225. Final semantic invariant

After 0.16:

```text
Axiom application meaning is not trapped inside the runtime implementation.

The semantic graph can describe itself through a deterministic,
serializable, versioned machine-facing contract.

Humans and AI agents can inspect dependencies, authorization,
capabilities, workflows, mutations, effects and opaque boundaries.

They can propose structured semantic edits, validate candidate graphs,
and inspect the resulting semantic diff before execution.

Tooling observes and manipulates semantic representation;
it does not invent application meaning.
```

---

# 226. Final AI-authoring invariant

```text
An AI agent should not need to guess Axiom.

It can discover the vocabulary,
construct semantic structures,
receive deterministic diagnostics,
inspect consequences,
and correct invalid proposals.

The runtime remains the authority on execution.
The graph remains the authority on meaning.
The AI remains an authoring/tooling consumer.
```

---

# 227. Freeze criteria

Axiom 0.16 may freeze only when all are true:

```text
[ ] public AgentAPI machine contract defined
[ ] semantic inventory complete
[ ] dependency analysis complete
[ ] action/query/workflow/state explanation available
[ ] authorization explanation agrees with 0.15 runtime
[ ] capability analysis available
[ ] NativeOperation opacity explicit
[ ] semantic diff available
[ ] authoring metadata covers public vocabulary
[ ] candidate graph edits validate before execution
[ ] atomic edit sets supported
[ ] stale edit conflicts explicit
[ ] diagnostics structured and stable
[ ] analysis side-effect free
[ ] analysis deterministic
[ ] malformed input total
[ ] Server IR version decision explicit
[ ] tooling conformance published
[ ] prior runtime regression green
[ ] published-package consumer green
[ ] blind external validation D1
[ ] blind external validation E1
[ ] blind external validation S1
[ ] all forbidden counters zero
[ ] no open release-blocking findings
```

---

# 228. Expected milestone result

Successful completion should produce:

```text
Axiom 0.16 — Tooling / Explainability / AI Authoring

AgentAPI:
  VERSIONED
  STRUCTURED
  DETERMINISTIC
  SERIALIZABLE

Semantic inspection:
  COMPLETE FOR REPRESENTED SEMANTICS

Dependency analysis:
  COMPLETE / CONSERVATIVE

Authorization explanation:
  AGREES WITH RUNTIME

NativeOperation:
  EXPLICIT OPAQUE BOUNDARY

Semantic diff:
  AVAILABLE

AI authoring:
  VOCABULARY DISCOVERABLE
  STRUCTURED EDITS
  CANDIDATE VALIDATION
  IMPACT ANALYSIS

Runtime regression:
  GREEN

External validation:
  D1 / E1 / S1

SEMANTIC MODEL FROZEN
```

---

# 229. Next milestone

After successful 0.16 freeze:

```text
Axiom 0.17
Independent Runtime + Cross-runtime Conformance
```

0.17 should then answer the stronger question:

```text
Can an implementation that did not build Axiom reproduce
the same application meaning and observable execution behavior
from the frozen semantic contracts?
```