# Axiom 0.15 Specification — Authorization Completeness

**Target:** `0.15.0-alpha.1`  
**Baseline:** `0.14.0-alpha.5` — Durable Workflows, externally validated `D1 / E1 / S1`  
**Status:** New semantic milestone  
**Expected Server IR:** `axiom.server.v9`  
**Expected Conformance:** `axiom.conformance.v9`

---

# 1. Purpose

Axiom 0.15 makes authorization a complete, explicit, inspectable part of the Axiom semantic model.

The central goal is:

```text
Every operation that can observe, mutate, trigger, subscribe to,
or otherwise affect semantic application state has a defined
authorization boundary.
```

Authorization must no longer depend on which public API, runtime path, asynchronous continuation, provider adapter, or topology happens to execute the operation.

A valid Axiom application must not contain semantic operations for which authorization behavior is undefined or accidentally bypassed.

---

# 2. Primary invariant

For any semantic operation `O`, principal `P`, graph `G`, and compatible runtime topology:

```text
authorizationMeaning(G, O, P)
```

must be invariant across execution paths.

In particular:

```text
direct API invocation
workflow invocation
scheduled invocation
event-triggered invocation
live-query evaluation
reconnect/resume
failover
multi-authority execution
```

must not change whether `P` is authorized.

Equivalent operations must have equivalent authorization semantics.

---

# 3. Security principle

UI visibility is not authorization.

Client possession of:

```text
instanceId
recordId
queryId
eventId
workflowId
actionId
subscription cursor
```

does not grant access.

Authorization must be enforced at the semantic execution boundary.

Every privileged semantic operation must fail closed when the runtime cannot establish an authorization decision.

---

# 4. Scope

0.15 must define authorization semantics for at least:

```text
ActionDef invocation
QueryDef execution
provider-backed record reads
provider-backed record mutations
StateDef authoritative mutation
EventDef ingress where application-visible
WorkflowDef start
Workflow instance inspection
Workflow cancellation
Workflow continuation into ActionDef
live canonical queries
live-query resume/reconnect
subscriptions
scheduler-triggered semantic operations
external effects invoked through authorized actions
AgentAPI inspection where principal-sensitive
```

Where an existing primitive is intentionally public/unrestricted, that must be explicit in the semantic model rather than being the absence of a check.

---

# 5. Existing authorization model

Preserve the existing Axiom authorization machinery wherever semantically sound.

0.15 should consolidate authorization rather than introduce parallel mechanisms.

Existing concepts such as:

```text
Principal
credential resolution
principal fingerprint
ActionDef authorization
ReadPolicy
workflow start principal
AUTHORIZATION_DENIED
```

should be incorporated into one coherent authorization model.

Do not create:

```text
ActionAuthorization
WorkflowAuthorization
QueryAuthorization
LiveAuthorization
```

as unrelated mechanisms.

There should be one authorization language and one authorization decision model.

---

# 6. Authorization is semantic

Authorization rules that affect whether an operation may occur are executable semantics.

They therefore belong in:

```text
semanticFingerprint
authority compatibility
Server IR
conformance
AgentAPI analysis
```

where applicable.

Changing an authorization rule must not be treated as a presentation-only change.

A mixed-build authority with authorization semantics incompatible with an active semantic operation must fail closed.

---

# 7. Authorization policy model

Introduce or formalize a canonical authorization policy representation.

The policy representation must be:

```text
serializable
deterministic
inspectable
statically analyzable
runtime-independent
free of arbitrary host-language callbacks
```

No raw JavaScript predicate may be used as portable authorization semantics.

The exact graph shape may reuse or generalize existing policy constructs, but the resulting model must be able to express authorization over:

```text
principal identity
principal claims / roles / attributes
resource identity
resource fields where safely available
operation identity
workflow ownership/context where applicable
```

without introducing ambient runtime state.

---

# 8. Authorization decision

Every authorization decision should produce a canonical outcome.

Minimum:

```text
ALLOW
DENY
```

Optional internal diagnostic context may include:

```text
policy id
rule id
operation
resource
reason
```

but semantic execution must not depend on non-portable diagnostic text.

Failure to evaluate authorization safely must mean:

```text
DENY
```

not:

```text
ALLOW
```

---

# 9. No implicit allow through missing policy

The model must explicitly define behavior when no policy is attached.

Choose one canonical rule and apply it consistently.

Preferred compatibility model:

```text
existing primitives whose current contract is public
    → explicit/default public policy

existing primitives whose current contract is restricted
    → preserve current restriction

new privileged surfaces
    → fail closed unless explicitly authorized
```

Do not allow authorization meaning to vary by runtime implementation.

---

# 10. ActionDef

ActionDef authorization remains authoritative for action invocation.

Required:

```text
direct action call
workflow action step
scheduler-triggered action
event-triggered action
retry
failover reconciliation
```

must all evaluate the same action authorization contract.

A workflow must not gain authority merely because the workflow itself was started by an authorized principal.

Each ActionDef invocation must be authorized under the effective principal at the time of invocation.

This preserves the 0.14 invariant:

```text
authorization is re-evaluated at each action step
```

---

# 11. Current-policy re-evaluation

Authorization must be evaluated against current policy at the point where the semantic operation occurs.

Example:

```text
T0:
principal P starts workflow W

T1:
policy allows P to invoke action A

T2:
policy changes and now denies P

T3:
workflow reaches action A
```

Required:

```text
A is denied at T3
```

unless an explicit semantic primitive defines captured authorization.

0.15 must not introduce implicit privilege snapshots.

---

# 12. Workflow principal

A workflow instance retains its canonical start principal identity durably.

This principal is the default effective principal for workflow continuation.

No raw credential is persisted.

Persist only canonical principal identity/claims representation required by the runtime contract.

Failover must not change the effective principal.

---

# 13. Workflow instance access

0.14 established owner-fingerprint cancellation semantics.

0.15 must formalize workflow instance authorization rather than leave it as an isolated special case.

Define authorization for:

