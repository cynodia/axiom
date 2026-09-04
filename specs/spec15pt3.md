# Axiom 0.15pt3 Specification
## Legacy Action Authorization Absent-Value Closure

**Target:** `0.15.0-alpha.3`  
**Baseline:** `0.15.0-alpha.2`  
**Milestone:** Axiom 0.15 — Authorization Completeness  
**Corrective release:** `spec15pt3`  
**Server IR:** `axiom.server.v9` — unchanged  
**Conformance:** `axiom.conformance.v9` — extended, contract id unchanged  
**External validation:** broad 0.15 blind rerun required  
**Target verdict:** `D1 / E1 / S1`

---

# 1. Status of 0.15.0-alpha.2

The blind external validation rerun of `0.15.0-alpha.2` confirms that the original 0.15pt2 findings are closed:

```text
F1 — AuthorizationPolicyDef absent-value fail-open
CLOSED

F2 — malformed AuthorizationPolicyDef.allow validation gap
CLOSED

F3 — throwing host.authenticate() native exception boundary
CLOSED
```

The corrective release successfully established three-valued absent-value semantics for:

```text
AuthorizationPolicyDef.allow
```

including:

```text
PRINCIPAL.role != "banned"
NOT(PRINCIPAL.role == "banned")
RESOURCE.ownerId == PRINCIPAL.id
```

when referenced `PRINCIPAL` / `RESOURCE` attributes are absent.

The alpha.2 rerun also confirms:

```text
unauthorized_* counters = 0
credential suite = 22/22
authorization conformance = expanded and green
alpha.1 ↔ alpha.2 authz-runtime compatibility = fail-closed
F2/F3 corrective gates = green
```

However, one new release-blocking finding remains.

---

# 2. New finding: F1-legacy

The legacy:

```text
ActionDef.authorization
```

Expression path retains pre-0.15 ordinary Expression evaluation semantics.

For a policy such as:

```text
NOT(PRINCIPAL.role == "banned")
```

the observed behavior remains:

```text
role = "banned"     => DENY
role = "user"       => ALLOW
anonymous           => ALLOW
malformed principal => ALLOW
```

because:

```text
PRINCIPAL.role absent
    ↓
eq(absent, "banned") == false
    ↓
NOT(false) == true
    ↓
legacy authorization allows
```

Equivalent fail-open behavior exists for:

```text
PRINCIPAL.role != "banned"
```

and other expressions where ordinary missing-value semantics can turn absence into a positive boolean result.

This is:

```text
F1-legacy
Authorization fail-open through legacy ActionDef.authorization
RELEASE BLOCKING
```

---

# 3. Why F1-legacy blocks the 0.15 freeze

`ActionDef.authorization` remains:

```text
public
supported
semantically active
part of the effective ActionDef authorization decision
```

0.15 deliberately preserves it and combines it with the new authorization model.

The effective action decision therefore includes:

```text
legacy ActionDef.authorization
AND
AuthorizationPolicyDef
```

where applicable.

A known fail-open authorization mechanism cannot remain inside the frozen 0.15 authorization model merely because it predates 0.15.

The milestone invariant remains:

```text
missing security data cannot manufacture authority
```

for every authorization mechanism still supported by the framework.

---

# 4. Purpose

0.15pt3 closes the remaining absent-value fail-open in:

```text
ActionDef.authorization
```

without changing general-purpose Expression semantics.

The corrected invariant is:

```text
Any expression evaluated as an authorization decision must use
authorization-safe absent-value semantics.
```

This applies to both:

```text
AuthorizationPolicyDef.allow
ActionDef.authorization
```

while preserving their otherwise distinct historical contracts.

---

# 5. Primary invariant

For any ActionDef authorization expression `A`:

```text
legacyAuthorizationDecision(A, principal, resource?, operation?)
```

MUST NOT return authorization success if that success depends on a missing security-scope field.

Examples:

```text
PRINCIPAL.role != "banned"
```

with absent role:

```text
DENY
```

```text
NOT(PRINCIPAL.role == "banned")
```

with absent role:

```text
DENY
```

```text
PRINCIPAL.id == RESOURCE.ownerId
```

with both absent where such resource scope is available:

```text
DENY
```

---

# 6. Do not change ordinary Expression semantics

0.15pt3 MUST NOT globally redefine:

```text
eq
neq
not
and
or
undefined/null handling
```

for ordinary expressions.

Existing non-authorization Expression behavior remains unchanged.

The correction applies only when an Expression is interpreted as authorization semantics.

---

# 7. Reuse the pt2 authorization-aware evaluator

The preferred architecture is to reuse the canonical pt2 absent-aware evaluation machinery.

Expected conceptual structure:

```text
evaluateAuthorizationExpression(...)
```

or equivalent canonical internal primitive.

