# Axiom 0.11.1 Specification

## Schema Evolution Hardening — External Consumer Findings

Status: hardening / corrective release
Target: `@cynodia/axiom 0.11.1-alpha.1`
Baseline: `0.11.0-alpha.1`
Primary evidence: `AXIOM_0_11_BLIND_EXTERNAL_TEST.md`

---

# 1. PURPOSE

Axiom 0.11.0 introduced semantic schema evolution and migrations.

A blind external-consumer test against the real published `0.11.0-alpha.1` validated the core model:

```
Discoverability: D1
Semantic escape: E1
Safety: S2
```

The test successfully verified:

```
semantic schema diff
MigrationDef authoring
pure Expression transforms
destructive-change approval
memory / SQLite parity
keyset batching
bounded migration memory
durable checkpoint/resume
cross-process recovery
migration lease locking
concurrent-authority exclusion
serving refusal during migration
transform purity
startup mismatch detection when correctly configured
portable conformance fixtures
```

No defect was found in the fundamental semantic migration model.

Three concrete defects were found:

```
D-1  MigrationPrincipal is structurally forgeable
D-2  startup schema gate can fail open
D-3  AgentAPI.migrationImpact().covered is wrong for multi-step chains
```

Several consumer-documentation inconsistencies were also found.

0.11.1 MUST correct these findings without redesigning the 0.11 migration architecture.

---

# 2. RELEASE PHILOSOPHY

This is a hardening release.

Do NOT use 0.11.1 to add:

```
new MigrationOperation kinds
online migrations
zero-downtime migration
cross-provider migration coordination
persisted-StateDef migration vocabulary
blob-metadata migration vocabulary
new query semantics
new UI semantics
new workflow semantics
```

The objective is:

```
make the promises already made by 0.11 true under adversarial external use.
```

---

# 3. REQUIRED RELEASE RESULT

Target external classifications after 0.11.1:

```
Discoverability: D1
Semantic escape: E1
Safety: S1
```

Required:

```
S4 defects: 0
S3 defects: 0
```

The original blind-test workflow must continue to pass.

---

# 4. DEFECT D-2 — STARTUP GATE MUST FAIL CLOSED

Highest priority.

0.11.0 currently allows:

```
persisted metadata: schemaVersion = 4
application graph: no declared semantic schema version
```

to produce effectively:

```
status: compatible
gate disabled
authority serves traffic
```

This violates the 0.11 invariant:

```
an application must not hopefully start against persisted data whose
semantic schema compatibility has not been established.
```

Correct this.

---

# 5. DISTINGUISH COMPATIBLE FROM UNCHECKED

`compatible` MUST mean:

```
compatibility was actually established.
```

It MUST NOT mean:

```
schema checking was disabled
schema identity was absent
migration metadata was unavailable
compatibility could not be determined
```

Never return a machine-readable `compatible` verdict for an unchecked schema relationship.

---

# 6. DECLARED SCHEMA + PERSISTED METADATA

When both exist:

```
graph.schemaVersion
persisted MigrationMetadata.schemaVersion
```

normal comparison semantics apply.

Required:

```
graph == persisted + matching fingerprint
    → compatible

graph > persisted + complete migration path
    → migration-required

graph < persisted
    → incompatible

same version + wrong fingerprint
    → corrupted / fingerprint mismatch
```

Preserve existing correct behaviour.

---

# 7. UNVERSIONED GRAPH + VERSIONED PERSISTENCE

Required hostile case:

```
graph has no explicit semantic schema version
persisted metadata says schemaVersion = 4
```

The authority MUST refuse normal startup.

It MUST NOT return:

```
compatible
```

Suggested diagnostic:

```
SCHEMA_IDENTITY_REQUIRED
```

or another precise existing-convention name.

Message should explain:

```
persisted data declares semantic schema version 4,
but the application does not declare a semantic schema version;
compatibility cannot be established.
```

Do not silently interpret the unversioned graph as safely compatible with v1.

---

# 8. VERSIONED GRAPH + NO MIGRATION METADATA STORE

This case requires explicit semantics.

Current behaviour silently disables the gate when `migrationMetadata` is omitted.

That is unsafe for an application declaring persistent semantic schema.

Preferred rule:

If the graph contains persistence-relevant schema and declares semantic schema evolution requiring migration protection, authority startup MUST NOT silently assume compatibility merely because no metadata store was supplied.

Research the least-breaking fail-closed rule.

