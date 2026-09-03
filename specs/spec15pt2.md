# Axiom 0.15pt2 Specification
## Authorization Absent-Value Safety + Validation / Authentication Hardening

**Target:** `0.15.0-alpha.2`  
**Baseline:** `0.15.0-alpha.1`  
**Milestone:** Axiom 0.15 — Authorization Completeness  
**Corrective release:** `spec15pt2`  
**Server IR:** `axiom.server.v9` — unchanged  
**Conformance:** `axiom.conformance.v9` — extended, contract id unchanged  
**External validation:** full 0.15 blind campaign rerun required  
**Target verdict:** `D1 / E1 / S1`

---

# 1. Status of 0.15.0-alpha.1

The blind external validation campaign for `0.15.0-alpha.1` completed with:

```text
D1 / E1 / S3

NOT EXTERNALLY VALIDATED
SEMANTIC MODEL NOT FROZEN
```

One release-blocking authorization defect was found:

```text
F1 — anonymous / absent-principal authorization fail-open
HIGH
RELEASE BLOCKING
```

Two additional non-blocking hardening defects were found:

```text
F2 — validateGraph admits malformed AuthorizationPolicyDef.allow objects
LOW

F3 — a throwing ServerHost.authenticate() may escape as a native exception
LOW
```

`spec15pt2` closes F1 and SHOULD close F2/F3 in the same corrective alpha.

No unrelated 0.15 vocabulary or feature expansion is permitted.

---

# 2. Purpose

The purpose of 0.15pt2 is to establish this authorization invariant:

```text
Missing security-scope data can never create authority.
```

More formally:

For an `AuthorizationPolicyDef.allow` expression `E`, evaluation under authorization scope
must distinguish between:

```text
a concrete value,
an absent PRINCIPAL / RESOURCE field value,
and an evaluation error.
```

An authorization decision MUST NOT become ALLOW when its truth depends on an absent
security-scope field.

Examples that MUST deny:

```text
PRINCIPAL.role != "banned"
```

when `PRINCIPAL.role` is absent.

```text
NOT(PRINCIPAL.role == "banned")
```

when `PRINCIPAL.role` is absent.

```text
RESOURCE.ownerId == PRINCIPAL.id
```

when both fields are absent.

```text
RESOURCE.tenantId == PRINCIPAL.tenantId
```

when both fields are absent.

The safe semantic direction is always:

```text
absent security input
    ↓
predicate involving that input is not satisfied
    ↓
DENY
```

---

# 3. Primary corrective invariant

For graph `G`, principal `P`, resource `R`, operation `O`, and policy `A`:

```text
authorizationDecision(G, A, P, R, O) == ALLOW
```

only if:

```text
A.allow evaluates to exactly true
AND
the truth of A.allow does not depend on an absent PRINCIPAL or RESOURCE field read
AND
no authorization evaluation error occurred.
```

Equivalent formulation:

```text
true + complete required security inputs  => ALLOW

false                                     => DENY
absent-dependent true                     => DENY
evaluation error                          => DENY
```

---

# 4. Critical non-goal: do not redefine global Expression semantics

0.15pt2 MUST NOT change ordinary Axiom `Expression` semantics globally merely to fix authorization.

Existing expression semantics such as:

```text
eq(undefined, undefined) == true
```

may remain unchanged outside authorization.

This corrective release concerns the interpretation of expressions when used as:

```text
AuthorizationPolicyDef.allow
```

The fix MUST therefore live in the authorization-evaluation semantics or in an equivalent
authorization-specific evaluation mode.

Changing global `Expression` equality / nullish semantics is out of scope unless it is
proven impossible to implement authorization safely otherwise.

Such a global change would require a substantially broader semantic review and is not the
preferred corrective path.

---

# 5. Security-scope absence

The authorization evaluator MUST recognize absence originating from:

```text
field(ref(PRINCIPAL), fieldId)
field(ref(RESOURCE), fieldId)
```

when the referenced field is not present.

The important property is provenance.

The evaluator must distinguish:

```text
literal(undefined)
```

from:

```text
field(ref(PRINCIPAL), ROLE)
```

where the role field is absent.

Similarly:

```text
field(ref(RESOURCE), OWNER_ID)
```

whose resource lacks that field is security-scope absence.

The authorization semantics must not infer authority from such absence.

---

# 6. Required semantic value model

Implementation details are not prescribed, but the effective authorization evaluator MUST
be able to represent at least:

```text
Concrete(value)
AbsentSecurityValue(scope, field)
EvaluationError(error)
```

or an observationally equivalent model.

Examples:

```text
PRINCIPAL.id exists
    => Concrete("user-1")

PRINCIPAL.role missing
    => AbsentSecurityValue(PRINCIPAL, ROLE)

RESOURCE.ownerId missing
    => AbsentSecurityValue(RESOURCE, OWNER_ID)

malformed/evaluation failure
    => EvaluationError(...)
```

This does NOT require exposing these internal values through public API.

---

# 7. Absent values are not ordinary undefined for authorization

Within authorization-policy evaluation, an absent security field MUST NOT silently collapse
into an ordinary host-language:

```text
undefined
```

whose ordinary expression behavior can subsequently become truthy through:

```text
eq
neq
not
or
```

The evaluator MUST preserve sufficient information to know that the value originated from a
missing authorization-scope field.

---

# 8. Comparison semantics

When either operand of a comparison depends on `AbsentSecurityValue`, the comparison MUST
not produce a satisfied authorization predicate.

For authorization evaluation:

```text
eq(absent, absent)      => non-satisfied
eq(absent, concrete)    => non-satisfied
eq(concrete, absent)    => non-satisfied

neq(absent, absent)     => non-satisfied
neq(absent, concrete)   => non-satisfied
neq(concrete, absent)   => non-satisfied
```

Likewise for any supported ordering / relational comparison:

```text
lt
lte
gt
gte
```

if present in the Expression vocabulary.