Both:

```text
AuthorizationPolicyDef.allow
ActionDef.authorization
```

must use the same security-aware handling of missing `PRINCIPAL` / `RESOURCE` values.

Forbidden:

```text
legacyAuthorizationAbsentHack()
```

implemented as a second independent partial evaluator.

The two authorization paths must not drift again.

---

# 8. Preserve semantic distinction between new and legacy authorization

Sharing absent-value semantics does NOT imply collapsing:

```text
AuthorizationPolicyDef.allow
```

and:

```text
ActionDef.authorization
```

into one identical public contract.

Any historical differences that remain intentionally supported MUST be preserved.

In particular:

```text
legacy truthiness semantics
legacy expression scope
legacy diagnostics
legacy serialization
legacy compatibility
```

must not change except where required to eliminate fail-open behavior.

---

# 9. Legacy truthiness

If legacy `ActionDef.authorization` historically accepts non-boolean truthy values as allow, 0.15pt3 SHOULD preserve that contract unless current public artifacts already require exact boolean `true`.

However:

```text
truthiness derived from authorization-absence
```

MUST NOT grant authority.

Conceptually:

```text
Concrete(truthy) => existing legacy behavior

UnknownSecurity => DENY

Error => existing fail-closed legacy behavior
```

The fix concerns security absence provenance, not unrelated truthiness compatibility.

---

# 10. Security-scope absence

The legacy authorization evaluator MUST treat a missing field obtained from authorization scope as security absence.

At minimum:

```text
field(ref(PRINCIPAL), F)
```

when `F` is absent.

If legacy authorization scope exposes `RESOURCE`, equivalent rules apply to it.

Security absence MUST retain provenance through expression evaluation.

---

# 11. Required behavior for neq

Legacy policy:

```text
PRINCIPAL.role != "banned"
```

Expected:

```text
role = "user"       => ALLOW
role = "banned"     => DENY
role absent         => DENY
anonymous           => DENY
malformed credential resolving without role
                    => DENY
```

This is a mandatory F1-legacy regression gate.

---

# 12. Required behavior for negated equality

Legacy policy:

```text
NOT(PRINCIPAL.role == "banned")
```

Expected:

```text
role = "user"       => ALLOW
role = "banned"     => DENY
role absent         => DENY
anonymous           => DENY
malformed principal => DENY
```

---

# 13. Both-absent equality

Where legacy authorization can compare two security-scoped fields:

```text
A == B
```

and both resolve absent:

```text
DENY
```

The evaluator MUST NOT grant authority because ordinary Expression semantics consider two absent values equal.

---

# 14. Boolean propagation

The pt2 security-aware boolean propagation rules SHOULD be reused.

Conceptual values:

```text
TRUE
FALSE
UNKNOWN_SECURITY
ERROR
```

Final legacy authorization must not grant on:

```text
UNKNOWN_SECURITY
ERROR
```

Boolean propagation must prevent:

```text
NOT UNKNOWN_SECURITY => TRUE
```

and:

```text
UNKNOWN_SECURITY != literal => TRUE
```

---

# 15. Safe OR semantics

For legacy authorization:

```text
TRUE OR UNKNOWN_SECURITY
```

may remain:

```text
TRUE
```

because an independent concrete branch grants authority.

But:

```text
FALSE OR UNKNOWN_SECURITY
UNKNOWN_SECURITY OR UNKNOWN_SECURITY
```

must not grant authority.

This preserves legitimate positive authorization while preventing absence from creating it.

---

# 16. Safe AND semantics

For:

```text
TRUE AND UNKNOWN_SECURITY
```

final authorization must deny.

For:

```text
FALSE AND UNKNOWN_SECURITY
```

final authorization also denies.

For:

```text
TRUE AND TRUE
```

existing legacy allow behavior remains.

---

# 17. Constant allow control

An explicit legacy policy such as:

```text
literal(true)
```

must retain its current meaning.

If legacy `literal(true)` allows anonymous callers today, it must continue to do so.

0.15pt3 MUST NOT implement:

```text
anonymous => unconditional deny
```

The rule is:

```text
missing referenced security fields cannot create authority
```

not:

```text
anonymous is categorically forbidden.
```

---

# 18. Constant deny control

```text
literal(false)
```

must continue to deny.

---

# 19. Positive role policy

Policy:

```text
PRINCIPAL.role == "admin"
```

Expected:

```text
admin       => ALLOW
user        => DENY
anonymous   => DENY
role absent => DENY
```

This serves as a control showing ordinary positive rules remain unchanged.

---

# 20. Owner / identity controls

Where expressible in legacy authorization:

```text
PRINCIPAL.id == expectedOwner
```

Expected:

```text
matching concrete id => ALLOW
other id             => DENY
id absent            => DENY
anonymous            => DENY
```