```text
getWorkflow
inspectWorkflow
workflow history
cancelWorkflow
resume/retry administrative operations if exposed
```

At minimum, instance ownership must remain safe.

If 0.15 introduces policy-based access broader than owner-only, it must be explicit and analyzable.

Do not silently broaden 0.14 access merely because a caller has a role such as `admin`.

---

# 14. Workflow cancellation

Cancellation must remain an authorized durable mutation.

The 0.14 behavior:

```text
caller principal fingerprint
==
workflow instance principal fingerprint
```

is the compatibility baseline.

0.15 may generalize this through canonical policy semantics, but only if:

```text
owner cancellation remains representable
cross-principal authorization is explicit
no implicit role bypass exists
```

Unauthorized cancellation must mutate nothing.

---

# 15. Workflow inspection

Reading a workflow instance can reveal:

```text
inputs
bindings
principal identity
action outcomes
event payload-derived values
failure information
history
```

Therefore inspection is security-sensitive.

Authorization must cover at least:

```text
getWorkflow
inspectWorkflow
history
list/query workflows if exposed
```

Knowledge of `instanceId` is not sufficient authorization.

---

# 16. QueryDef authorization

Canonical queries must have explicit read authorization semantics.

Authorization must apply consistently to:

```text
one-shot query
live query initial snapshot
live query update
resume/reconnect
cross-authority live query
```

A live query must never continue emitting data that the effective principal is no longer authorized to observe.

---

# 17. Row-level read authorization

If QueryDef can return provider records subject to policy, each observable result must respect the applicable read policy.

Authorization filtering must be semantically defined.

Forbidden:

```text
query retrieves unauthorized rows
runtime sends them and expects UI to hide them
```

or:

```text
one-shot query filters them
live query does not
```

One-shot and live-query authorization meaning must match.

---

# 18. Authorization and query semantics

Authorization filtering must compose deterministically with:

```text
filter
sort
limit
pagination
aggregation where supported
```

The semantic order must be explicitly defined.

Preferred rule:

```text
authorized dataset
    ↓
query semantic operations
    ↓
observable result
```

rather than applying authorization only after limit/pagination, which could leak information or produce topology-dependent results.

Example:

```text
100 rows
caller may read 10
query limit 5
```

must mean:

```text
limit 5 over the 10 authorized rows
```

not:

```text
limit 5 globally, then remove unauthorized rows
```

unless the model explicitly specifies otherwise.

---

# 19. Live-query reauthorization

A live query is not authorized only once at open time.

The system must address policy changes during an active subscription.

Required invariant:

```text
principal loses permission to row/resource/query
    →
future observable live-query state reflects that loss
```

The implementation may trigger:

```text
delta removal
reset
authorization error / close
```

depending on the semantic situation.

It must not silently continue serving now-unauthorized data indefinitely.

---

# 20. Live-query reconnect / cursor security

A live-query cursor is not a bearer authorization token.

Resume must:

```text
resolve current caller principal
verify cursor integrity/compatibility
re-evaluate authorization
```

A cursor created for principal `P1` must not allow `P2` to inherit `P1`'s access.

Required adversarial case:

```text
P1 opens authorized live query
cursor C issued

P2 obtains C
P2 calls resumeLiveQuery(C)
```

Required:

```text
authorization refusal
```

unless policy independently authorizes P2 and cursor semantics explicitly permit principal-independent resume.

Prefer binding resume identity to the original principal.

---

# 21. StateDef authorization

Clarify the authorization boundary for authoritative StateDef operations.

If external/public APIs can:

```text
read state
write state
mutate state
```

those operations must be authorized.

Internal evaluation of state as part of an already-authorized semantic operation must not accidentally become a second inconsistent security mechanism.

Distinguish:

```text
authorization to invoke an operation
```

from:

```text
internal semantic reads required to evaluate that operation
```

---

# 22. DataProvider reads

Provider adapters must not define application authorization semantics.

A provider is infrastructure.

Authorization must be determined before or as part of canonical Axiom query execution.

Provider-specific ACL behavior may provide additional defense but must not be required for portable semantic correctness.

---

# 23. DataProvider mutations

Provider-backed mutation must be authorized through the semantic operation that causes it.

No public mutation path may bypass the ActionDef or equivalent authorization boundary.

Audit every API that can mutate canonical provider data.

Forbidden:

```text
authorized ActionDef path → checked
direct provider mutation API → unchecked
```

if both are public semantic surfaces.

---

# 24. Events

Define authorization semantics for application-visible event ingress.

Distinguish:

```text
trusted infrastructure event source
authenticated external principal event
internal semantic event
```

Do not treat all event producers as equivalent.

Where credentials are accepted, they must affect authorization.

Where events are infrastructure-authenticated outside Axiom, that trust boundary must be explicit in the adapter contract.

---

# 25. Workflow wait-event authorization

A workflow waiting for an EventDef must not gain access to event payloads that its principal is not authorized to observe if event authorization is principal-sensitive.

If EventDef semantics are globally visible by design, document that explicitly.

Do not allow event routing topology to bypass authorization.

---

# 26. Scheduler

Scheduler ownership is infrastructure, not principal authority.

A scheduled operation must execute using a canonical effective principal defined by the semantic object that scheduled it.

Forbidden:

```text
scheduler runs as SYSTEM/admin implicitly
```

unless a first-class system principal is explicitly part of the semantic model.

No ambient scheduler privilege.

---

# 27. Asynchronous continuation

Every durable asynchronous semantic operation must preserve enough identity to reconstruct the effective principal after:

```text
process restart
authority failover
lease transfer
retry
timer wake
event wake
```

Authorization meaning must not depend on process-local credential objects.

---

# 28. External effects

Effect execution remains governed by the ActionDef or semantic operation that created the logical effect.

An effect worker does not gain independent authority.

The worker may execute an already-authorized durable logical effect without re-running application authorization if the semantic commit already established the authorization decision.

Clearly distinguish:

```text
authorization of logical effect creation
```

from:

```text
physical retry of an already-authorized logical effect
```