At minimum:

```
schemaGate().status MUST NOT be "compatible"
```

when the gate was not actually performed.

Possible result:

```
schema-unchecked
schema-gate-unavailable
schema-metadata-required
```

If normal serving is permitted for legitimate ephemeral/fresh deployments, that must be represented explicitly rather than conflated with compatibility.

---

# 9. FRESH PERSISTENCE

Do not break legitimate first startup.

A genuinely fresh persistence domain must remain distinguishable from:

```
existing persistence whose schema cannot be checked.
```

Required conceptual distinction:

```
fresh
    !=
compatible
    !=
unchecked
```

A new database/provider with no application data may initialize itself to the graph's declared semantic schema through the documented fresh-start path.

Do not require a migration from imaginary historical data.

---

# 10. EPHEMERAL / NON-PERSISTENT USE

Preserve Axiom's ability to run graphs that do not use long-lived persisted canonical data.

Do not force migration infrastructure onto applications for which schema evolution has no persisted object to protect.

The implementation must derive or explicitly know when the startup gate is semantically required.

Do not solve D-2 by making every trivial in-memory Axiom program configure migration metadata.

---

# 11. GATE STATUS MODEL

Review `SchemaGateStatus`.

Every status must have one unambiguous machine meaning.

At minimum distinguish:

```
compatible
fresh
migration-required
migration-in-progress
incompatible
corrupted
```

and, if applicable:

```
unchecked / unavailable / identity-required
```

Do not overload `compatible`.

Document every status normatively.

---

# 12. REQUEST-TIME RECHECK

Preserve the existing 0.11 behaviour where an authority that started compatible refuses requests if a migration subsequently begins.

Both:

```
snapshot
invoke
```

and any equivalent normal application traffic must remain blocked while migration ownership is active.

Regression-test this.

---

# 13. OLD-APPLICATION REGRESSION TEST

Required:

```
create persistence at schema 4
attempt startup with schema-2 graph
    → refuse
```

Then:

```
create persistence at schema 4
attempt startup with graph declaring no schema version
    → refuse
```

The second case is the D-2 regression.

---

# 14. MISSING-METADATA REGRESSION TEST

Construct a graph whose persisted semantic schema requires compatibility protection.

Omit the metadata store.

Verify that the authority does not report checked compatibility.

If startup is refused:

```
verify structured diagnostic.
```

If a legitimate fresh/ephemeral path remains:

```
prove that it cannot accidentally classify existing unknown persistence as compatible.
```

Document the exact invariant.

---

# 15. DEFECT D-1 — MIGRATION AUTHORITY MUST BE OPAQUE

0.11.0 documents migration authority as host-minted but accepts:

```
{
    kind: 'axiom.migration-authority',
    grantedBy: 'anyone'
}
```

because authority is checked structurally.

This contradicts the capability contract.

Correct it.

---

# 16. AUTHORITY INVARIANT

Only authority produced by the supported host-side authority minting mechanism may authorize:

```
executeMigration(...)
```

Application code must not be able to obtain migration authority merely by constructing an object with known public fields.

Required:

```
migrationAuthority('operator')
    → accepted

{
    kind: 'axiom.migration-authority',
    grantedBy: 'operator'
}
    → rejected
```

---

# 17. IMPLEMENTATION APPROACH

Choose an implementation appropriate for TypeScript/JavaScript while preserving the public semantic contract.

Candidates include:

```
process-private WeakSet registration
private Symbol branding
private class identity
closure-held nonce/capability identity
```

Do NOT rely on:

```
TypeScript nominal typing only
a public string brand
a public Symbol exported to consumers
duck typing
```

Runtime authorization must establish provenance, not shape.

---

# 18. SERIALIZATION

Migration authority is a host capability.

It SHOULD NOT become serializable authority.

Do not add migration principal support to:

```
ServerRequest
protocol schema
Server IR
graph serialization
```

Preserve the existing good property:

```
migration execution is not protocol-reachable.
```

---

# 19. PROCESS BOUNDARY

A migration authority minted in process A does not need to be portable to process B.

Prefer process-local capability semantics.

Migration durability belongs to:

```
MigrationMetadataStore
migration ownership/lease
checkpoints
```

not to serializing the authority token.

---

# 20. HOSTILE AUTHORITY TESTS

Required:

```
executeMigration(principal: undefined)
    → MIGRATION_NOT_AUTHORIZED

executeMigration(principal: 'operator')
    → MIGRATION_NOT_AUTHORIZED

executeMigration(principal: {})
    → MIGRATION_NOT_AUTHORIZED

executeMigration(principal: {
    kind: 'axiom.migration-authority',
    grantedBy: 'operator'
})
    → MIGRATION_NOT_AUTHORIZED

executeMigration(principal: {
    kind: 'axiom.migration-authority',
    grantedBy: 'attacker'
})
    → MIGRATION_NOT_AUTHORIZED

executeMigration(principal: migrationAuthority('operator'))
    → authorized
```

Also test copied/spread capability objects:

```
{ ...migrationAuthority('operator') }
```

must be rejected if the implementation claims opacity.

---

# 21. NO CLIENT MIGRATION VERB

Regression-test that guessed request kinds such as:

```
migrate
migration
execute-migration
```

remain rejected as malformed/unknown protocol requests.

Do not add migration execution to the ordinary application protocol.

---

# 22. DEFECT D-3 — AGENTAPI MIGRATION COVERAGE

0.11.0 produces a false negative for:

```
previous graph B
next graph C
```

when C contains historical migrations:

```
1 → 2
2 → 3
```

`migrationImpact(B, C)` currently tests the B→C diff against operations from the entire migration chain.

This can yield:

```
covered: false
uncovered: []
```

even though:

```
validateGraph(C) == valid
migrationCoversDiff(diffSchema(B,C), m_2_3.operations).covered == true
planMigration(...) succeeds
executeMigration(...) succeeds
```

Correct this.

---

# 23. STEP-SCOPED COVERAGE

For:

```
diffSchema(previous, next)
```

where:

```
previous.schemaVersion = N
next.schemaVersion = N+1
```

`migrationImpact(previous, next)` MUST evaluate coverage using the migration operations relevant to:

```
N → N+1
```

Historical migrations must not count as unmatched operations for this diff.

---

# 24. MULTI-STEP DIFF

Define behaviour for:

```
previous.schemaVersion = N
next.schemaVersion = N+K
```

where K > 1.

Choose explicitly between:

A.

```
evaluate each migration step against its corresponding historical schema diff
```

or:

B.

```
report chain-level impact without pretending a single aggregate diff has ordinary step coverage
```

Do not accidentally feed every operation in the chain into one endpoint diff.

Document the chosen contract.

---

# 25. COVERAGE RESULT INVARIANT

A result such as:

```
covered: false
uncovered: []
```

is not necessarily logically impossible if there are unmatched/extra operations, but it MUST explain why `covered` is false.

Expose sufficient structured information such as:

```
uncovered
unmatched
ambiguous
stepFailures
```

An agent must not receive an unexplained boolean refusal.

---

# 26. AUTHORITATIVE COVERAGE SEMANTICS

Align:

```
migrationCoversDiff
validateGraph migration coverage
AgentAPI.migrationImpact
```

They need not have identical return shapes.

They MUST agree on whether a valid migration step covers its semantic diff.

Required regression:

```
validateGraph(C).valid === true

migrationCoversDiff(diffSchema(B,C), step2to3.operations).covered === true

migrationImpact(B,C).covered === true
```

---

# 27. AGENTAPI TEST MATRIX

At minimum:

```
A → B
B → C
C → D
A → D
metadata-only diff
uncovered required field
destructive covered change
ambiguous replacement
extra unrelated migration history
```

Verify both:

```
boolean verdict
explanation payload
```

---

# 28. AGENTAPI IS A CONTRACT

Treat D-3 as more than cosmetic.

Axiom targets AI-authored software.

AgentAPI is intended to be a machine-facing semantic authority.

It must not disagree with runtime/compiler validation on basic migration correctness.

Do not "fix" this only in documentation.

---

# 29. DOCUMENTATION — SEEDING

The blind consumer needed `.d.ts` exploration to discover:

```
createSqliteRowStore({ seed })
```

because `MigrationRowStore` itself has no insert operation.

Add a concise section to:

```
docs/MIGRATIONS.md
```

explaining that migration infrastructure normally receives pre-existing persistence from the host/harness, but tests/bootstrap scenarios may seed reference stores through their documented provider constructors.

Document:

```
createSqliteRowStore({ ..., seed })
createMemoryRowStore(...)
```

as applicable to the actual public APIs.

Do not imply that seeding is a migration operation.

---