---

# 21. No surface-specific workaround

Every runtime path invoking legacy `ActionDef.authorization` MUST use the corrected evaluator.

At minimum:

```text
direct action invocation
workflow ActionDef step
scheduler-driven ActionDef invocation
event-triggered ActionDef invocation
retry
failover reconciliation
```

where these paths are supported.

No path may continue using generic `runtime.evaluate()` directly for authorization.

---

# 22. Action path equivalence

For the same:

```text
ActionDef
principal
authorization expression
```

the authorization result must be identical across:

```text
direct
workflow
scheduler
event
retry
failover
```

Any path-specific result is release blocking.

---

# 23. Combined legacy + new policy

When both are present:

```text
ActionDef.authorization
ActionDef.authorizationPolicy
```

the existing conjunction remains:

```text
legacyDecision AND policyDecision
```

Required cases:

```text
legacy allow + policy allow => ALLOW
legacy deny  + policy allow => DENY
legacy allow + policy deny  => DENY
legacy deny  + policy deny  => DENY
```

No OR semantics.

---

# 24. Absent-value conjunction regression

Test:

```text
legacy = NOT(PRINCIPAL.role == "banned")
policy = literal(true)
```

Anonymous caller:

```text
legacy => DENY
policy => ALLOW

effective => DENY
```

This is a direct regression for F1-legacy.

---

# 25. New policy cannot mask legacy fail-open

Test:

```text
legacy fail-open-shaped expression
authorizationPolicy allows
```

The legacy side must independently produce the corrected safe decision.

Do not rely on the new policy side to compensate.

---

# 26. New policy deny remains deny

If:

```text
legacy ALLOW
new policy DENY
```

result remains:

```text
DENY
```

pt3 must not alter pt2 policy semantics.

---

# 27. Authentication failure interaction

pt2 established:

```text
host.authenticate() throw
    => AUTHORIZATION_DENIED
    => never anonymous fallback
```

pt3 MUST preserve this.

F1-legacy tests should include malformed credentials resolving to:

```text
null
attribute-less principal
```

but an actual authentication exception must still fail at the authentication boundary before authorization.

---

# 28. Anonymous principal semantics

If host authentication legitimately resolves:

```text
credential missing => anonymous/null principal
```

legacy authorization must apply safe absent-value semantics to any referenced principal fields.

---

# 29. Attribute-less named principal

A principal object may exist but omit:

```text
role
tenant
id
```

as applicable.

Missing fields must behave the same safe way as anonymous field absence.

There must be no distinction where:

```text
anonymous absent => DENY
named-but-missing => ALLOW
```

for the same rule.

---

# 30. No privilege through malformed principal shape

If a host returns a malformed/partial principal object without a referenced attribute, absence must not convert into authority through:

```text
neq
not
both-absent equality
```

---

# 31. Preserve ordinary runtime.evaluate behavior

Any non-authorization use of:

```text
runtime.evaluate(expression)
```

must remain byte/semantically unchanged.

Add regression tests proving:

```text
ordinary eq(undefined, undefined)
```

still has existing semantics if externally observable.

---

# 32. Canonical authorization evaluator architecture

After pt3, authorization expression evaluation SHOULD have one canonical security-aware primitive shared by:

```text
AuthorizationPolicyDef.allow
ActionDef.authorization
```

Possible structure:

```text
evaluateAuthorizationExpression(expression, context, mode)
```

where:

```text
mode = policy
mode = legacy-action
```

may preserve final interpretation differences while sharing:

```text
absence provenance
operator propagation
error containment
```

This is preferred over duplicating evaluator code.

---

# 33. No parallel absence semantics

Forbidden:

```text
policy evaluator:
    UNKNOWN_SECURITY ruleset A

legacy evaluator:
    independent UNKNOWN_SECURITY ruleset B
```

unless both demonstrably derive from one canonical implementation.

The pt3 goal includes preventing another semantic drift between old and new authorization.

---

# 34. Validation

No new public graph vocabulary is introduced.

Existing validation for:

```text
ActionDef.authorization
```

must remain total.

If malformed legacy authorization expressions can still reach native runtime errors, pt3 SHOULD close them where inexpensive, but this is not the primary finding unless externally reproduced.

---

# 35. Server IR

Expected latest contract remains:

```text
axiom.server.v9
```

No new semantic vocabulary is introduced.

Do NOT create:

```text
axiom.server.v10
```

for this evaluator correction alone.

---

# 36. Conformance contract

Expected remains:

```text
axiom.conformance.v9
```

Extend authorization conformance fixtures.

Do not create a new conformance contract solely for pt3.

---

# 37. Runtime semantic compatibility

pt2 introduced:

```text
authorizationRuntime = "axiom.authz.v2"
```