Physical retries must not become new semantic authorization decisions.

---

# 29. Principal model

Define a canonical principal representation.

At minimum distinguish:

```text
authenticated principal
anonymous principal
```

If the existing model supports claims/roles/attributes, canonicalization must be deterministic.

Principal identity used for semantic decisions must not depend on:

```text
object identity
claim ordering
JSON property ordering
raw credential bytes
token formatting differences
process-local data
```

---

# 30. Principal fingerprint

Principal fingerprint remains infrastructure-facing canonical identity evidence.

Requirements:

```text
stable for semantically equivalent principal identity
different where authorization identity is meaningfully different
portable across authorities
durably reproducible
```

Do not use raw tokens as durable principal identity.

---

# 31. Credential resolution

Credential resolution happens at authority ingress.

Raw credentials may be:

```text
tokens
session objects
API keys
test credentials
```

but must resolve into canonical principal semantics before graph execution.

Credential adapters are infrastructure.

Application graph semantics must not inspect raw bearer tokens.

---

# 32. Anonymous principal

Anonymous access must be explicit.

`credential = null` or absent credentials must resolve consistently to a canonical anonymous principal where anonymous access is supported.

Do not use:

```text
no principal
```

as an accidental authorization bypass.

---

# 33. System principal

Do not introduce an omnipotent implicit SYSTEM principal.

If 0.15 requires infrastructure-originated semantic execution, define explicit semantics.

Any system principal must:

```text
be identifiable
be inspectable
be subject to explicit policy rules
not appear merely because execution is background work
```

Prefer preserving original user principal where possible.

---

# 34. Policy expressions

Authorization expressions must use a closed semantic scope.

Allowed sources may include:

```text
PRINCIPAL
resource fields
operation identity
explicit semantic context
```

Forbidden unless explicitly modeled:

```text
current process
node id
cluster size
environment variables
raw credential
filesystem
network lookup
Date.now()
random()
arbitrary JS
```

Authorization must remain deterministic for the same semantic inputs.

---

# 35. Policy dependency analysis

AgentAPI/compiler must be able to identify what a policy depends on.

Example output:

```text
principal fields:
  roles
  tenantId

resource fields:
  ownerId
  visibility

operation:
  read
```

This is important for:

```text
explainability
live-query invalidation
static analysis
AI authoring
conformance
```

---

# 36. Policy validity

Graph validation must reject policies that:

```text
reference unknown principal fields where schema-controlled
reference unavailable resource fields
use illegal expression scope
contain nondeterministic expressions
reference unsupported semantic primitives
contain malformed rule structure
```

No malformed policy may survive validation and fail later with native exceptions.

---

# 37. Totality

All public validation and analysis surfaces must be total over malformed authorization structures.

Required:

```text
validateGraph
compile
createAxiomServer
AgentAPI.validate
AgentAPI authorization analysis
```

must return structured diagnostics/refusal.

Forbidden:

```text
TypeError
ReferenceError
uncaught property traversal
silent normalization of malformed authorization rules
```

---

# 38. Structured authorization diagnostics

Use canonical diagnostics.

At minimum:

```text
AUTHORIZATION_DENIED
```

for runtime refusal.

Add validation diagnostics where needed, for example:

```text
AUTHORIZATION_INVALID_POLICY
AUTHORIZATION_INVALID_SCOPE
AUTHORIZATION_UNKNOWN_RESOURCE
AUTHORIZATION_UNSUPPORTED_EXPRESSION
```

Exact names may follow current naming conventions.

Do not expose secrets in messages.

---

# 39. Existence leakage

Authorization semantics must consider whether denied access reveals resource existence.

For APIs such as:

```text
getWorkflow(instanceId)
read record
inspect resource
```

choose a canonical behavior.

Possible approaches:

```text
NOT_FOUND for unauthorized resources
```

or:

```text
AUTHORIZATION_DENIED
```

The choice must be consistent and documented.

Do not let different runtimes disagree.

---

# 40. Side-channel minimization

0.15 is not required to provide cryptographic constant-time execution.

However, obvious semantic side channels must be avoided.

Examples:

```text
unauthorized query returns exact total count
unauthorized list operation leaks hidden ids
different API path reveals existence while another hides it
```

Conformance should cover semantic leakage, not timing micro-analysis.

---

# 41. List APIs

Any API that enumerates semantic resources requires authorization.

Examples:

```text
list workflows
list records
list subscriptions
inspect live queries
```

Internal administrative inspection APIs must have an explicit trust boundary.

Do not accidentally expose cross-principal resources through list endpoints while individual lookup is protected.

---

# 42. AgentAPI

AgentAPI must understand authorization semantics.

Add appropriate analysis surface, e.g.:

```text
analyzeAuthorization(...)
```

or extend existing analysis APIs.

It should be able to answer questions such as:

```text
Can principal shape P invoke ActionDef A?

What policy protects QueryDef Q?

Why is operation O denied?

What principal/resource fields does policy depend on?

Which graph operations have no explicit authorization boundary?

Can a workflow reach an action requiring permissions its start principal may not have?
```

Static analysis may return conditional/unknown where runtime values are required.

It must not falsely claim authorization where it cannot prove it.

---

# 43. Authorization coverage analysis

Introduce a graph-level audit.

Example conceptual result:

```text
ActionDef createInvoice
  protected: yes

QueryDef invoices
  protected: yes

WorkflowDef billingFlow
  start: protected
  inspect: protected
  cancel: protected
  action dependencies:
    createInvoice
    sendInvoice
```

The system should identify any public semantic surface whose authorization behavior is unresolved.

---

# 44. Explainability

Authorization denial should be explainable without leaking secrets.

AgentAPI may expose:

```text
decision: DENY
matchedRule
required condition
principal fields considered
resource fields considered
```

but must not expose:

```text
raw credentials
secret claims not part of semantic principal
provider secrets
tokens
```

---

# 45. Authorization and semanticFingerprint

Authorization-bearing graph structures must participate in canonical semantic identity.