The implementation MAY represent "non-satisfied" as an authorization bottom/unknown value
rather than boolean `false`, provided the final authorization semantics below are preserved.

---

# 9. Boolean negation must not turn absence into authority

This case is explicitly release-blocking:

```text
NOT(PRINCIPAL.role == "banned")
```

with no role.

It MUST produce:

```text
DENY
```

not:

```text
ALLOW
```

Therefore:

```text
not(AbsentDependentPredicate)
```

must remain non-satisfied for authorization.

Absence cannot be converted into authority by boolean inversion.

---

# 10. `neq` must not turn absence into authority

This case is explicitly release-blocking:

```text
PRINCIPAL.role != "banned"
```

with no role.

It MUST produce:

```text
DENY
```

even though ordinary expression evaluation might consider:

```text
undefined != "banned"
```

true.

Authorization semantics override that implication.

---

# 11. Boolean composition

Authorization absence semantics MUST compose transitively through boolean expressions.

For example:

```text
A = RESOURCE.ownerId == PRINCIPAL.id
B = RESOURCE.tenantId == PRINCIPAL.tenantId
allow = A OR B
```

If both `A` and `B` depend on absent fields:

```text
DENY
```

If:

```text
A = absent-dependent
B = true from complete concrete security inputs
```

then:

```text
ALLOW
```

is acceptable because the final truth does not depend on the absent branch.

For:

```text
A AND B
```

normal conservative semantics apply:

```text
true AND absent-dependent   => DENY
false AND absent-dependent  => DENY
```

The final result is not ALLOW.

---

# 12. Recommended three-valued authorization semantics

A recommended conceptual model is:

```text
TRUE
FALSE
UNKNOWN_SECURITY
ERROR
```

with:

```text
ALLOW only when final result == TRUE
```

and propagation such that an absent branch can be ignored only when another branch
independently and conclusively determines a safe boolean result.

Illustrative OR:

```text
TRUE  OR UNKNOWN_SECURITY => TRUE
FALSE OR UNKNOWN_SECURITY => UNKNOWN_SECURITY
UNKNOWN_SECURITY OR UNKNOWN_SECURITY => UNKNOWN_SECURITY
```

Illustrative AND:

```text
FALSE AND UNKNOWN_SECURITY => FALSE
TRUE  AND UNKNOWN_SECURITY => UNKNOWN_SECURITY
UNKNOWN_SECURITY AND UNKNOWN_SECURITY => UNKNOWN_SECURITY
```

Illustrative NOT:

```text
NOT TRUE             => FALSE
NOT FALSE            => TRUE
NOT UNKNOWN_SECURITY => UNKNOWN_SECURITY
```

Final authorization mapping:

```text
TRUE             => ALLOW
FALSE            => DENY
UNKNOWN_SECURITY => DENY
ERROR            => DENY
```

This is guidance, not a mandated implementation representation.

---

# 13. Constant policies remain valid

These policies MUST retain their existing meaning:

```text
allow: literal(true)
    => ALLOW

allow: literal(false)
    => DENY
```

No principal or resource is required for a genuinely constant public policy.

This corrective release MUST NOT accidentally make anonymous access impossible for an
explicitly public policy.

---

# 14. Operation-only policies remain valid

A policy using only:

```text
OPERATION
```

must not require a principal or resource field unless its own expression references one.

Example:

```text
OPERATION == "workflow.inspect"
```

may evaluate normally.

The mere fact that `PRINCIPAL` is anonymous MUST NOT automatically deny every policy.

The rule is:

```text
referenced absent security data cannot create ALLOW
```

not:

```text
anonymous always denies.
```

---

# 15. Explicit anonymous access remains expressible

If Axiom provides or later provides an explicit semantic representation for anonymous
identity, policies may reason about it deliberately.

0.15pt2 MUST NOT introduce implicit rules such as:

```text
if anonymous => always deny
```

because that would break explicit public authorization semantics.

The corrective invariant concerns missing attributes, not anonymous identity as a blanket
category.

---

# 16. PRINCIPAL field semantics

For:

```text
field(ref(PRINCIPAL), F)
```

the authorization evaluator MUST distinguish:

```text
principal exists and F exists
principal exists and F absent
anonymous principal / no principal
```

For the latter two, the field read is security-absent.

Any rule relying on that field is non-satisfied unless another independent branch
conclusively allows.

This restores the shipped authorization contract:

```text
a rule naming an absent principal attribute does not grant authority.
```

---

# 17. RESOURCE field semantics

For:

```text
field(ref(RESOURCE), F)
```

when the current semantic operation's resource descriptor does not contain `F`, the read is
security-absent.

This MUST NOT become ordinary `undefined`.

Examples include an operation resource shaped only as:

```text
{
  id,
  kind
}
```

while the policy asks for:

```text
RESOURCE.ownerId
RESOURCE.tenantId
```

The rule MUST deny rather than accidentally equating two missing fields.

---

# 18. Canonical documentation owner/tenant policy

The documented policy shape:

```text
RESOURCE.ownerId == PRINCIPAL.id
OR
RESOURCE.tenantId == PRINCIPAL.tenantId
```

MUST satisfy all of:

```text
concrete matching owner       => ALLOW
concrete matching tenant      => ALLOW
concrete non-match            => DENY

anonymous + missing resource fields
                              => DENY

named principal + missing resource fields
                              => DENY

missing principal fields + concrete resource
                              => DENY
```

This policy MUST become an explicit regression fixture.

---

# 19. Deny-list regression

The following family MUST be explicitly tested:

```text
NOT(PRINCIPAL.role == "banned")
```

and:

```text
PRINCIPAL.role != "banned"
```

Expected:

```text
role = "user"      => ALLOW
role = "banned"    => DENY
role absent        => DENY
anonymous          => DENY
malformed credential resolving to no principal
                   => DENY
```

The last three cases are mandatory regression gates for F1.

---

# 20. Same semantics on every protected surface

The absent-value rule MUST be identical across:

```text
ActionDef.authorizationPolicy
QueryDef.authorizationPolicy
WorkflowDef.startPolicy
WorkflowDef.instanceAccessPolicy
live-query authorization
workflow action continuation
```

There must not be a surface-specific patch.

All MUST use the same canonical authorization evaluator.

---

# 21. Action regression

For an action protected by the documented owner/tenant policy and invoked anonymously:

Required:

```text
AUTHORIZATION_DENIED
```

and:

```text
action executions = 0
state mutations = 0
provider mutations = 0
logical effects = 0
```

Run over:

```text
memory
SQLite
```

---

# 22. Query regression

For a query protected by the documented owner/tenant policy and run anonymously:

Required:

```text
AUTHORIZATION_DENIED
rows disclosed = 0
```

No provider/result-cache behavior may return a previously authorized response.

Run over:

```text
memory
SQLite
```

---

# 23. Workflow start regression

For:

```text
WorkflowDef.startPolicy = owner/tenant policy
```

with missing relevant resource/principal fields:

Required:

```text
anonymous start => AUTHORIZATION_DENIED
instance count unchanged
history unchanged
```

---

# 24. Workflow cancellation regression

For:

```text
WorkflowDef.instanceAccessPolicy = owner/tenant policy
```

anonymous or missing-attribute caller:

```text
cancel => denied/not-found-equivalent according to API contract
```

Required:

```text
workflow revision unchanged
status unchanged
history unchanged
```

---

# 25. Workflow inspection regression

With `instanceAccessPolicy` referencing absent security fields:

Anonymous inspection MUST NOT succeed because:

```text
absent == absent
```

Required:

```text
same existence-leak-safe result as other unauthorized callers.
```

---

# 26. Live open regression

For a protected query:

```text
anonymous openLiveQuery
```

must return structured authorization refusal.

Required:

```text
subscription not created
initial rows = 0
```

---

# 27. Live reevaluation semantics

The same absent-value semantics must apply during later live reauthorization.

Scenario:

```text
P1 initially has role=user
live query opens
credential later resolves to principal without role
reevaluation occurs
```

For policy:

```text
PRINCIPAL.role != "banned"
```

Required:

```text
stream stops / AUTHORIZATION_DENIED
```

It MUST NOT continue merely because absent role makes the inequality true under ordinary
expression semantics.

---

# 28. Live resume semantics

Open query under complete authorized principal.

Later resume with credential resolving to a principal missing a required authorization
attribute.

Required:

```text
resume denied
```

even when cursor identity checks independently succeed.

---

# 29. Workflow continuation semantics

Start a workflow under a principal with required claims.

Before a later protected action, arrange—where supported by the existing principal model—
for the effective principal used for authorization to lack the field required by policy.

Required:

```text
protected action denied
```

No privilege continuation through missing attributes.

If workflow semantics intentionally capture immutable principal claims, test the equivalent
case using a protected resource field that becomes absent.

---

# 30. No privilege through malformed credentials

A malformed credential that resolves to:

```text
null
anonymous
principal lacking expected fields
```

MUST NOT gain authority through absent-field comparison behavior.

This closes the F1 malformed-credential privilege path.

---

# 31. Preserve row-level ReadPolicy semantics

`ReadPolicyDef` behavior already passed the blind campaign.

0.15pt2 MUST NOT regress:

```text
row-level tenant isolation
row-level owner isolation
authorization before sort
authorization before limit
authorization before aggregation
```

No change to row-level semantics is required unless the canonical evaluator is reused there.

If implementation changes affect `ReadPolicyDef`, all corresponding conformance/regression
tests MUST be rerun.

---

# 32. Preserve legacy ActionDef.authorization semantics

The legacy:

```text
ActionDef.authorization
```

contract is preserved.

Where legacy authorization and the new policy coexist:

```text
effective authorization = legacy AND AuthorizationPolicyDef
```

0.15pt2 MUST NOT change this conjunction.

If either side denies:

```text
DENY
```

---

# 33. No alternate evaluator

The fix MUST be implemented in the canonical authorization path.

Forbidden architecture:

```text
authorizeActionWithAbsentFix()
authorizeQueryOldWay()
authorizeWorkflowSpecialCase()
```

Required architecture:

```text
one authorization policy evaluator
```

used by every policy-bearing semantic surface.

---

# 34. Semantic identity consequence

F1 changes authorization meaning.

Therefore this corrective alpha MUST be treated as a semantic runtime change.

However, no new graph vocabulary is introduced.

Thus:

```text
Server IR remains axiom.server.v9
Conformance contract remains axiom.conformance.v9
```

provided the serialized contract shape does not change.

---

# 35. Authority compatibility across alpha.1 / alpha.2

This point MUST be addressed explicitly.

`0.15.0-alpha.1` and `0.15.0-alpha.2` evaluate the SAME Server IR authorization policy
differently.

Therefore they MUST NOT silently participate in one authority domain as if semantically
compatible.

A graph-level `semanticFingerprint` alone cannot distinguish these builds because the graph
is identical.

The authority compatibility identity MUST therefore include sufficient runtime semantic
version/capability identity to distinguish:

```text
alpha.1 authorization evaluator semantics
```

from:

```text
alpha.2 authorization evaluator semantics.
```

If existing authority compatibility already includes a runtime/build semantic compatibility
key that changes across this corrective release, prove it.

If it does not, 0.15pt2 MUST add the narrowest required compatibility discriminator.

This is RELEASE BLOCKING.

---

# 36. No silent mixed evaluator cluster

Run:

```text
Authority A = 0.15.0-alpha.1
Authority B = 0.15.0-alpha.2
same graph
same SQLite coordination/persistence
same authorization-bearing IR
```

Required:

```text
incompatible
```

or equivalent fail-closed refusal.

Forbidden:

```text
A allows anonymous via F1
B denies anonymous
both nevertheless considered semantically compatible.
```

This would make authorization topology-dependent.