for authorization-bearing IR to prevent alpha.1 and alpha.2 authorities from mixing.

pt3 changes authorization semantics again.

Therefore alpha.2 and alpha.3 authorities MUST NOT be considered semantically compatible for graphs whose executable semantics can exercise the changed legacy authorization path.

---

# 38. New authorization runtime discriminator

The preferred compatibility identity for alpha.3 is:

```text
authorizationRuntime = "axiom.authz.v3"
```

or equivalent monotonic semantic discriminator.

The exact string is not normative.

The invariant is:

```text
alpha.2 legacy auth evaluator
!=
alpha.3 legacy auth evaluator
```

therefore mixed authorities MUST fail closed.

---

# 39. When to stamp the discriminator

The discriminator MUST cover any graph whose runtime meaning can depend on the changed evaluator.

At minimum:

```text
graph contains ActionDef.authorization
```

It MAY also remain stamped for all graphs using 0.15 authorization vocabulary if that is the existing canonical compatibility strategy.

However, unaffected graphs SHOULD retain rolling-upgrade compatibility where safely possible.

---

# 40. Alpha.2 ↔ alpha.3 mixed legacy graph

Mandatory test:

```text
Authority A = 0.15.0-alpha.2
Authority B = 0.15.0-alpha.3

same graph
graph contains legacy ActionDef.authorization
same persistence/coordination stores
```

Required:

```text
INCOMPATIBLE
```

or equivalent fail-closed authority refusal.

---

# 41. Alpha.2 ↔ alpha.3 graph with new authorization policy

If graph uses both:

```text
ActionDef.authorization
AuthorizationPolicyDef
```

it must also be incompatible across evaluator versions.

---

# 42. Alpha.2 ↔ alpha.3 unaffected graph

Graph contains neither:

```text
ActionDef.authorization
```

nor authorization vocabulary affected by runtime semantic change.

Preferred:

```text
compatible
```

provided no other runtime semantic compatibility change requires refusal.

---

# 43. Semantic fingerprint unchanged

The graph is identical across alpha.2/alpha.3.

Therefore:

```text
semanticFingerprint
```

SHOULD remain unchanged.

Do not encode runtime evaluator version into graph semantic identity.

Runtime semantic compatibility belongs in authority compatibility identity.

---

# 44. Existing pt2 new-policy behavior unchanged

All corrected alpha.2 cases must remain green:

```text
AuthorizationPolicyDef eq(absent, absent) => DENY
AuthorizationPolicyDef neq absent        => DENY
AuthorizationPolicyDef not(eq absent)    => DENY
literal(true) explicit public            => ALLOW
```

No pt3 regression.

---

# 45. F2 remains closed

Malformed:

```text
AuthorizationPolicyDef.allow
```

trees continue to fail validation with structured:

```text
AUTHORIZATION_INVALID_POLICY
```

or canonical equivalent.

---

# 46. F3 remains closed

A throwing:

```text
ServerHost.authenticate()
```

must continue to produce structured fail-closed:

```text
AUTHORIZATION_DENIED
reason = authentication-error
```

with:

```text
no native exception
no mutation
no protected data
```

---

# 47. Legacy deny-list conformance fixture

Add a conformance fixture:

```text
legacy-action-neq-absent-deny
```

or equivalent.

Policy:

```text
PRINCIPAL.role != "banned"
```

Expected:

```text
user       => ALLOW
banned     => DENY
anonymous  => DENY
no-role    => DENY
```

---

# 48. Legacy negated-equality conformance fixture

Add:

```text
legacy-action-not-eq-absent-deny
```

Policy:

```text
NOT(PRINCIPAL.role == "banned")
```

Expected same matrix as above.

---

# 49. Legacy constant-public control fixture

Add or retain control:

```text
legacy ActionDef.authorization = literal(true)
```

Expected:

```text
anonymous => ALLOW
```

if this is the existing legacy contract.

This prevents overcorrection.

---

# 50. Legacy positive-role control

Fixture:

```text
PRINCIPAL.role == "admin"
```

Expected:

```text
admin      => ALLOW
user       => DENY
anonymous  => DENY
```

---

# 51. Combined legacy + new policy fixture

Add at least one fixture where:

```text
legacy authorization
AND
authorizationPolicy
```

are both active.

Use an absent-value legacy expression to prove the conjunction cannot fail open.

---

# 52. Memory parity

All new fixtures run over:

```text
memory
```

---

# 53. SQLite parity

All new fixtures run over:

```text
SQLite
```

Required:

```text
identical authorization decisions
```

---

# 54. Direct evaluator tests

Add focused unit tests over the canonical authorization-aware evaluator.

Minimum legacy cases:

```text
neq concrete/concrete
neq absent/concrete
eq absent/absent
not(eq absent/concrete)
OR with independent TRUE
AND with UNKNOWN
nested NOT/OR
literal(true)
literal(undefined) if representable
```

---

# 55. Nested deny-list

Test:

```text
NOT(
  PRINCIPAL.role == "banned"
  OR
  PRINCIPAL.status == "disabled"
)
```

Cases:

```text
role=user,status=active => ALLOW
role=banned             => DENY
status=disabled         => DENY
role absent             => DENY
status absent           => DENY
anonymous               => DENY
```

unless another independent branch conclusively determines denial.

---

# 56. Independent positive OR

Test:

```text
PRINCIPAL.id == "public-service"
OR
PRINCIPAL.role != "banned"
```

For principal:

```text
id = public-service
role absent
```

Expected:

```text
ALLOW
```

because the first branch independently and concretely grants access.

This ensures UNKNOWN does not poison a valid positive allow.

---

# 57. False OR unknown

For:

```text
PRINCIPAL.id == "public-service"
OR
PRINCIPAL.role != "banned"
```

anonymous caller:

```text
first branch unknown
second branch unknown
```

Expected:

```text
DENY
```

---

# 58. Explicit non-security undefined

If legacy expressions can contain a literal nullish value:

```text
literal(undefined)
```

it remains a concrete expression value rather than security absence.

Do not conflate:

```text
literal(undefined)
```

with:

```text
missing PRINCIPAL.role
```

This preserves the pt2 provenance rule.

---

# 59. Action mutation safety

For every corrected denied legacy authorization case:

```text
action executions = 0
state mutation = 0
provider mutation = 0
logical effects = 0
```

---

# 60. Action idempotency safety

Scenario:

```text
P1 authorized invokes key K
ANON invokes same K
legacy deny-list expression
```

Required:

```text
ANON denied
ANON does not receive P1 response
ANON does not inherit P1 authority
```

Existing principal-scoped idempotency remains intact.

---

# 61. Workflow action step

Workflow starts under principal whose later legacy-protected action lacks a required attribute.

Required:

```text
action denied at execution time
```

Workflow start itself does not bypass legacy action authorization.

---

# 62. Workflow privilege amplification regression

Scenario:

```text
P may start workflow
P cannot pass corrected legacy ActionDef.authorization
workflow reaches protected ActionDef
```

Required:

```text
action executes 0 times
```

---

# 63. Workflow retry classification

A denial caused by missing legacy authorization fields is:

```text
authorization denial
```

not:

```text
transient execution failure
```

It must not enter retry loops as infrastructure failure.

---

# 64. Scheduler path

If a scheduler invokes a legacy-authorized ActionDef:

```text
effective principal missing required field
```

must result in:

```text
DENY
```

No implicit scheduler/system privilege.

---

# 65. Event-triggered path

If an event/trigger invokes a legacy-authorized ActionDef, the same corrected semantics apply.

No infrastructure path may retain pre-pt3 generic expression evaluation.

---

# 66. Failover path

Protected action pending across authority failover:

```text
A dies
B resumes
```

B must evaluate corrected legacy authorization identically.

---

# 67. Retry path

A retry of the same logical action invocation must not switch evaluator semantics or principal interpretation.

---

# 68. Topology independence

Run representative legacy authorization decisions over:

```text
1 authority
2 authorities
8 authorities
```

Required:

```text
same ALLOW/DENY result
```

---

# 69. Real OS processes

Use independent OS processes sharing SQLite.

Test:

```text
anonymous legacy deny-list action
authorized named caller
banned named caller
```

Expected decisions identical across processes.

---

# 70. SIGKILL failover

Run workflow/action scenario using legacy authorization.

Kill the current authority before protected invocation/resolution boundary.

Fresh authority resumes.

Required:

```text
same corrected decision
```

---

# 71. SIGSTOP stale authority

If stale authority resumes after losing lease/fence, it must not commit a mutation based on obsolete ownership or old evaluator semantics.

Existing fencing guarantees remain.

---

# 72. Mixed evaluator topology

Never permit:

```text
some authorities apply alpha.2 legacy semantics
some apply alpha.3 legacy semantics
```

inside one compatible authority domain for an affected graph.

This would make authorization topology-dependent.

Release blocker if observed.

---

# 73. External report classification

The alpha.2 finding should be recorded as:

```text
F1-legacy
legacy ActionDef.authorization absent-value fail-open
```

pt3 success must explicitly mark:

```text
CLOSED
```

---

# 74. Documentation update

Authorization docs MUST state that fail-closed absent-value semantics apply to:

```text
AuthorizationPolicyDef.allow
legacy ActionDef.authorization
```

where both are supported.

Do not leave readers with the impression that only new policy nodes receive safe missing-value semantics.

---

# 75. Legacy documentation