Required adversarial tests:

```text
same graph, policy changes ALLOW → DENY
semanticFingerprint must change
```

and:

```text
presentation-only change
semanticFingerprint must remain unchanged
```

The 0.13/0.14 single-source-of-truth projection architecture must remain intact.

Do not introduce another hand-maintained semantic projection.

---

# 46. Mixed-build compatibility

Authorization semantic changes are compatibility changes.

Scenario:

```text
authority A:
policy allows P

authority B:
policy denies P

same durable application/workflow/query
```

They must not silently operate as compatible if their executable authorization meaning differs.

The existing compatibility gate must include the new authorization-bearing semantic projection automatically.

---

# 47. Active workflows under mixed builds

If a workflow instance was started under build A and build B is authorization-semantically incompatible:

```text
B must fail closed before semantic advancement
```

Same rule as 0.14.

Do not create a special authorization migration mechanism in 0.15.

---

# 48. Policy changes in compatible deployment

A deliberate graph/policy deployment that changes semanticFingerprint may require normal mixed-build compatibility handling.

Do not bypass compatibility just because the change is “only security”.

Security semantics are semantic.

---

# 49. Persistence

Persist only authorization state required for durable semantic correctness.

Likely examples:

```text
canonical workflow principal fingerprint
principal snapshot/canonical claims where existing workflow semantics require it
authorization-relevant durable operation identity
```

Avoid persisting raw credentials.

If schema changes are required, they must use the existing migration architecture from 0.11.

---

# 50. Captured claims vs current claims

This must be explicitly decided.

A workflow currently persists a start principal identity.

If role/claim membership can change externally after workflow start, determine whether later steps use:

```text
captured canonical claims
```

or:

```text
current identity re-resolution
```

Do not leave this accidental.

Preferred 0.15 rule:

```text
identity is durable
authorization policy is current
principal claims used by semantic policy are those in the canonical
principal established for the durable operation
```

unless Axiom has a first-class identity provider re-resolution contract.

Do not perform hidden network identity refresh as part of portable semantics.

---

# 51. Delegation

General delegation / impersonation is out of scope unless already present.

Do not add:

```text
actAs
sudo
assumeRole
delegation token
```

just to solve ordinary authorization.

If infrastructure requires impersonation, defer to a later explicit semantic design.

---

# 52. Multi-tenant correctness

Authorization must support tenant isolation patterns without runtime-specific hacks.

Representative policy:

```text
PRINCIPAL.tenantId == RESOURCE.tenantId
```

Required:

```text
query
mutation
workflow access
live query
```

must preserve tenant isolation.

Cross-tenant ids must not grant access.

---

# 53. TOCTOU

Authorization and mutation must not have an unsafe semantic gap.

For durable mutations, the authorization decision and the mutation must be based on a coherent authoritative view.

Do not implement:

```text
authorize
long delay
mutate stale object
```

without concurrency protection.

Existing transactional/CAS/fencing semantics should be used.

0.15 need not invent serializable global policy transactions, but obvious authorization TOCTOU must be prevented.

---

# 54. Query authorization consistency

For provider-backed records where policy depends on record fields, the policy must evaluate against the same canonical record version used by the query result.

Do not authorize one revision and return another revision without defined semantics.

---

# 55. Mutation authorization consistency

For mutations where authorization depends on existing resource fields:

```text
authorize(existing record)
mutate(existing record)
```

must be concurrency-safe.

If the resource changes before commit such that authorization could differ, the operation must conflict/retry/re-authorize rather than silently commit under stale authorization.

---

# 56. Retry semantics

A retryable infrastructure failure must not turn an authorization denial into a retry loop.

Classification:

```text
AUTHORIZATION_DENIED
    → semantic terminal refusal
    → not retryable
```

unless an explicit higher-level semantic construct says otherwise.

Retries caused by concurrency must re-evaluate authorization when resource/policy inputs may have changed.

---

# 57. Cached authorization

Do not cache authorization results beyond the semantic validity of their dependencies.

If policy depends on:

```text
principal
resource
policy graph
```

a cache must invalidate when any relevant semantic input changes.

Prefer correctness over authorization caching in 0.15.

---

# 58. Live-query authorization invalidation

If live-query authorization depends on record fields or policy-bearing graph state, the live engine must recognize relevant changes.

The dependency model must be sufficient to trigger:

```text
re-evaluation
reset
removal
closure
```

as needed.

No indefinitely stale authorization.

---

# 59. Subscription authorization

Long-lived subscriptions must define whether authorization is:

```text
checked at subscribe only
```

or:

```text
continuously valid
```

Preferred:

```text
authorization must remain valid for continued observation
```

Re-evaluate when relevant semantic dependencies change.

At minimum, reconnect/resume must reauthorize.

---

# 60. Server APIs

Audit every public `AxiomServer` operation.

Create an explicit table in implementation/docs:

```text
API
semantic operation
credential accepted?
effective principal
authorization policy
resource
mutation/read
```

No public semantic operation may remain in an ambiguous state.

---

# 61. Credential arguments

Any public API that accepts a credential must actually use it.

0.14 F4 demonstrated why this is a release-blocking invariant.

Required automated audit/tests:

```text
credential accepted but ignored = 0
```

Likewise, APIs that intentionally do not require credentials should not accept meaningless credential parameters.

---

# 62. Direct engine APIs

If lower-level engine APIs are public/exported, define their trust boundary.

Either:

```text
engine API performs authorization
```

or:

```text
engine API is explicitly trusted/internal and cannot be used as
a public semantic bypass
```

Do not have an authorized server wrapper sitting above an exported unrestricted semantic mutation primitive unless the contract explicitly marks it as trusted infrastructure.

---

# 63. NativeOperation

Authorization must not be bypassable through `NativeOperation`.

If NativeOperation remains supported, its security boundary must be explicit.

Preferred rule:

```text
NativeOperation executes only after the containing authorized semantic
operation has been permitted.
```

Do not allow NativeOperation to perform arbitrary authorization decisions inaccessible to analysis.