---

# 37. Server IR version

No new serialized authorization vocabulary is required.

Expected:

```text
axiom.server.v9
```

remains latest.

Do NOT create `axiom.server.v10` solely for an evaluator bug fix.

A new IR contract is required only if serialized semantic vocabulary changes.

---

# 38. Semantic fingerprint

The graph semantic fingerprint behavior from alpha.1 remains:

```text
authorization policy semantic edit => fingerprint changes
presentation-only edit             => fingerprint unchanged
```

No change required.

The alpha.1→alpha.2 evaluator compatibility problem must not be falsely solved by
artificially changing graph fingerprints for identical graphs.

That belongs in runtime/authority compatibility, not graph identity.

---

# 39. F2 — validation totality

`validateGraph` MUST reject malformed `AuthorizationPolicyDef.allow` values before compile.

The following examples MUST produce structured validation diagnostics:

```text
allow: { a: 1 }

allow: { kind: "literal" }
      // missing required literal value if such shape is malformed

allow: { kind: "nonsense" }

allow: object with malformed operator shape

allow: malformed field/ref/call child

allow: malformed nested expression container
```

Use existing authorization validation diagnostic vocabulary where appropriate.

Preferred:

```text
AUTHORIZATION_INVALID_POLICY
```

unless a more precise existing Expression validation code applies canonically.

---

# 40. Validation must be total

Authorization validation MUST be total over arbitrary JavaScript/JSON-compatible input.

For any malformed policy:

```text
validateGraph(...)
authorizationPolicyProblems(...)
AgentAPI.analyzeAuthorization(...)
compile/admission where reachable
```

must not produce a native TypeError due to shape assumptions.

Required:

```text
structured diagnostic or safe analysis result
```

---

# 41. Expression structural validation reuse

Do not create a second partial Expression validator inside authorization if a canonical
Expression structural validator already exists.

Preferred architecture:

```text
AuthorizationPolicyDef validation
    ↓
canonical Expression structural validation
    ↓
authorization-specific scope/nondeterminism checks
```

This prevents drift between ordinary Expression validity and authorization policy validity.

---

# 42. F3 — authenticate() exception boundary

A throwing:

```text
ServerHost.authenticate()
```

must not escape a principal-facing semantic API as an unhandled native exception.

Authentication is an ingress trust boundary.

Required behavior:

```text
authenticate throws
    ↓
request fails closed
    ↓
structured semantic/server refusal
    ↓
zero semantic mutation
```

---

# 43. Authentication failure code

Use an existing canonical authentication/authorization error if one already exists.

If no authentication-specific structured code exists, the implementation MAY map the
failure to:

```text
AUTHORIZATION_DENIED
```

provided the public contract clearly defines the behavior.

Do NOT expose raw authentication exception details to the caller.

---

# 44. Authentication exception secrecy

Given:

```text
throw new Error("secret-token=XYZ")
```

from `host.authenticate()`:

The external response MUST NOT disclose:

```text
XYZ
raw stack
credential content
host internal details
```

Operational logging may retain safe diagnostics according to existing trusted-host rules.

---

# 45. Authentication exception mutation guarantee

For every principal-facing mutating operation:

```text
action invoke
workflow start
workflow cancel
```

when `authenticate()` throws:

Required:

```text
semantic mutations = 0
provider mutations = 0
workflow revisions = 0
logical effects = 0
```

---

# 46. Authentication exception read guarantee

For:

```text
query
live open
live resume
workflow inspect/history
```

when `authenticate()` throws:

Required:

```text
protected data disclosed = 0
```

and no native exception escapes the public semantic boundary.

---

# 47. Authentication boundary consistency

The same authenticate-throw handling MUST apply consistently across all server surfaces that
resolve credentials.

Forbidden:

```text
handle() catches
startWorkflow() throws natively

or

query catches
live resume throws natively
```

Credential resolution must have one coherent safe boundary.

---

# 48. Public contract update

Documentation MUST explicitly state the authorization absence rule.

At minimum document:

```text
A missing PRINCIPAL or RESOURCE field never satisfies an authorization rule.

Comparisons or boolean expressions whose truth would depend on such a missing field do not
grant authority.

For example, `PRINCIPAL.role != "banned"` denies when role is absent.
```

This must be stated in authorization documentation, not inferred only from implementation.

---

# 49. EXPRESSIONS.md clarification

Because ordinary Expression semantics may still define:

```text
null / undefined equality
```

the docs MUST distinguish:

```text
general Expression evaluation
```

from:

```text
AuthorizationPolicyDef evaluation
```

Example wording:

```text
Authorization policies apply additional fail-closed semantics to absent PRINCIPAL and
RESOURCE fields. General Expression equality semantics do not imply authorization when a
security-scope field is missing.
```

---

# 50. AGENT_REFERENCE consistency

The shipped statement equivalent to:

```text
an anonymous caller has no principal attributes;
a rule requiring one does not grant authority
```

must become exactly true in runtime semantics.

Docs and runtime must no longer disagree.

---

# 51. AgentAPI analysis

`AgentAPI.analyzeAuthorization()` must remain total.

If useful and consistent with existing design, AgentAPI MAY flag policies that structurally
use negative tests over principal/resource fields, e.g.:

```text
role != banned
NOT(role == banned)
```

as requiring awareness of absent-value semantics.

This is OPTIONAL.

AgentAPI MUST NOT claim such policies grant anonymous access after pt2.

---

# 52. Conformance v9 extension

`axiom.conformance.v9` remains the conformance contract.

Add fixtures covering F1.

Minimum new fixture families:

```text
anonymous-owner-tenant-deny
anonymous-neq-deny
anonymous-not-eq-deny
missing-resource-owner-deny
explicit-concrete-allow-control
```

Fixtures MUST carry independently computed expected results.

---

# 53. Required conformance cases

At minimum:

### C1 — both-absent equality