# 30. DOCUMENTATION — SERVER IR VERSION WORDING

Audit all shipped consumer-facing docs for wording around:

```
axiom.server.v1
axiom.server.v7
```

Preserve the important distinction:

```
v1 is frozen
    !=
v1 is current
```

0.11 migration vocabulary may require v7.

A cold consumer must not have to reconcile contradictory README claims.

---

# 31. DOCUMENTATION — STALE SERVER README

Update the shipped `@cynodia/axiom-server` README if it still describes the package as of 0.8 or lists only historical schema versions through v4.

It must accurately describe the current 0.11.1 public package.

Do not turn it into a duplicate manual.

Point to canonical docs where appropriate.

---

# 32. DOCUMENTATION — DANGLING REPORT LINKS

`docs/MIGRATIONS.md` currently links research/implementation reports that are not shipped in the npm tarball.

Choose one:

```
ship the referenced files
```

or preferably, if they are maintainer artifacts:

```
remove consumer-facing links to them.
```

Every path referenced from shipped consumer docs must exist in the packed artifact unless explicitly identified as repository-only.

Add a packed-artifact path regression test.

---

# 33. DOCUMENTATION — CLI WORDING

Reconcile statements around the migration CLI.

The blind consumer encountered both:

```
"private CLI"
```

and:

```
"There is no published Axiom CLI."
```

Consumer docs must state one precise reality.

Do not direct npm consumers toward an unavailable command.

---

# 34. DOCUMENTATION — STARTUP GATE

Update `MIGRATIONS.md` and `AGENT_REFERENCE.md` to state the hardened startup invariant.

A cold agent should understand:

```
what must be configured
when schema metadata is mandatory
what fresh means
what compatible means
what happens when schema identity is absent
what happens when migration metadata is unavailable
```

Do not hide fail-closed behaviour in API declarations only.

---

# 35. DOCUMENTATION — MIGRATION AUTHORITY

Correct wording to match the actual hardened capability.

Document that:

```
migrationAuthority(...)
```

returns an opaque process-local host capability.

Explicitly state that copying its visible fields does not recreate authority.

If visible diagnostic metadata such as `grantedBy` remains, clarify that it is descriptive, not the source of authorization.

---

# 36. RELATIONSHIP "REQUIRED" INCONSISTENCY

The blind test found that migration/schema identity machinery reasons about:

```
RelationshipShape.required
```

while public `RelationshipDef` apparently exposes no corresponding authoring concept.

Investigate this inconsistency.

Determine whether:

A.

```
`required` is derived from another semantic property,
```

B.

```
it is stale/internal vocabulary that should be removed,
```

or

C.

```
a public authoring capability is accidentally missing.
```

Do not add a new feature casually in a patch release.

Preferred 0.11.1 outcome:

```
make the existing contract internally consistent and document the derivation.
```

If fixing it requires a breaking semantic extension, document and defer it rather than expanding patch scope.

---

# 37. NO MIGRATION SEMANTIC CHANGES

Existing valid 0.11.0 MigrationDefs must remain valid unless they relied on one of the explicitly unsafe behaviours corrected by this specification.

Do not change:

```
operation meanings
transformation evaluation
destructive classification
checkpoint semantics
provider parity
batching semantics
schema fingerprint projection
```

except where necessary to correct a demonstrated defect.

---

# 38. FINGERPRINT STABILITY

Run regression fixtures proving that the 0.11.1 hardening work does not alter schema fingerprints for identical 0.11 schemas.

A patch release must not make existing correctly-versioned persistence appear corrupted merely because the framework package changed.

Required:

```
fingerprint_0_11_0(graph X)
    ==
fingerprint_0_11_1(graph X)
```

for representative schemas.

---

# 39. SERVER IR STABILITY

Do not introduce a new Server IR contract merely for these fixes unless vocabulary actually changes.

Expected:

```
migration graphs remain axiom.server.v7
```

Frozen:

```
v1–v6 byte-identical
```

Existing v7 semantic structure should remain compatible.

---

# 40. CONFORMANCE VERSION

Do not bump portable migration fixture contract merely because implementation bugs were fixed.

Existing:

```
axiom.conformance.v5
```

should remain valid unless the normative portable semantic contract actually changes.

Add regression fixtures/tests around the defects where appropriate without gratuitous format versioning.

---

# 41. MEMORY / SQLITE PARITY

Re-run all existing migration conformance fixtures through:

```
memory
SQLite
```