Target remains:

```text
NativeOperation → zero
```

where semantic primitives exist.

---

# 64. Provider adapters

Provider adapters may receive effective principal metadata for infrastructure purposes, but must not become the authoritative authorization language.

No application should require:

```text
if (principal.role === ...)
```

inside a provider adapter to be secure.

---

# 65. Transport

HTTP/WebSocket/other transports resolve credentials but do not define application authorization.

Required:

```text
same semantic API through different transport
    →
same authorization result
```

Transport-specific authentication may establish principal identity.

Authorization remains Axiom semantic execution.

---

# 66. Error transport

Authorization refusal must survive transport faithfully.

Example:

```text
AUTHORIZATION_DENIED
```

must not become:

```text
500 Internal Server Error
native exception
generic provider failure
```

Transport may map it to protocol-specific status, but semantic diagnostic identity must remain inspectable.

---

# 67. Auditability

Authorization-sensitive operations should provide inspectable execution evidence sufficient for debugging.

At minimum, durable mutation history should allow an operator/AgentAPI to establish:

```text
which principal caused the operation
what semantic operation occurred
whether it succeeded or was denied where denial is durably relevant
```

Do not require persisting every denied read attempt as semantic state.

Operational audit logging may remain infrastructure-level.

---

# 68. Secrets

Principal credentials and secret claims must never appear in:

```text
Server IR
semanticFingerprint
workflow history
AgentAPI public output
conformance snapshots
diagnostic messages
```

Canonical non-secret identity evidence is allowed.

---

# 69. Serialization

All new authorization semantic vocabulary must round-trip through Server IR.

Required:

```text
compile
serialize
deserialize
execute
```

with no change in authorization meaning.

No functions, closures, regex objects with runtime-specific semantics, Dates, or host-language objects.

---

# 70. Server IR v9

Because 0.15 introduces or formalizes authorization-bearing semantic vocabulary, increment Server IR:

```text
axiom.server.v9
```

Freeze v1–v8.

No back-editing prior IR contracts.

If implementation proves no new graph vocabulary is necessary, a v9 bump may still be justified if executable policy semantics exposed in IR change materially.

Default expectation remains v9.

---

# 71. Conformance v9

Create:

```text
axiom.conformance.v9
```

It must include authorization fixtures and preserve all previous applicable fixtures.

Minimum categories:

```text
allow
deny
anonymous
owner
cross-principal
role/claim condition
resource-owner condition
tenant isolation
query filtering
action invocation
workflow continuation
workflow cancellation
workflow inspection
live-query resume
mixed-build policy change
```

---

# 72. Independent authorization oracle

Where practical, external tests should compute expected authorization decisions independently from the runtime.

Especially for:

```text
row filtering
tenant isolation
owner access
policy expressions
```

Do not validate the runtime only against itself.

---

# 73. Required conformance scenarios

At minimum include:

### A. Action allow/deny

```text
P1 allowed
P2 denied
```

Same result:

```text
direct
workflow
retry/failover
```

### B. Resource owner

```text
resource.ownerId == PRINCIPAL.id
```

### C. Tenant isolation

```text
resource.tenantId == PRINCIPAL.tenantId
```

### D. Query

Unauthorized rows absent before limit/sort semantics.

### E. Workflow cancellation

Owner succeeds.

Cross-principal fails.

### F. Workflow inspection

Unauthorized caller cannot inspect.

### G. Live-query resume

Cursor cannot transfer authorization between principals.

### H. Mixed build

Policy semantic change causes incompatibility.

---

# 74. Adversarial API matrix

Build a matrix over public APIs using at least:

```text
owner principal
different principal
anonymous
same role but different identity
admin-like role
malformed credential
```

Verify no accidental role/identity confusion.

The pt6 observation must remain true:

```text
role = admin
```

does not bypass owner-only semantics unless a policy explicitly says so.

---

# 75. Cross-authority matrix

Run authorization tests with:

```text
1 authority
2 authorities
8 authorities
```

for representative durable/read operations.

Required:

```text
same principal + same semantic state
    →
same authorization result
```

No topology-dependent authorization.

---

# 76. Failover

Representative flow:

```text
P starts workflow on A
A dies
B resumes
B reaches authorized/denied operation
```

Result must match one-authority execution.

Principal identity must survive.

---

# 77. Mixed principal races

Test concurrent operations from differently authorized principals.

Example:

```text
P1 authorized mutation
P2 unauthorized mutation
```

Required:

```text
P2 never wins because of race timing
```

Authorization must be checked for each logical operation.

---

# 78. Revocation during workflow

Required test:

```text
workflow starts while P authorized
policy/resource changes
later action no longer authorized
```

Expected:

```text
later action denied
```

with deterministic workflow failure/onError semantics.

No privilege retention from workflow start.

---

# 79. Revocation during live query

Required test:

```text
P opens live query
P initially authorized
authorization-relevant resource/policy changes
P no longer authorized
```

Required:

```text
unauthorized data ceases to be observable
```

within the normal live-query revision propagation contract.

---

# 80. Authorization gain

Also test the reverse:

```text
P initially cannot observe row
resource/policy changes
P becomes authorized
```

Live query may then include it according to canonical query semantics.

This proves authorization participates in live result meaning.

---

# 81. Pagination / limit leak

Required adversarial fixture:

```text
dataset contains authorized + unauthorized records
sort + limit present
```

Verify observable result equals:

```text
query(queryable authorized dataset)
```

and does not leak unauthorized ordering/count via incorrect execution order.

---

# 82. Count / aggregation

If aggregation over provider-backed queries is currently supported, define whether unauthorized rows contribute.

Required rule:

```text
they do not
```

unless explicitly defined otherwise.

If aggregation is not part of current QueryDef semantics, keep it out of scope.

---

# 83. Policy introspection leakage

AgentAPI analysis must distinguish:

```text
policy structure
```

from:

```text
secret runtime data used during authentication
```

It may explain:

```text
requires resource.ownerId == principal.id
```

but must not expose private credential material.