If legacy authorization is deprecated, documentation MAY say so.

But deprecation does not excuse unsafe runtime semantics while the feature remains supported.

If the project intends to remove legacy authorization before 1.0, that is a separate roadmap decision.

---

# 76. Migration compatibility

Existing legacy expressions that relied on missing attributes evaluating to authorization success will change behavior.

This is intentional.

The migration is:

```text
fail-open legacy expression
    ↓
fail-closed
```

This is a security correction.

Document this clearly in alpha.3 release notes.

---

# 77. No compatibility shim preserving fail-open

Do NOT add:

```text
legacyUnsafeMissingValueSemantics: true
```

or equivalent opt-out merely to preserve alpha.2 behavior.

The unsafe behavior must not remain portable application semantics.

---

# 78. No silent policy rewriting

Do not rewrite legacy expression trees at compile time into ad hoc checks such as:

```text
exists(role) AND role != banned
```

unless this rewriting is the canonical defined authorization semantics for all relevant operators.

Evaluator-level security absence semantics are preferred because they cover nested composition comprehensively.

---

# 79. No operator blacklist fix

Forbidden narrow fix:

```text
special-case neq
special-case not
```

F1-legacy is an absent-value provenance problem.

The solution must cover any operator/composition through which missing security data could manufacture authorization.

---

# 80. Comparison coverage

Review all expression operators supported by legacy authorization.

At minimum test any of:

```text
eq
neq
lt
lte
gt
gte
contains
in
```

where present and security-relevant.

If an operator receives security-absence, it MUST NOT create an authorization grant unless semantics explicitly and safely define an independent positive result.

---

# 81. String/container operators

If expressions support:

```text
contains
startsWith
membership
array operations
```

a missing principal/resource operand must not become a concrete value that accidentally satisfies authorization.

---

# 82. Function/call expressions

If callable semantic expression operators exist, review how security-absence propagates through them.

Unknown security data must not be erased and converted into a truthy result.

---

# 83. Short-circuit independence

Authorization result must not depend on evaluator implementation order.

Equivalent expression must behave the same under:

```text
eager evaluation
left short-circuit
right short-circuit
```

where semantic evaluation allows such strategies.

---

# 84. Error behavior

Legacy authorization evaluation errors must remain fail-closed.

pt3 must not transform errors into:

```text
anonymous
undefined
false that can later be negated to true
```

Errors must retain safe provenance through nested boolean expressions.

---

# 85. Missing and error are distinct internally

Recommended internal model continues to distinguish:

```text
UNKNOWN_SECURITY
ERROR
```

even though both ultimately prevent authorization.

This preserves diagnostic and future semantic clarity.

---

# 86. Public diagnostics

Normal absence-driven denial should remain:

```text
AUTHORIZATION_DENIED
```

not a native evaluator error.

The user does not need to know which security field was absent.

---

# 87. Secret hygiene

Do not expose:

```text
principal raw credential
missing secret field names
host authentication exception
policy internal values
```

through denial diagnostics.

---

# 88. AgentAPI

`AgentAPI.analyzeAuthorization()` must continue to surface both:

```text
legacy ActionDef.authorization
AuthorizationPolicyDef
```

as authorization-relevant where the current public contract does so.

If coverage currently omits legacy authorization, pt3 SHOULD correct that because 0.15 claims authorization completeness.

---

# 89. AgentAPI privilege review

Workflow `privilegeReviewActions` or equivalent analysis must continue to recognize ActionDefs protected through legacy authorization.

No false assumption that only `authorizationPolicy` creates a privilege boundary.

---

# 90. Coverage audit

The authorization coverage audit must classify legacy-authorized actions correctly.

A supported action using:

```text
ActionDef.authorization
```

is protected, but its protection semantics are now the corrected fail-closed semantics.

---

# 91. Conformance count

`axiom.conformance.v9` should be extended with sufficient legacy regression fixtures.

Exact fixture count is not normative.

The external report must record the actual shipped count.

---

# 92. Existing v9 fixtures

All existing alpha.2 authorization fixtures must remain green over:

```text
memory
SQLite
```

---

# 93. Prior conformance

Run relevant prior suites:

```text
base
queries
distributed
live
workflow
migration
authorization
```

where supported by the release harness.

No regression due to the canonical evaluator refactor.

---

# 94. Fast internal suite

All existing internal tests must remain green.

pt3 should add focused tests rather than weakening existing assertions.

---

# 95. Release-pack gates

Before publication:

```text
release:pack
release:verify
release:probe
consumer-test
```

or current equivalents must pass.

All coordinated packages should resolve coherently to:

```text
0.15.0-alpha.3
```

---

# 96. Published artifact validation

External testing MUST install:

```text
published 0.15.0-alpha.3
```

not workspace source.

---

# 97. Blind rerun requirement