```text
RESOURCE.ownerId absent
PRINCIPAL.id absent
policy: RESOURCE.ownerId == PRINCIPAL.id

expected: DENY
```

### C2 — deny-list neq

```text
PRINCIPAL.role absent
policy: PRINCIPAL.role != "banned"

expected: DENY
```

### C3 — negated equality

```text
PRINCIPAL.role absent
policy: NOT(PRINCIPAL.role == "banned")

expected: DENY
```

### C4 — legitimate allow

```text
PRINCIPAL.role = "user"
policy: PRINCIPAL.role != "banned"

expected: ALLOW
```

### C5 — explicit public

```text
allow = literal(true)

anonymous expected: ALLOW
```

The explicit-public control is mandatory to prevent overcorrection.

---

# 54. Conformance persistence parity

All new authorization conformance fixtures MUST run over:

```text
memory
SQLite
```

with identical authorization decisions.

---

# 55. Existing v9 conformance

Every existing `axiom.conformance.v9` fixture must remain green.

Do not alter expectations merely to accommodate pt2 unless the old expectation encoded F1.

---

# 56. Prior conformance regression

Run all available prior relevant conformance suites:

```text
v1
v4
v5
v6
v7
v8
v9
```

At minimum, the suites previously used for:

```text
distributed authority
live queries
durable workflows
```

must remain green.

---

# 57. Unit/property test matrix for absence propagation

Add direct tests over the canonical authorization evaluator.

Minimum operators/compositions:

```text
eq
neq
not
and
or
```

plus relational operators if supported.

Inputs:

```text
concrete/concrete
concrete/absent
absent/concrete
absent/absent
```

Assert final authorization semantics, not merely internal representation.

---

# 58. Required OR controls

Examples:

```text
true OR absent-dependent
    => ALLOW

false OR absent-dependent
    => DENY

absent-dependent OR absent-dependent
    => DENY
```

These prove absence is not simply converted globally to false in a way that breaks safe
short-circuit semantics.

---

# 59. Required AND controls

Examples:

```text
true AND absent-dependent
    => DENY

false AND absent-dependent
    => DENY

concrete true AND concrete true
    => ALLOW
```

---

# 60. Required NOT controls

```text
NOT concrete true
    => DENY

NOT concrete false
    => ALLOW

NOT absent-dependent
    => DENY
```

---

# 61. Nested composition

Test at least:

```text
NOT(
  absentField == "x"
  OR
  concreteAllowedCondition
)
```

and nested combinations deeper than one operator.

Absence provenance must survive recursive evaluation.

---

# 62. Short-circuit implementation independence

Semantics MUST NOT depend on whether the runtime evaluates:

```text
left first
right first
both eagerly
```

Equivalent authorization expression meaning must remain identical.

Avoid an implementation where absence markers are lost only because a branch happened not
to execute.

---

# 63. Literal undefined control

If authoring vocabulary allows:

```text
literal(undefined)
```

or equivalent serialized nullish literal, define and test its behavior separately.

It MUST NOT automatically be treated as:

```text
AbsentSecurityValue
```

unless the semantic contract deliberately says so.

Security absence provenance comes from missing security-scope fields.

---

# 64. Missing scope object

If `RESOURCE` itself is absent for an operation and a policy references:

```text
field(ref(RESOURCE), X)
```

the result MUST be security-absent and therefore incapable of granting authority.

Same for a truly absent `PRINCIPAL`.

---

# 65. Missing nested field

If field access supports nesting and:

```text
PRINCIPAL.profile.department
```

is requested but:

```text
profile exists
department absent
```

the final missing security field MUST retain absent-security semantics.

No nested access may collapse into ordinary undefined and then create authority.

---

# 66. Policy evaluation error remains deny

Existing behavior:

```text
evaluation error => DENY
```

must remain unchanged.

0.15pt2 MUST NOT conflate:

```text
UNKNOWN_SECURITY
```

with an exception in a way that leaks native errors.

Both are DENY at the final authorization boundary.

---

# 67. Diagnostic behavior

For normal missing authorization attributes, denial should remain an ordinary authorization
decision.

Do NOT treat expected absence as a runtime crash.

A missing role should normally yield:

```text
AUTHORIZATION_DENIED
```

not:

```text
AUTHORIZATION_POLICY_ERROR
```

unless the public contract already distinguishes such cases intentionally.

---

# 68. No information leak through denial reason

Do not expose:

```text
which principal field was missing
which resource field was missing
secret policy internals
```

unless already part of the documented non-secret diagnostics contract.

Safe generic reason:

```text
policy-denied
```

is sufficient.

---

# 69. Caching

If authorization evaluation is cached anywhere, absence provenance must be part of the
effective authorization result.

A cached ALLOW from a complete principal must not be reused for:

```text
same identity shape with missing claim
anonymous
different principal
```

Existing principal-scoping guarantees remain mandatory.

---

# 70. Idempotency

F1 correction MUST happen before any idempotent successful response can be reused.

An anonymous caller denied by pt2 must not retrieve a prior principal's successful
idempotent action response.

Existing principal-scoped idempotency behavior remains unchanged.

---

# 71. Workflow start idempotency

Same textual key:

```text
P1 + K
ANON + K
```

must not transfer successful workflow start authority.

If ANON's policy relies on absent attributes:

```text
ANON => DENY
```

and no existing instance response is leaked.

---

# 72. Live cursor

A cursor remains:

```text
continuation state
not authorization
```

pt2 does not change cursor semantics.

But a resumed caller whose required field is now absent must be denied by the corrected
authorization evaluator.

---

# 73. Topology independence

Corrected F1 behavior must be identical on:

```text
1 authority
2 authorities
8 authorities
```

over shared SQLite infrastructure.

For the same policy/principal/resource:

```text
same authorization decision.
```

---

# 74. Real-process correction test

Run the F1 owner/tenant policy through independent OS processes.

At minimum:

```text
anonymous action
anonymous query
anonymous workflow start
anonymous live open
```

Expected across processes:

```text
DENY
```

No process-local evaluator divergence.

---

# 75. Failover

Start durable work on authority A.

Fail over to B.

If a protected continuation evaluates a policy requiring a field that is absent:

```text
DENY
```

on B exactly as it would on A.

---

# 76. Rolling upgrade alpha.1 → alpha.2

This test is mandatory because evaluator semantics changed.

Run actual published/staged builds:

```text
A = 0.15.0-alpha.1
B = 0.15.0-alpha.2
```

same graph.

Required:

```text
authority compatibility rejects mixed semantic participation
```

before either can jointly progress the same semantic authority domain.

If this test fails, pt2 is NOT releasable.

---

# 77. Rolling upgrade alpha.2 → alpha.2

Two independent alpha.2 builds/processes with same graph:

```text
compatible
```

and normal failover works.

---

# 78. Presentation-only compatibility

Two alpha.2 authorities whose graph differs only in:

```text
name
description
presentation metadata
```

remain compatible as in alpha.1.

---

# 79. F2 malformed policy regression corpus

At least:

```text
null policy node
non-object policy node
missing allow
allow = number
allow = string
allow = array
allow = {}
allow = { a: 1 }
allow = { kind: "literal" } with malformed shape
allow = { kind: "nonsense" }
malformed binary
malformed unary
malformed field
malformed ref
malformed nested expression
cyclic object where possible
```

Every public validation/analysis path must be total.

---

# 80. F3 authenticate throw regression corpus

Use hosts where authenticate throws:

```text
Error
string
plain object
custom Error with secret message
```

All must fail closed without native escape through public semantic methods.

---

# 81. Host authentication success unchanged

Normal:

```text
authenticate(credential) => Principal
```

behavior must be byte/semantically unchanged except for corrected authorization decisions.

---

# 82. Host anonymous behavior unchanged

Normal host behavior:

```text
authenticate(missingCredential) => null
```

remains valid.

pt2 must not require hosts to synthesize fake principals merely to avoid F1.

---

# 83. Host contract clarification

Public host documentation SHOULD state whether:

```text
authenticate()
```

may throw.

After pt2, regardless of recommendation, the server boundary must fail safely if it does.

---

# 84. Performance

Correctness dominates performance.

Do not reintroduce F1 to preserve ordinary expression evaluator fast paths.

However, pt2 should avoid unnecessary graph-wide changes.

Authorization-specific metadata/provenance is acceptable.

---

# 85. No arbitrary JS

The fix must remain fully portable.

Forbidden:

```text
AuthorizationPolicyDef {
  allow: () => ...
}
```

or host callbacks to decide missing-value semantics.

The corrected semantics must remain serializable and reproducible by an independent runtime.

---

# 86. Independent-runtime rule

A second implementation, given:

```text
Server IR v9
principal
resource
operation
```

must be able to reproduce the corrected result.

The rule must be expressible as semantic evaluation rules, not TypeScript behavior.

---

# 87. Canonical corrected rule

The portable rule is:

```text
A field read from PRINCIPAL or RESOURCE that does not resolve to a present value produces
authorization-absence.

Authorization-absence propagates through policy expressions such that it cannot by itself
make the policy true.

An AuthorizationPolicyDef grants access only when its final allow result is definitively
true without depending on authorization-absence.
```

This wording should appear, substantially equivalent, in the normative authorization docs.

---

# 88. No accidental default-deny migration

Existing surfaces without an authorization policy retain their 0.15 defaults.

pt2 does NOT redefine:

```text
missing policy
```

as:

```text
deny everything
```

Only a declared policy's handling of absent referenced security fields changes.

---

# 89. Public actions remain public where intended

An `ActionDef` with no:

```text
authorizationPolicy
legacy authorization
```

retains existing public behavior.

Regression test anonymous invocation.

---

# 90. Public queries remain public where intended

A `QueryDef` with no:

```text
authorizationPolicy
```

retains existing operation-level public behavior, subject to any existing `ReadPolicyDef`.

Regression test.

---

# 91. Workflow owner baseline unchanged

A workflow with no `instanceAccessPolicy` continues to use the established owner-fingerprint
default for cancellation.

pt2 must not replace that rule with new generic policy behavior.

---

# 92. Explicit instance policy still overrides owner baseline

Where:

```text
instanceAccessPolicy
```

exists, it remains the explicit decision mechanism.

The absent-value fix applies to that policy.

No implicit admin/role bypass.

---

# 93. Terminal cancellation idempotency unchanged

The 0.14/0.15 terminal cancellation rule remains unchanged.

pt2 only alters policy evaluation when authorization evaluation actually occurs.

---

# 94. Authorization denial retry classification unchanged

`AUTHORIZATION_DENIED` remains terminal/non-retryable for workflow action execution.

A pt2 denial due to missing fields must not be treated as infrastructure failure.

---

# 95. External effects

If a corrected authorization policy denies:

```text
logical effect creation = 0
physical effect attempts = 0
```

No downstream effect may be created before the corrected authorization decision.

---

# 96. Structured refusal

F1 corrections must produce the same normal refusal shape used for ordinary policy denial.

Expected canonical code:

```text
AUTHORIZATION_DENIED
```

No special:

```text
AUTHORIZATION_MISSING_FIELD
```

is required publicly.

---

# 97. Release-blocking internal gates

Before publishing `0.15.0-alpha.2`, all of the following must be green:

```text
F1 both-absent equality regression
F1 neq regression
F1 not(eq()) regression
explicit-public anonymous ALLOW control
ActionDef policy regression
QueryDef policy regression
WorkflowDef startPolicy regression
instanceAccessPolicy regression
live.open regression
live.resume / reevaluation regression
memory / SQLite parity
1/2/8 authority parity
alpha.1 vs alpha.2 compatibility refusal
F2 malformed allow validation
F3 authenticate throw safe boundary
existing v9 conformance
prior relevant conformance
```

---

# 98. Required forbidden counters