---

# 84. Authorization policy authoring

0.15 does not need the full AI authoring experience planned for 0.16.

However, the authorization model must be sufficiently structured that 0.16 can:

```text
generate
inspect
explain
modify
validate
```

authorization rules without parsing opaque source code.

Avoid choices that would force 0.16 to reverse-engineer policy behavior.

---

# 85. Discoverability

A developer or agent using shipped packages/docs/AgentAPI must be able to discover:

```text
which operations require authorization
how principal identity is represented
what policy protects a resource
how denials surface
how workflow principal propagation works
how live queries reauthorize
```

No critical security rule may exist only in implementation internals.

Target:

```text
D1
```

---

# 86. Semantic escape

No portable authorization-critical application logic should require raw JS or runtime-specific hooks when expressible using Axiom policy semantics.

Target:

```text
E1
```

Any unavoidable escape must be explicitly identified and justified.

---

# 87. Safety target

Release target:

```text
S1
```

Release blockers include any path allowing an unauthorized principal to:

```text
read protected semantic data
mutate protected state
invoke protected actions
cancel/alter another principal's workflow
resume another principal's privileged live query
bypass policy through alternate API/runtime path
retain revoked privileges through async continuation
exploit mixed-build policy mismatch
```

---

# 88. Release blockers

The following are release-blocking:

```text
authorization accepted on one equivalent path and denied on another

credential argument ignored

cross-principal mutation without explicit policy

cross-principal workflow inspection without explicit policy

live-query cursor transfers privilege

unauthorized rows affect observable query result

revoked permission continues indefinitely in live query

workflow continuation executes under wrong principal

action authorization not re-evaluated at step execution

mixed-build policy change considered compatible

authorization policy omitted from semanticFingerprint

native exception from malformed policy

policy evaluation fail-open

provider/transport bypass of canonical authorization

topology-dependent authorization

stale-resource authorization leading to unauthorized mutation
```

---

# 89. Non-goals

Do not expand 0.15 into a full IAM platform.

Out of scope unless already required:

```text
OAuth/OIDC implementation
user management
password storage
MFA
RBAC administration UI
policy editor UI
organization hierarchy
delegation/impersonation
ABAC policy language with arbitrary functions
external policy engines such as OPA
cryptographic capability tokens
row-encryption
audit-log product
```

Axiom consumes canonical principals supplied by authentication infrastructure.

0.15 defines application authorization semantics.

---

# 90. Relationship to authentication

Authentication answers:

```text
Who is this?
```

Authorization answers:

```text
May this principal perform this semantic operation?
```

0.15 is primarily about the second question.

Credential adapters may authenticate users, but authentication protocol behavior is not part of portable application semantics.

---

# 91. Relationship to 0.14

Do not reopen validated workflow durability semantics.

Preserve:

```text
exactly-once logical workflow transitions
stable action invocation identity
durable event replay
timer semantics
fencing
mixed-build workflow compatibility
principal preservation
terminal immutability
```

0.15 overlays complete authorization semantics on those validated mechanisms.

---

# 92. Relationship to 0.16

0.16 will build stronger:

```text
explainability
AI authoring
tooling
analysis
```

on top of the 0.15 authorization model.

Therefore 0.15 must expose clean structured semantics and AgentAPI metadata.

Do not defer fundamental policy structure to 0.16.

---

# 93. Relationship to 0.17

Authorization semantics must be implementable independently.

The future independent runtime must be able to determine the same authorization result from:

```text
Server IR
principal
resource/context
```

without access to hidden TypeScript implementation behavior.

This is a key design test.

---

# 94. Implementation strategy

Recommended staged implementation:

```text
Phase A
  authorization semantic inventory
  public API audit
  principal/access model freeze

Phase B
  canonical policy representation
  validation
  semantic projection / IR v9

Phase C
  ActionDef + mutation authorization unification

Phase D
  QueryDef / row authorization

Phase E
  workflow instance access + cancellation + inspection

Phase F
  live-query auth / reconnect / revocation

Phase G
  AgentAPI authorization analysis

Phase H
  conformance v9

Phase I
  real-process / mixed-build / adversarial validation
```

Do not implement all surfaces independently and attempt to reconcile them afterward.

---

# 95. Authorization inventory gate

Before adding vocabulary, enumerate every existing public semantic API and classify it.

Required table:

```text
operation
read/mutate/execute
resource
effective principal
existing authorization behavior
desired 0.15 behavior
```

This is a design gate.

No public semantic operation should remain unclassified.

---

# 96. Single authorization evaluator

Prefer one canonical authorization evaluator used across runtime surfaces.

Conceptually:

```text
authorize({
  principal,
  operation,
  resource,
  policy,
  context
})
```

The exact API may differ.

Avoid duplicated policy evaluators in:

```text
actions
queries
workflows
live queries
```

One semantic evaluator reduces drift.

---

# 97. Single semantic projection

Maintain the architecture established by 0.14 fixes.

Authorization vocabulary must enter semantic identity through the canonical semantic projection.

Do not introduce a separate hand-written authority-compatibility projection for authorization.

Required invariant:

```text
semanticFingerprint
authority compatibility
```

derive from the same authorization-bearing semantic projection.

---

# 98. Authorization operation identity

Define canonical operation kinds, e.g.:

```text
action.invoke
query.read
record.read
record.mutate
workflow.start
workflow.inspect
workflow.cancel
live.open
live.resume
```

Names are illustrative.

Policies should not depend on transport method names such as:

```text
POST /api/workflow/cancel
```

Authorization operates on semantic operations.

---

# 99. Resource identity

Define the semantic resource against which policies execute.

Examples:

```text
ActionDef
QueryDef
provider record
workflow definition
workflow instance
```

Avoid ambiguous policy context.

If there is no resource object, policy must still have a stable operation target.

---

# 100. StartWorkflow authorization

Workflow start requires explicit semantics.

Possibilities:

```text
WorkflowDef has start policy
```

or:

```text
workflow start is authorized through referenced semantic policy
```