pt3 changes authorization evaluator semantics for an existing public authorization surface.

Therefore it triggers the 0.15 full-rerun rule.

A focused F1-legacy retest alone is insufficient for semantic freeze.

---

# 98. Harness reuse

Reuse the existing alpha.2 blind harness.

Preserve:

```text
all alpha.1 F1 regression assertions
all alpha.2 F1/F2/F3 assertions
all previous forbidden counters
```

Add only the new legacy-specific regression matrix and alpha.2↔alpha.3 compatibility case.

---

# 99. No expectation rewriting

The harness MUST NOT change the expected outcome of the legacy fail-open test to ALLOW merely because alpha.2 documented legacy semantics as unchanged.

Expected for pt3 is now explicitly:

```text
missing security field => DENY
```

---

# 100. Focused preflight

Before full rerun, run a focused pt3 gate:

```text
legacy neq absent
legacy not(eq absent)
legacy both-absent eq if expressible
legacy literal(true)
legacy + new-policy conjunction
alpha.2↔alpha.3 compatibility
```

All must pass.

---

# 101. Full action rerun

Repeat the complete action authorization matrix:

```text
new policy
legacy policy
legacy ∧ new policy
idempotency
workflow action path
retry
failover
event/scheduler paths where supported
```

---

# 102. Full query rerun

Repeat the alpha.2 query suite even though pt3 targets legacy actions.

Reason:

```text
canonical authorization evaluator code may have been refactored/shared.
```

Expected unchanged.

---

# 103. Full workflow rerun

Repeat:

```text
startPolicy
instanceAccessPolicy
owner default
workflow action authorization
principal preservation
cancel/inspect/history
```

---

# 104. Full live rerun

Repeat:

```text
open
revocation
resume
cursor isolation
failover
```

to prove pt3 did not regress pt2 evaluator semantics.

---

# 105. Credential rerun

Repeat:

```text
anonymous
missing credential
malformed credential
authenticate throw
partial principal
cross-principal identity
```

Expected all safe.

---

# 106. Mixed-build rerun

Required pairs:

```text
alpha.1 ↔ alpha.3 authz graph => incompatible
alpha.2 ↔ alpha.3 legacy-auth graph => incompatible
alpha.3 ↔ alpha.3 same graph => compatible
presentation-only graph change => compatible
```

where compatible by existing rules.

---

# 107. Real-process rerun

Repeat representative:

```text
cross-principal race
1/2/8 topology
workflow SIGKILL
live failover
SIGSTOP stale authority
contention soak
rolling deployment
```

Use the same order of magnitude as the successful prior campaigns.

---

# 108. Forbidden counters

All existing forbidden counters remain required at zero.

Add:

```text
legacy_policy_fail_open
legacy_anonymous_action_execution
legacy_missing_attribute_allow
mixed_legacy_evaluator_compatible
```

Required:

```text
0
```

---

# 109. Original F1 remains zero

The pt2 counters must stay zero:

```text
policy_fail_open
unauthorized_action_execution
unauthorized_state_mutation
unauthorized_record_observation
unauthorized_query_execution
unauthorized_workflow_start
unauthorized_workflow_inspection
unauthorized_workflow_cancellation
malformed_credential_fallback
```

except any counters intentionally split into more precise categories.

---

# 110. F3 native exception counter

Must remain:

```text
policy_native_exception = 0
```

for authentication-boundary tests.

---

# 111. Evaluation-portability test

A second runtime must be able to reproduce legacy authorization behavior from:

```text
serialized expression
canonical principal/security scope
defined authorization-expression rules
```

No hidden TypeScript-specific undefined behavior.

---

# 112. Independent oracle

The external harness should calculate expected legacy deny-list decisions independently.

For example:

```text
expectedAllow =
  principal.role is present
  AND principal.role != "banned"
```

Do not use Axiom's evaluator as the oracle.

---

# 113. Discoverability

Shipped docs must let an external user answer:

```text
Does ActionDef.authorization fail closed if a referenced principal attribute is missing?
```

Required answer:

```text
yes.
```

This becomes part of D1.

---

# 114. E1

pt3 must not introduce:

```text
raw JS authorization callback
provider-specific auth logic
host-language special handler
```

Legacy and new authorization remain semantic/portable.

---

# 115. S1 target

S1 requires:

```text
new-policy absent fail-open = closed
legacy absent fail-open = closed
F2 = closed
F3 = closed
all forbidden counters = 0
mixed evaluator builds fail closed
no new authorization bypass
```

---

# 116. Finding severity

For external reporting, classify F1-legacy based on observed capability.

If an anonymous caller can successfully invoke a mutating ActionDef protected by a deny-list authorization expression:

```text
HIGH
RELEASE BLOCKING
```

is appropriate.