Expected:

```
identical semantic target data
identical semantic diagnostics where provider-independent
```

No regression.

---

# 42. CRASH / RESUME REGRESSION

Preserve the externally verified behaviour:

```
crash after checkpoint
schema version remains old
restart
same executeMigration call
resume remaining rows only
final data == uninterrupted run
rerun == alreadyAtTarget
```

Test memory and cross-process SQLite.

---

# 43. CONCURRENCY REGRESSION

Preserve:

```
one migration lease owner
competing authority gets MIGRATION_IN_PROGRESS
one history entry
every row transformed once
```

Run a real shared-SQLite cross-process test.

---

# 44. DESTRUCTIVE APPROVAL REGRESSION

Required:

```
populated field
destructive removal
no approval
    → MIGRATION_APPROVAL_REQUIRED
    → zero destructive writes
    → version unchanged
```

then:

```
exact operation approved
    → completes
```

Do not weaken this gate.

---

# 45. TRANSFORM PURITY REGRESSION

Preserve rejection of:

```
now
uuid
foreign-scope reads
```

with:

```
MIGRATION_TRANSFORM_IMPURE
```

both where statically validated and where runtime defense-in-depth applies.

---

# 46. LARGE-DATA REGRESSION

Re-run bounded migration test.

At minimum:

```
20,000 rows
fixed batch size
readBatch never exceeds batch size
boundedMemory == true
```

Prefer retaining the larger internal 500k / 2M reference benchmark as well.

---

# 47. BLIND TEST HARNESS AS REGRESSION ASSET

The external consumer produced a reproducible `harness/` with:

```
23/23 consolidated correctness assertions
```

Import or recreate the important probes as repository regression tests where licensing/repository boundaries permit.

At minimum encode D-1, D-2 and D-3 as permanent tests.

Do not rely solely on manually rerunning the external report.

---

# 48. REQUIRED D-1 REGRESSION

Permanent test:

```
const real = migrationAuthority('operator')

real
    → accepted

{ ...real }
    → rejected

{
  kind: 'axiom.migration-authority',
  grantedBy: 'operator'
}
    → rejected
```

This test must fail if migration authority ever regresses to structural duck typing.

---

# 49. REQUIRED D-2 REGRESSION

Permanent test:

```
persisted schema = 4
graph schema = absent
```

Expected:

```
authority does not start normally
gate does not report compatible
structured diagnostic explains missing schema identity
```

Also test:

```
persisted schema = 4
graph schema = 2
    → incompatible

persisted schema = 2
graph schema = 4
    → migration-required
```

---

# 50. REQUIRED D-3 REGRESSION

Permanent test:

```
B schemaVersion = 2
C schemaVersion = 3

C contains:
    migration 1→2
    migration 2→3
```

Expected:

```
diff = diffSchema(B,C)

migrationCoversDiff(
    diff,
    migration_2_3.operations
).covered === true

migrationImpact(B,C).covered === true
```

No historical operation from migration 1→2 may create a false negative.

---

# 51. EXTERNAL-CONSUMER RE-RUN

After implementation, rerun the blind external test against the **packed/published 0.11.1 artifact**, not the monorepo.

The rerun may focus on regression rather than repeating every exploratory step, but MUST include:

```
D-1
D-2
D-3
```

plus:

```
A→B
B→C
C→D destructive refusal
crash/resume
concurrent migration
serving refusal
documentation discovery
```

---

# 52. REQUIRED EXTERNAL RESULTS

Expected:

```
Discoverability: D1
Semantic escape: E1
Safety: S1
```

Specifically:

```
forged MigrationPrincipal
    → rejected

unversioned graph + versioned persistence
    → startup refused

migrationImpact(B,C)
    → covered:true

destructive operation without approval
    → zero writes

implementation source read
    → no

handwritten SQL
    → 0

migration callbacks
    → 0
```

---

# 53. RELEASE PREPARATION

Target package version:

```
0.11.1-alpha.1
```

Update all package versions consistently according to the existing release process.

Do not publish unless explicitly instructed.

---

# 54. FULL RELEASE VERIFICATION

Before handoff run:

```
clean
build
full npm test
migration conformance
memory/SQLite parity
browser tests
crash/recovery
concurrency
hostile migration authority tests
schema-gate tests
AgentAPI migration-impact tests
large-data boundedness
npm pack
tarball verification
consumer-doc path verification
discoverability probe
external-consumer smoke test
```