Do not assume that ability to discover a WorkflowDef means ability to start it.

Start authorization is separate from later ActionDef authorization.

---

# 101. Workflow privilege amplification

Required adversarial test:

```text
P may start workflow W
P may NOT invoke action A directly
W contains action A
```

Expected:

```text
W must not let P invoke A
```

unless an explicit delegation semantic exists.

This is a critical release blocker.

---

# 102. Confused deputy

Test that workflows, schedulers, and providers do not act as confused deputies.

Example:

```text
P cannot mutate resource R
P can trigger workflow/event that eventually mutates R
```

If the mutation occurs under P's principal:

```text
must be denied
```

No implicit privilege from execution infrastructure.

---

# 103. Resource-derived authorization

Representative policies should include:

```text
owner
tenant
visibility/public
```

This ensures the model is more complete than simple role checks.

---

# 104. Policy update behavior

A graph deployment changing policy is a semantic deployment.

Runtime should not mutate policy independently from graph compatibility in 0.15 unless there is already a first-class durable configuration model.

Do not introduce external mutable policy stores as portable semantics in this milestone.

---

# 105. Provider mutation and authorization transactionality

For policies depending on the record being mutated:

```text
read authoritative record
authorize
apply mutation
commit
```

must occur under the provider's concurrency guarantees.

If optimistic conflict occurs:

```text
reload
reauthorize
retry according to action semantics
```

Never blindly replay prior authorization.

---

# 106. Cross-process principal equivalence

Test canonical principal resolution across independent OS processes.

Semantically equal credentials/principal representations must produce equal fingerprints.

Different principals must not collide.

No process-local identity state.

---

# 107. Malformed credentials

Malformed credentials must fail authentication/principal resolution safely.

They must not resolve to:

```text
anonymous
```

unless the credential was genuinely absent and anonymous semantics apply.

Malformed authenticated input must not degrade into broader anonymous privileges accidentally.

---

# 108. Unknown principal

If principal resolution fails because an identity cannot be established:

```text
fail closed
```

for protected operations.

No fallback-to-system.

---

# 109. Authorization denial and workflows

When a workflow ActionDef invocation is denied, workflow semantics must treat it as a structured semantic failure.

It must integrate with existing:

```text
onError
complete/fail
retry classification
```

Authorization denial is not a retryable infrastructure failure.

Required:

```text
attempt count does not grow indefinitely
```

---

# 110. Cancellation and terminal workflows

Preserve 0.14 behavior:

```text
cancel terminal instance
```

is idempotent and does not mutate.

0.15 authorization must explicitly decide whether terminal no-op requires owner authorization.

Compatibility preference:

```text
preserve alpha.5 behavior unless security model requires otherwise
```

If changed, document and test it as a semantic change.

---

# 111. Read-only no-op authorization

Do not use “operation would have no effect” as a generic reason to bypass authorization.

The terminal cancellation behavior is a compatibility-specific contract, not a general security principle.

---

# 112. Inspection diagnostics

`inspectWorkflow()` and similar detailed inspection APIs may expose more than ordinary application reads.

If these are intended as operator-only infrastructure APIs, mark that trust boundary explicitly.

If exposed to application principals, authorize them semantically.

Do not mix the two roles ambiguously.

---

# 113. Administrative APIs

Separate:

```text
application-semantic API
```

from:

```text
trusted operational/admin API
```

where needed.

Trusted operator APIs may live outside portable application semantics, but they must be clearly named/documented and must not be callable accidentally through ordinary principal-facing interfaces.

---

# 114. Authorization conformance runtime

The memory reference runtime must implement v9.

At least one durable/reference-backed execution path must also run the authorization fixtures.

Prefer:

```text
memory
SQLite
```

for authoritative comparison.

---

# 115. Byte-identical logical history

For equivalent authorized workflows, memory and SQLite stores should produce equivalent logical history.

For denied operations, no unauthorized mutation history should appear.

Operational denial logs may differ and are not semantic history.

---

# 116. SQLite contention

Run authorization-sensitive mutation under real contention.

Example:

```text
authorized owner operation
unauthorized cross-principal competing operation
```

with multiple authorities.

Required:

```text
authorized result correct
unauthorized mutation count 0
raw SQLite errors 0
```

---

# 117. Real-process kill tests

Representative authorization correctness must survive:

```text
SIGKILL after principal resolution
SIGKILL after authorization before attempted commit
authority failover
```

No durable mutation may appear unless the semantic operation was authorized and committed.

Do not require a massive crash matrix for every policy rule; choose high-value boundaries.

---

# 118. Authorization and idempotency

Idempotency keys must not cross authorization identities incorrectly.

Example:

```text
P1 invokes operation with idempotency key K
P2 invokes same operation with K
```

P2 must not receive/reuse P1's successful semantic result if that would bypass authorization.

Idempotency identity must include sufficient principal/security context.

Audit existing action/workflow start idempotency.

---

# 119. Workflow start idempotency

0.14 already includes principal fingerprint in WorkflowStartIdentity.

Preserve and test it.

Same textual key:

```text
P1 + K
P2 + K
```

must remain separate identities.

---

# 120. Action idempotency

Audit whether ActionDef durable idempotency keys are scoped by authorization identity.

If user-controlled keys can cause cross-principal result reuse, fix it.

This is release-blocking if it can disclose or perform unauthorized semantics.

---

# 121. Effect idempotency

Physical effect idempotency remains based on logical effect identity, not current caller credentials.

Authorization was established when the logical effect was created.

Do not accidentally scope retry identity differently and duplicate effects.

---

# 122. Event deduplication

Event deduplication and authorization are separate.

A denied event must not poison dedup state in a way that prevents a later legitimate authorized event unless the event source identity contract explicitly defines this.

Audit ordering:

```text
authenticate/authorize
dedup/accept
route
```

and define canonical semantics.

---

# 123. Authorization evaluation errors

Differentiate:

```text
DENY
```

from:

```text
policy evaluation invalid/internal failure
```

but both must fail closed.