Internal corrective tests should explicitly maintain:

```text
anonymous_policy_fail_open
unauthorized_action_execution
unauthorized_query_execution
unauthorized_record_observation
unauthorized_workflow_start
unauthorized_workflow_inspection
unauthorized_workflow_cancellation
unauthorized_live_open
unauthorized_live_resume
malformed_credential_privilege_gain
native_authentication_exception_escape
mixed_evaluator_compatible
```

All must finish:

```text
0
```

---

# 99. Existing alpha.1 forbidden counters

All counters that were zero in the external alpha.1 campaign must remain zero.

Especially:

```text
cross_principal_cursor_reuse
cross_principal_action_idempotency_reuse
cross_principal_workflow_start_idempotency_reuse
revoked_workflow_privilege_continues
revoked_live_data_continues
mixed_build_authorization_silent_continuation
topology_dependent_authorization
authorization_toctou_commit
credential_argument_ignored
provider_auth_bypass
transport_auth_bypass
```

---

# 100. Publication

Publish all coordinated packages required for an external clean consumer as:

```text
0.15.0-alpha.2
```

Do not externally validate workspace-linked packages.

The blind rerun must install only published package artifacts.

---

# 101. Package version coherence

External consumer must resolve all Axiom packages to the intended alpha.2 set.

No accidental mix:

```text
core alpha.2
server alpha.1
```

unless the package architecture explicitly and safely allows it and compatibility is
proven.

Preferred:

```text
all coordinated packages = 0.15.0-alpha.2
```

---

# 102. Broad external rerun required

Because F1 changes authorization evaluator semantics, `spec15` §129 full-rerun trigger is
satisfied.

Therefore alpha.2 MUST receive a broad external rerun of the full 0.15 authorization
campaign.

A focused F1-only retest is insufficient for semantic freeze.

---

# 103. Reuse previous blind harness

The existing external 130-section harness SHOULD be reused unchanged wherever possible.

The original F1 assertions become mandatory regression gates.

Do not modify expected results to fit implementation behavior.

Expected F1 results remain:

```text
anonymous => DENY
missing required security attribute => DENY
```

---

# 104. Blindness

External alpha.2 validation remains blind.

Tester may use:

```text
published npm packages
shipped docs
.d.ts
Server IR schemas
AgentAPI
conformance fixtures
```

Tester must not use:

```text
repository source
internal tests
implementation report
spec15pt2 implementation notes
maintainer hints about code location
```

The tester may know the external alpha.1 finding, because alpha.2 is explicitly a corrective
release for that public validation result.

---

# 105. Mandatory focused F1 rerun

Before or as part of the broad campaign, rerun all original F1 cases.

Required:

```text
21 / 21 original F1 failure assertions now pass
```

or the exact equivalent count if the harness evolves without changing semantics.

---

# 106. Mandatory F2 rerun

Verify malformed `allow` objects are rejected before runtime.

Required:

```text
validateGraph invalid
structured diagnostic
compile does not silently admit malformed graph
AgentAPI total
```

---

# 107. Mandatory F3 rerun

Throw from `host.authenticate()` on:

```text
server.handle
server.startWorkflow
server.cancelWorkflow
query
live open
live resume
workflow inspection/history
```

as exposed by public API.

Required:

```text
no native exception escapes
no protected data
no mutation
```

---

# 108. Full external action suite

Rerun:

```text
direct authorization matrix
legacy ∧ policy
workflow action path
confused deputy
retry classification
cross-principal idempotency
```

Expected all green.

---

# 109. Full external query suite

Rerun:

```text
one-shot
query operation inside action
row policy
tenant isolation
owner isolation
sort
limit
aggregate
cache
```

Expected all green.

---

# 110. Full external workflow suite

Rerun:

```text
startPolicy
owner fingerprint
instanceAccessPolicy
cancel
inspect
history
list filtering
terminal idempotency
principal preservation
idempotent start
```

Expected all green.

---

# 111. Full external live suite

Rerun:

```text
open
one-shot equivalence
row revocation
row gain
whole-query revocation
resume reauthorization
cross-principal cursor
real-process failover
```

Expected all green.

---

# 112. Mixed-build external suite

Rerun the existing graph-semantic mixed-build tests.

Additionally add:

```text
alpha.1 vs alpha.2 same graph
```

This is mandatory because graph fingerprint alone cannot expose evaluator-version drift.

Expected:

```text
incompatible.
```

---

# 113. Real-process rerun

Repeat representative real OS matrix:

```text
cross-principal race
1/2/8 topology
workflow SIGKILL failover
live failover
SIGSTOP stale authority
contention soak
rolling deployment
```

At minimum use the same order of magnitude as the successful alpha.1 campaign.

---

# 114. Conformance external rerun

Run:

```text
axiom.conformance.v9
```

over:

```text
memory
SQLite
```

including all new F1 regression fixtures.

All must pass.

---

# 115. Discoverability rerun

The blind tester must still be able to answer:

```text
how missing principal/resource fields behave in authorization
```

from shipped docs alone.

The answer must clearly be:

```text
missing security fields cannot grant access.
```

This is now part of D1.

---

# 116. E1 regression

Correcting F1 must not require:

```text
raw JS
host callback authorization
provider-specific authorization
```

The original portable policies must remain expressible in graph vocabulary.

---

# 117. Safety target

External target:

```text
S1
```

requires:

```text
F1 closed
F2/F3 closed or demonstrably non-blocking and documented
all release-blocking forbidden counters = 0
no new authorization bypass introduced
alpha.1/alpha.2 mixed evaluator participation refused
```

---

# 118. Findings handling

If alpha.2 external validation finds another release blocker:

```text
DO NOT FREEZE
```

Create the smallest corrective follow-up:

```text
spec15pt3
```

Do not reopen unrelated 0.15 feature scope.

---

# 119. Full-rerun trigger after pt2

If a later corrective changes any of:

```text
authorization evaluator semantics
principal canonicalization
resource authorization binding
semantic projection
authority compatibility identity
query authorization ordering
workflow principal semantics
live reauthorization
idempotency security scoping
```

another broad rerun is required.

---

# 120. Freeze criterion

Axiom 0.15 freezes only when a published corrective candidate receives:

```text
D1 / E1 / S1
```

from blind external validation.

Internal green is not sufficient.

---

# 121. Expected successful final state

After pt2 and external validation:

```text
Axiom 0.15 — Authorization Completeness

Version under validation: 0.15.0-alpha.2

F1  CLOSED
F2  CLOSED
F3  CLOSED

D1
E1
S1

EXTERNALLY VALIDATED
SEMANTIC MODEL FROZEN
```

---

# 122. Final semantic invariant

After 0.15pt2, the authorization contract MUST satisfy:

```text
Given a graph G, canonical principal P, semantic resource R and operation O,
an AuthorizationPolicyDef can grant authority only from positively satisfied,
present semantic information.

Missing PRINCIPAL or RESOURCE fields cannot manufacture authority through
equality, inequality, negation, boolean composition, evaluator quirks, retries,
workflow execution, live-query continuation, process failover or topology.

Authorization remains deterministic, serializable, inspectable,
runtime-independent and fail-closed.
```

---

# 123. Final compatibility invariant

After 0.15pt2:

```text
Two authorities that can make different authorization decisions for the same
Server IR, principal, resource and operation MUST NOT be considered compatible.
```

This includes evaluator-version differences such as:

```text
0.15.0-alpha.1
vs
0.15.0-alpha.2
```

for authorization-bearing graphs.

---

# 124. Final validation sequence

```text
implement spec15pt2
        ↓
internal F1/F2/F3 regression
        ↓
internal conformance + prior regression
        ↓
real-process compatibility / topology tests
        ↓
publish 0.15.0-alpha.2
        ↓
fresh external consumer
        ↓
full 130-section authorization rerun
        ↓
D1 / E1 / S1
        ↓
freeze Axiom 0.15
        ↓
proceed to Axiom 0.16
```

---

# 125. Out of scope

0.15pt2 does NOT add:

```text
new authorization policy kinds
new authorization attachment points
delegation
impersonation
RBAC framework
ABAC framework beyond existing expressions
policy administration APIs
new provider authorization hooks
new workflow semantics
new live-query vocabulary
new Server IR vocabulary
new authorization UI
```

This is a corrective semantic closure release only.

---

# 126. Release-blocker summary

The following are release blockers for `0.15.0-alpha.2`:

```text
RB1
Any policy can still ALLOW because two absent security fields compare equal.

RB2
neq / not / equivalent composition can still turn a missing PRINCIPAL or RESOURCE field
into ALLOW.

RB3
The fix is surface-specific instead of canonical.

RB4
Explicit public constant policy no longer permits anonymous access.

RB5
alpha.1 and alpha.2 authorities with the same authorization-bearing graph are considered
compatible despite evaluator-semantic differences.

RB6
Malformed policy structure can cause native validation/analyzer/runtime exceptions.

RB7
A thrown authenticate() exception can cross a principal-facing public semantic boundary
with protected data or mutation, or as an unhandled native failure where pt2 promises
structured refusal.

RB8
Existing row/query/workflow/live/idempotency/mixed-build authorization invariants regress.

RB9
Published alpha.2 does not pass a full blind external rerun.
```

---

# 127. Recommended implementation strategy

A preferred implementation shape is:

```text
evaluateAuthorizationExpression(...)
    ↓
returns value + security-absence provenance
    ↓
authorization operators propagate provenance conservatively
    ↓
final decision:
    definitively true => ALLOW
    everything else   => DENY
```

Do not attempt to infer absence after ordinary evaluation has already reduced:

```text
absent
```

to:

```text
undefined
```

because provenance may already be lost.

The evaluator should know absence at the point of scope field resolution.

---

# 128. Preferred scope of code change

The smallest healthy change should be concentrated around:

```text
authorization-policy evaluation
authorization scope field resolution
authorization decision
authorization structural validation
credential-resolution boundary
authority runtime-semantic compatibility
```

Avoid touching unrelated generic runtime semantics.

---

# 129. Acceptance checklist

Before declaring implementation complete:

```text
[ ] absent PRINCIPAL field provenance preserved
[ ] absent RESOURCE field provenance preserved
[ ] eq absent cases deny
[ ] neq absent cases deny
[ ] not absent-derived predicate denies
[ ] nested boolean composition correct
[ ] explicit literal(true) still allows anonymous
[ ] operation-only policy unaffected
[ ] action surface corrected
[ ] query surface corrected
[ ] workflow start corrected
[ ] instance access corrected
[ ] live open corrected
[ ] live reevaluation corrected
[ ] live resume corrected
[ ] workflow continuation corrected
[ ] memory/SQLite parity
[ ] malformed policy rejected structurally
[ ] validator/analyzer totality
[ ] authenticate throw caught
[ ] authentication error secret-free
[ ] zero mutation on authentication failure
[ ] v9 contract unchanged
[ ] v9 conformance extended
[ ] alpha.1 vs alpha.2 authority incompatibility proven
[ ] prior conformance green
[ ] real-process tests green
[ ] package release coherent
[ ] full external rerun ready
```

---

# 130. Milestone gate

`0.15.0-alpha.2` may be published when the internal gates above are green.

Axiom 0.15 may be declared complete only after the published package receives:

```text
D1 / E1 / S1
```

from the full blind external validation campaign.

Until then:

```text
0.15 Authorization Completeness
    IMPLEMENTED
    CORRECTIVE VALIDATION IN PROGRESS
    NOT FROZEN
```

After successful validation:

```text
0.15 Authorization Completeness
    EXTERNALLY VALIDATED
    SEMANTIC MODEL FROZEN
```

Then proceed to:

```text
0.16 — Tooling / Explainability / AI Authoring
```