If only a non-mutating/non-security-relevant legacy surface were affected, a lower severity could be argued, but freeze remains blocked while supported authorization semantics fail open.

---

# 117. Release blocker RB1

Any missing `PRINCIPAL` field can still cause:

```text
ActionDef.authorization
```

to allow through:

```text
neq
not
comparison
boolean composition
```

=> RELEASE BLOCKER.

---

# 118. Release blocker RB2

The fix exists only for one action execution path while another still evaluates legacy authorization through generic expression semantics.

=> RELEASE BLOCKER.

---

# 119. Release blocker RB3

New and legacy authorization use separate absent-value semantics that can demonstrably diverge on equivalent expressions.

=> RELEASE BLOCKER.

---

# 120. Release blocker RB4

Explicit constant/public legacy authorization is broken by overcorrection.

=> RELEASE BLOCKER.

---

# 121. Release blocker RB5

`0.15.0-alpha.2` and `0.15.0-alpha.3` are considered compatible for a graph whose legacy authorization meaning differs between them.

=> RELEASE BLOCKER.

---

# 122. Release blocker RB6

Any pt2 fixed behavior regresses:

```text
new policy F1
F2
F3
query row isolation
workflow auth
live revocation
cursor isolation
idempotency isolation
mixed-build fail-closed
```

=> RELEASE BLOCKER.

---

# 123. Implementation completion gate

Before alpha.3 publish:

```text
[ ] canonical absence-aware evaluator reused for legacy authorization
[ ] ordinary Expression semantics unchanged
[ ] legacy neq absent denies
[ ] legacy not(eq absent) denies
[ ] legacy both-absent comparison denies where expressible
[ ] constant true control preserved
[ ] positive role policy preserved
[ ] combined legacy + new policy conjunction preserved
[ ] direct action path corrected
[ ] workflow action path corrected
[ ] scheduler/event path corrected where applicable
[ ] retry/failover corrected
[ ] idempotency isolation preserved
[ ] F1 pt2 cases remain green
[ ] F2 remains closed
[ ] F3 remains closed
[ ] authz runtime discriminator advanced appropriately
[ ] alpha.2↔alpha.3 affected graph incompatible
[ ] alpha.3↔alpha.3 compatible
[ ] v9 conformance extended
[ ] memory/SQLite parity
[ ] prior conformance green
[ ] real-process tests green
[ ] release package gates green
```

---

# 124. Publication gate

Once all internal gates are green:

```text
publish 0.15.0-alpha.3
```

The milestone is still:

```text
NOT FROZEN
```

until external validation completes.

---

# 125. External corrective sequence

```text
implement spec15pt3
        ↓
internal legacy F1 regression
        ↓
full internal suite
        ↓
compatibility + real-process gates
        ↓
publish 0.15.0-alpha.3
        ↓
fresh blind consumer
        ↓
focused F1-legacy preflight
        ↓
full authorization campaign
```

---

# 126. Expected external result

Required successful result:

```text
Original F1       CLOSED
F2                CLOSED
F3                CLOSED
F1-legacy         CLOSED

D1
E1
S1
```

---

# 127. Freeze rule

Axiom 0.15 may freeze only after:

```text
0.15.0-alpha.3
```

or a later corrective candidate receives:

```text
D1 / E1 / S1
```

from blind external validation.

No known fail-open authorization surface may remain.

---

# 128. Final 0.15 authorization invariant

After pt3:

```text
Every supported Axiom authorization mechanism interprets missing
security-scope data in the safe direction.

No authorization grant can be manufactured merely because a referenced
PRINCIPAL or RESOURCE attribute is absent.

This invariant holds for both the modern AuthorizationPolicyDef model
and the retained legacy ActionDef.authorization model.
```

---

# 129. Final runtime invariant

For any:

```text
graph G
principal P
semantic operation O
authorization expression A
```

if A requires a security attribute not present in its authorization context:

```text
absence may contribute to DENY
absence may be ignored when another independent concrete branch conclusively ALLOWs
absence may never itself create ALLOW
```

This must be invariant across:

```text
direct execution
workflow
retry
scheduler
event
failover
process
topology
persistence implementation
```

---

# 130. Milestone gate

Until external validation returns:

```text
D1 / E1 / S1
```

status remains:

```text
Axiom 0.15 — Authorization Completeness

IMPLEMENTED WITH CORRECTIVE WORK
NOT EXTERNALLY VALIDATED
SEMANTIC MODEL NOT FROZEN
```

After successful alpha.3 validation:

```text
Axiom 0.15 — Authorization Completeness

EXTERNALLY VALIDATED
D1 / E1 / S1
SEMANTIC MODEL FROZEN
```

Then proceed to:

```text
Axiom 0.16 — Tooling / Explainability / AI Authoring
```