Diagnostics may distinguish them for operators.

No evaluation exception may result in allow.

---

# 124. Performance

Authorization completeness may add cost, particularly to row-level queries/live queries.

Correctness is the priority for 0.15.

Optimization is acceptable only when it preserves exact semantic results.

Do not weaken policy semantics to make provider pushdown easier.

---

# 125. Query policy pushdown

Provider pushdown of authorization predicates is allowed as optimization only if equivalent to canonical policy evaluation.

If provider cannot faithfully execute policy:

```text
evaluate canonically in Axiom
```

or:

```text
reject unsupported execution
```

Never approximate authorization.

---

# 126. Large datasets

If canonical post-fetch authorization would require unsafe/unbounded materialization, the runtime must report execution capability limitations rather than silently returning semantically wrong results.

This may require capability analysis.

AgentAPI should make such limitations discoverable.

---

# 127. Authorization capability analysis

Extend capability analysis where useful:

```text
provider can push authorization predicate: yes/no
live authorization invalidation supported: yes/no
resource-field policy supported: yes/no
```

A valid graph must not silently run with incomplete authorization semantics.

---

# 128. Unsupported authorization

If a provider/runtime cannot enforce required semantics:

```text
fail closed at validation/admission/execution capability boundary
```

with a structured diagnostic.

Never degrade to “public”.

---

# 129. Documentation

Update at minimum:

```text
README / overview
security / authorization guide
WORKFLOWS.md
query/live-query docs
AgentAPI reference
Server IR docs
conformance docs
llms / agent-facing documentation
```

The docs must explain the semantic model, not merely list API methods.

---

# 130. Security examples

Ship examples covering:

```text
owner-only resource
tenant-isolated query
role/claim gate
workflow start + later action reauthorization
workflow cancellation
live-query revocation
```

Examples must use semantic authorization primitives, not raw JavaScript guards.

---

# 131. Migration compatibility

Existing 0.14 graphs need defined behavior.

Do not silently make all existing applications inaccessible.

Provide deterministic upgrade semantics.

If existing authorization constructs can be canonically projected into 0.15 policies, compiler upgrade should do so.

If an old graph relied on an unsafe ambiguous public surface, require explicit migration or emit a hard diagnostic.

Security ambiguity should not be silently grandfathered.

---

# 132. No-workflow compatibility

Graphs not using workflows must retain stable unrelated semantics.

Authorization changes may legitimately change Server IR/fingerprint where executable auth semantics change, but unrelated graph ordering/presentation must remain stable.

---

# 133. Existing conformance preservation

Run prior suites:

```text
v1 base
v4 query
v5 migrations
v6 distributed authority
v7 live queries
v8 workflows
v9 authorization
```

No regressions.

---

# 134. Phase structure

Recommended release path:

```text
0.15.0-alpha.1
    ↓
internal gates
    ↓
blind external authorization regression
    ↓
corrective alpha(s) if needed
    ↓
D1 / E1 / S1
    ↓
0.15 semantic freeze
```

As with 0.12–0.14, external validation is part of the milestone.

Do not freeze from internal tests alone.

---

# 135. External validation requirements

Blind tester should use:

```text
published npm packages
public docs
.d.ts
AgentAPI
conformance
fresh consumer
real OS processes
SQLite
```

No repository source or internal test knowledge.

The tester should derive security expectations from the shipped semantic contract.

---

# 136. External adversarial focus

The blind suite should specifically search for bypasses through alternate paths.

Examples:

```text
server API vs lower-level API
one-shot query vs live query
direct action vs workflow action
open live query vs resume cursor
same authority vs failover
owner vs other principal
role-equivalent different principal
malformed credential
mixed build
idempotency reuse
```

Authorization bugs frequently live in asymmetry.

---

# 137. Required blind invariants

At minimum measure forbidden counters:

```text
unauthorized_action_execution
unauthorized_state_mutation
unauthorized_provider_mutation
unauthorized_record_observation
unauthorized_workflow_start
unauthorized_workflow_inspection
unauthorized_workflow_cancellation
cross_principal_cursor_resume
cross_principal_idempotency_reuse
revoked_live_data_continues
revoked_workflow_privilege_continues
mixed_build_authorization_silent_continuation
policy_fail_open
native_authorization_exception
```

All release-blocking counters must be zero.

---

# 138. Discoverability verdict

`D1` requires a blind consumer to determine from shipped artifacts:

```text
what is protected
how to express policy
which principal executes async work
what denial looks like
what live-query authorization means
```

without reading source.

---

# 139. Semantic Escape verdict

`E1` requires ordinary authorization use cases to be expressible without raw host-language escape.

At least:

```text
identity
role/claim
owner
tenant
public/private
```

must be portable.

---

# 140. Safety verdict

`S1` requires no known authorization bypass in the covered canonical semantic surfaces.

Any cross-principal unauthorized read/mutation/execution is at least release-blocking until explicitly shown to be an intended public contract.

---

# 141. Freeze criteria

0.15 may freeze only when:

```text
authorization inventory complete

all public semantic operations classified

canonical authorization evaluator established

policy semantics serializable and fingerprinted

ActionDef paths consistent

QueryDef authorization complete

workflow access complete

live-query authorization complete

async principal preservation validated

mixed-build authorization fail-closed

AgentAPI authorization analysis available

conformance v9 green

prior conformance green

blind external regression D1 / E1 / S1

all release-blocking findings closed
```

---

# 142. Final milestone invariant

After 0.15, it should be possible to make this statement without qualification:

```text
Given an Axiom graph, a canonical principal, and a semantic operation,
the graph defines whether that operation is authorized.

That decision does not depend on transport, provider implementation,
process identity, authority topology, retry path, workflow continuation,
or UI behavior.

A compatible independent runtime can derive and enforce the same decision.
```

That is the completion criterion for:

```text
Axiom 0.15 — Authorization Completeness
```

Once externally validated and frozen, proceed to:

```text
Axiom 0.16 — Tooling / Explainability / AI Authoring
```