Then run the repository's normal:

```
npm run release:prepare
```

or current equivalent.

---

# 55. PACKED ARTIFACT VERIFICATION

Inspect the actual tarballs.

Verify that every consumer-facing path referenced by:

```
README.md
AGENTS.md
llms.txt
docs/AGENT_REFERENCE.md
docs/MIGRATIONS.md
```

exists in the packed package or is explicitly described as repository-only.

No dangling consumer links.

---

# 56. IMPLEMENTATION REPORT

Produce:

```
reports/AXIOM_0_11_1_IMPLEMENTATION_REPORT.md
```

Answer at minimum:

1. How was D-1 reproduced?
2. What made MigrationPrincipal forgeable?
3. What runtime mechanism now establishes genuine authority?
4. Is a spread/copied authority object rejected?
5. Is migration execution still absent from the client protocol?
6. How was D-2 reproduced?
7. What does `compatible` mean after 0.11.1?
8. What happens for an unversioned graph against versioned persistence?
9. What happens when migration metadata is absent?
10. How is fresh persistence distinguished from unchecked persistence?
11. Are ephemeral/non-persistent applications affected?
12. What new/changed schema-gate diagnostics exist?
13. How was D-3 reproduced?
14. How does `migrationImpact` select relevant migration operations now?
15. What is its defined behaviour for multi-step diffs?
16. Can `covered:false` still occur with no structured reason?
17. Do `migrationCoversDiff`, `validateGraph`, and `migrationImpact` agree on B→C?
18. Was `RelationshipDef.required` inconsistency resolved, explained, or deferred?
19. Was SQLite seeding documented?
20. Were stale Server IR version statements corrected?
21. Were dangling report links removed or shipped?
22. Was CLI wording reconciled?
23. Did schema fingerprints remain stable?
24. Did Server IR remain v7?
25. Did conformance remain v5?
26. How many tests pass?
27. Did all memory/SQLite fixtures remain equivalent?
28. Did crash/resume regress?
29. Did concurrency regress?
30. Did destructive approval regress?
31. Did large-data boundedness regress?
32. What did the external 0.11.1 consumer rerun classify as D/E/S?
33. Did that agent inspect implementation source?
34. Did it use SQL/ORM/callback escape?
35. What are the remaining known 0.11 limitations?

---

# 57. RELEASE CLASSIFICATION

Choose exactly one:

A — HARDENED

```
D-1, D-2 and D-3 are corrected.
Existing 0.11 semantics remain intact.
External regression achieves D1 + E1 + S1.
```

B — HARDENED WITH MINOR LIMITATIONS

```
The three primary defects are corrected, but non-critical consumer
documentation/API friction remains.
```

C — SAFETY GAP REMAINS

```
At least one of D-1 or D-2 remains materially unresolved, or AgentAPI
still contradicts authoritative migration coverage.
```

D — REGRESSION

```
The patch damages core migration semantics, portability, crash recovery,
destructive safety or consumer discoverability.
```

Target:

```
A
```

---

# 58. ZERO-REGRESSION METRICS

Required:

```
handwritten migration SQL ............ 0
ORM migration calls .................. 0
application migration callbacks ...... 0
NativeOperation migration logic ...... 0
unbounded migration transforms ....... 0

structurally forged authority accepted 0
hopeful unversioned startup .......... 0
unexplained coverage false negatives . 0

S4 defects ............................ 0
S3 defects ............................ 0
```

---

# 59. DO NOT OVERFIT THE TEST

Fix the underlying contracts, not merely the exact examples in the blind report.

Examples:

Do not special-case:

```
schemaVersion === 4
grantedBy === 'attacker'
B → C
migration m_1_2
```

The invariants are:

```
unchecked persistence is not compatible

migration authority has provenance, not merely shape

migration coverage is scoped to the semantic transition being evaluated
```

Implement those general rules.

---

# 60. FINAL PRINCIPLE

0.11 established:

```
Axiom understands how persisted application meaning evolves.
```

0.11.1 must establish:

```
Axiom refuses to claim that evolution is safe when it has not actually
established that fact.
```

Therefore:

```
"compatible" must mean proven compatible.

"authorized" must mean genuinely host-authorized.

"covered" must mean the relevant semantic transition is actually covered.
```

These are not presentation details.

They are machine-readable claims on which hosts and AI agents are expected to act.

0.11.1 is complete when those claims can be trusted.
