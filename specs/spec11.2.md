# Axiom 0.11.2 Specification

## SQLite Migration Contention Hardening

Status: corrective hardening release
Target: `@cynodia/axiom 0.11.2-alpha.1`
Baseline: `0.11.1-alpha.1`

Primary evidence:

```
AXIOM_0_11_1_BLIND_EXTERNAL_REGRESSION.md
```

---

# 1. PURPOSE

Axiom 0.11.1 successfully corrected the three defects found in the original 0.11.0 blind external test:

```
D-1  migration authority provenance
D-2  fail-open startup schema gate
D-3  AgentAPI migration coverage
```

The external regression against the real published `0.11.1-alpha.1` confirmed:

```
Discoverability: D1
Semantic escape: E1
Safety: S2
```

The only remaining safety-class limitation found was:

```
D-4 — genuine cross-process concurrent migration on SQLite can leak
      SQLITE_BUSY / ERR_SQLITE_ERROR or generic MIGRATION_FAILED
      instead of resolving to the documented Axiom concurrency outcome.
```

Data integrity remained correct:

```
no duplicate transformation observed
one migration history entry
schema version did not falsely advance
subsequent execution recovered to the exact target state
```

Therefore D-4 is a provider contention-contract defect, not a semantic migration-model defect.

0.11.2 MUST correct D-4 without changing Axiom migration semantics.

---

# 2. RELEASE PHILOSOPHY

This is a narrow hardening release.

Do NOT add:

```
new MigrationOperation kinds
new migration semantics
online migration
zero-downtime migration
distributed migration
new Server IR vocabulary
new schema-fingerprint semantics
new conformance format
new application features
```

The only primary objective is:

```
make SQLite's physical lock contention obey Axiom's existing
semantic migration-concurrency contract.
```

---

# 3. REQUIRED RESULT

Target external classification:

```
Discoverability: D1
Semantic escape: E1
Safety: S1
```

Required:

```
raw SQLITE_BUSY exposed during ordinary migration contention .... 0
ERR_SQLITE_ERROR caused solely by migration contention .......... 0
generic MIGRATION_FAILED for known migration-owner contention ... 0
duplicate semantic migration execution ......................... 0
duplicate transformed rows ..................................... 0
S3 defects ...................................................... 0
S4 defects ...................................................... 0
```

---

# 4. D-4 — EXACT DEFECT

Reproduce with:

```
SQLite migration metadata store
SQLite migration row store
same database file
two independent OS processes
same required migration
executeMigration started concurrently
```

Observed 0.11.1 outcomes include:

```
winner:
    completed

loser:
    Error: database is locked
    code: ERR_SQLITE_ERROR
    errcode: 5
```

or:

```
    MIGRATION_FAILED
```

instead of the documented semantic outcome:

```
    MIGRATION_IN_PROGRESS
```

The error has been observed during metadata operations including:

```
readCheckpoint
```

not only during explicit migration-lock acquisition.

---

# 5. CORE INVARIANT

A physical provider lock is not itself an application semantic result.

When SQLite contention is caused by another Axiom migration instance owning or establishing migration ownership, the consumer-visible outcome MUST be expressed in Axiom terms.

Required semantic outcome:

```
MIGRATION_IN_PROGRESS
```

Physical exceptions such as:

```
SQLITE_BUSY
SQLITE_LOCKED
ERR_SQLITE_ERROR
```

must not leak through merely because two valid Axiom migration runners race.

---

# 6. DO NOT BLINDLY MAP EVERY SQLITE_BUSY

Do NOT implement:

```
catch SQLITE_BUSY
return MIGRATION_IN_PROGRESS
```

globally.

SQLite may be busy for reasons unrelated to an Axiom migration owner.

The provider MUST distinguish, as far as reasonably possible:

```
known Axiom migration contention
```

from:

```
unexpected database contention / provider failure
```

Known migration contention:

```
another valid migration lease exists
or contention occurs while another migration runner is establishing/holding ownership
```

→

```
MIGRATION_IN_PROGRESS
```

Unexpected unresolved contention:

→

```
MIGRATION_FAILED
```

with a provider-safe cause/details retained for diagnostics.

---

# 7. BOUNDED SQLITE BUSY HANDLING

Implement bounded provider-controlled busy handling.

Candidate mechanisms:

```
PRAGMA busy_timeout
sqlite busy timeout API if exposed by node:sqlite
bounded retry around migration metadata operations
combination of short timeout + semantic lock re-check
```

Do NOT use an unbounded wait.

Do NOT choose a timeout long enough that the second migrator waits for an entire large migration to complete merely to discover ownership.

The purpose of the wait is:

```
tolerate short SQLite lock hand-offs
allow Axiom metadata to become readable
then determine semantic ownership
```

not:

```
serialize full migrations through SQLite's physical writer lock.
```

---

# 8. PREFERRED CONTENTION FLOW

Preferred conceptual flow:

```
SQLite operation hits SQLITE_BUSY / SQLITE_LOCKED
    ↓
bounded retry / short busy wait
    ↓
retry migration metadata observation
    ↓
valid migration owner / lease visible
    ↓
MIGRATION_IN_PROGRESS
```

If the winner already completed before the loser rechecks:

```
persisted schema == target
    ↓
alreadyAtTarget
```

This is also a valid concurrency outcome.

If contention persists and no semantic migration owner/state explains it:

```
MIGRATION_FAILED
provider contention cause retained
```

---

# 9. VALID CONCURRENT OUTCOMES

For two processes A and B starting the same migration concurrently, valid result combinations include:

```
A = completed
B = MIGRATION_IN_PROGRESS
```

or:

```
B = completed
A = MIGRATION_IN_PROGRESS
```

or, if one process completes before the other reaches ownership evaluation:

```
A = completed
B = alreadyAtTarget
```

or reverse.

Invalid solely-contention outcomes:

```
raw SQLITE_BUSY
raw SQLITE_LOCKED
uncaught ERR_SQLITE_ERROR
generic MIGRATION_FAILED where another Axiom migration owner explains contention
```

---

# 10. MIGRATION LOCK ACQUISITION

Audit SQLite `MigrationMetadataStore.acquireLock`.

It must behave correctly under genuine process contention.

Two concurrent callers must not both believe they acquired the migration lease.

Required:

```
at most one active valid migration owner
```

The loser must resolve semantically as:

```
lock not acquired
→ MIGRATION_IN_PROGRESS
```

not as a leaked SQLite physical locking error.

---

# 11. CHECKPOINT READ CONTENTION

D-4 was observed at:

```
readCheckpoint
```

Therefore contention hardening MUST cover metadata reads, not just writes.

Audit at minimum:

```
readSchema
writeSchema
readHistory / appendHistory
readLock
acquireLock
renewLock
releaseLock
readCheckpoint
writeCheckpoint
clearCheckpoint
```

Any SQLite operation involved in migration-state observation can race with another process.

---

# 12. STATUS READS

`getMigrationStatus()` must not unexpectedly throw raw SQLite contention errors during a normal concurrent migration.

If another migration is active:

```
getMigrationStatus()
```

should eventually return a coherent Axiom migration status after bounded contention handling.

Do not require consumers to catch SQLite-native errors merely to inspect migration state.

---

# 13. SCHEMA GATE DURING CONTENTION

Audit:

```
evaluateSchemaGate
AxiomServer.schemaGate
AxiomServer.start
request-time migration-state checks
```

when SQLite metadata is temporarily busy.

Normal migration contention should not turn into an unrelated provider crash if it can be semantically identified as:

```
migration-in-progress
```

Preserve fail-closed startup behaviour from 0.11.1.

---

# 14. ROW-STORE TRANSACTIONS

Audit SQLite row-store migration operations using:

```
BEGIN IMMEDIATE
batch SELECT
batch UPDATE
ALTER TABLE
DROP COLUMN
validation reads
```

If contention occurs before ownership is established:

```
resolve through the migration ownership semantics.
```

If the process already owns the migration lease and encounters unexpected persistent SQLite contention from an unrelated writer:

```
do not lie and report MIGRATION_IN_PROGRESS caused by itself.
```

That case may be:

```
MIGRATION_FAILED
```

with an actionable provider contention diagnostic.

---

# 15. OWNER-AWARE ERROR MAPPING

Where practical, error mapping should have enough context to answer:

```
do I own the migration lease?
does somebody else own it?
did the migration already finish?
is this unexplained contention?
```

Conceptually:

```
if target already committed:
    alreadyAtTarget

else if another valid owner exists:
    MIGRATION_IN_PROGRESS

else if current runner owns lock and SQLite remains busy:
    MIGRATION_FAILED

else:
    bounded retry / re-read metadata
    then classify
```

Do not collapse all cases to one status.

---

# 16. LEASE EXPIRY

Preserve existing crash recovery semantics.

If another process owns the lease but its lease has expired:

```
the new process may reclaim ownership
```

Do not indefinitely report:

```
MIGRATION_IN_PROGRESS
```

for an expired owner.

SQLite contention handling must eventually re-evaluate lease validity.

---

# 17. NO DOUBLE EXECUTION

Strengthen concurrency tests to prove:

```
no row transformed more than once
```

Use an intentionally non-idempotent transform such as:

```
n := n + 1
```

so a duplicate execution becomes visible.

Required final invariant:

```
every row == source + 1
```

Never:

```
source + 2
```

---

# 18. HISTORY INVARIANT

After concurrent migration attempts:

```
migration history contains exactly one completed semantic migration step
```

unless multiple distinct schema steps were genuinely required.

Two contenders for the same N → N+1 transition must not create duplicate history entries.

---

# 19. VERSION-COMMIT INVARIANT

Schema version must advance only after the migration reaches the existing validation/commit boundary.

Contention handling must not introduce any new path where:

```
schema version advances
while row migration is incomplete
```

or:

```
loser advances metadata after winner already completed.
```

---

# 20. CHECKPOINT INVARIANT

A losing process must not corrupt, clear, replace or rewind the active owner's checkpoint.

Checkpoint ownership semantics must remain coherent under concurrent processes.

If a process loses migration ownership:

```
it performs no migration data work
it does not mutate active checkpoint state
```

---

# 21. SQLITE CONFIGURATION API

Research whether consumers need a public SQLite contention option.

Preferred:

```
correct safe defaults requiring no consumer configuration.
```

Only expose an option such as:

```
busyTimeoutMs
```

if there is a real operational need.

If exposed:

```
provide a bounded safe default
document unit and semantics
do not make correctness depend on consumers setting it
do not let 0 mean silently unsafe unless explicitly documented
```

Avoid expanding public API if an internal provider default is sufficient.

---

# 22. DEFAULT BUSY WINDOW

Choose and justify a short bounded default.

The exact number is implementation research, not prescribed here.

Evaluate values against:

```
fast metadata lock hand-off
CI process scheduling jitter
normal local SQLite contention
avoiding multi-second blocking behind an entire migration
```

Record the selected value and rationale in the implementation report.

---

# 23. SQLITE_BUSY AND SQLITE_LOCKED

Handle both SQLite contention families where node:sqlite may surface them:

```
SQLITE_BUSY
SQLITE_LOCKED
```

Account for their Node error representation:

```
code
errcode
errstr
message
```

Do not depend solely on English message matching if structured error metadata exists.

---

# 24. ERROR NORMALIZATION

Introduce an internal helper if useful, e.g. conceptually:

```
isSqliteContentionError(error)
```

It should recognize only the intended SQLite lock-contention errors.

Do not swallow:

```
malformed SQL
schema corruption
disk errors
constraint errors
programmer errors
```

Those must remain real failures.

---

# 25. DIAGNOSTIC PRESERVATION

When unexpected SQLite contention becomes:

```
MIGRATION_FAILED
```

retain enough structured diagnostic context for operators to know the physical reason was SQLite locking.

Do not expose giant raw stack traces through application protocol surfaces.

Host-side errors/logging may retain the underlying cause.

---

# 26. NO NEW SEMANTIC DIAGNOSTIC REQUIRED

Prefer existing:

```
MIGRATION_IN_PROGRESS
MIGRATION_FAILED
```

Do not add a new public diagnostic such as:

```
SQLITE_BUSY
```

because SQLite is a provider implementation detail.

Only introduce a new Axiom diagnostic if research demonstrates an actual semantic state not represented today.

---

# 27. CROSS-PROCESS TEST HARNESS

Add a real process-level SQLite concurrency test.

Do not simulate this only with:

```
Promise.all
shared in-memory store
manually pre-held lock
```

Spawn independent Node processes with:

```
independent SQLite connections
same database path
same target IR
same migration
independently minted migrationAuthority capabilities
```

This is the scenario that exposed D-4.

---

# 28. REPEATED RACE TEST

Run the cross-process race repeatedly.

Minimum:

```
25 trials
```

Preferred:

```
50 trials
```

Each trial:

```
create fresh SQLite database
seed schema N + rows
start process A and B as close together as practical
collect both results
inspect final database and migration metadata
```

Do not reuse a contaminated database between trials.

---

# 29. ALLOWED RACE RESULTS

For every trial, assert each process result is one of:

```
completed
MIGRATION_IN_PROGRESS
alreadyAtTarget
```

The pair must contain exactly one semantic completion of the transition.

No trial may expose:

```
ERR_SQLITE_ERROR
SQLITE_BUSY
SQLITE_LOCKED
uncaught exception
contention-only MIGRATION_FAILED
```

---

# 30. FINAL-DATA RACE ASSERTION

Use a non-idempotent transformation over all rows.

Example:

```
Item.n := Item.n + 1
```

After both processes exit and any legitimate resume completes:

```
row count unchanged
every identity unique
every n == original n + 1
no n == original n + 2
one migration history entry
target schema version committed
checkpoint cleared
lock cleared
```

---

# 31. RECOVERY AFTER FORCED OWNER CRASH

Preserve and re-run:

```
process A acquires ownership
process A writes checkpoint
process A terminates
lease expires
process B resumes
```

Expected:

```
no raw SQLite contention
process B reclaims expired lease
resumes from checkpoint
exact uninterrupted target data
```

---

# 32. STATUS-POLL CONTENTION TEST

While process A is actively migrating, process B repeatedly calls:

```
getMigrationStatus()
```

or equivalent public metadata inspection.

Expected:

```
coherent status
no raw SQLITE_BUSY / ERR_SQLITE_ERROR
```

Depending on timing, status may show:

```
in-progress
checkpointed
idle/completed
```

but host inspection must remain usable.

---

# 33. STARTUP-GATE CONTENTION TEST

While a migration process holds or updates SQLite migration metadata, start another authority against the same database.

Expected semantic outcome:

```
MIGRATION_IN_PROGRESS
```

or, if migration completed before observation:

```
compatible / appropriate newer-schema result
```

Forbidden:

```
raw SQLite lock exception
```

---

# 34. REQUEST-TIME CONTENTION TEST

For an already-running authority that shares the migration metadata database, race a migration owner against a normal request.

Expected:

```
MIGRATION_IN_PROGRESS
```

when migration ownership is active.

Do not regress the 0.11.1 serving refusal.

---

# 35. OWNED-LOCK UNRELATED CONTENTION TEST

Create the opposite case:

```
current process validly owns migration lease
unrelated SQLite writer holds a physical database lock
```

Verify the provider does NOT falsely claim:

```
another migration is in progress
```

merely because SQLite is busy.

Expected after bounded retry:

```
MIGRATION_FAILED
```

or an equivalent provider failure with meaningful cause.

This proves the implementation did not simply map every SQLite contention error to `MIGRATION_IN_PROGRESS`.

---

# 36. SQLITE JOURNAL MODE

Do not change SQLite journal mode casually as part of this patch.

If WAL or another setting is considered necessary:

```
research it
test it
document compatibility implications
```

Prefer the smallest lock-handling fix that preserves existing provider behaviour.

Do not turn 0.11.2 into a SQLite storage redesign.

---

# 37. TRANSACTION SEMANTICS

Do not weaken:

```
BEGIN IMMEDIATE
```

or existing transaction boundaries merely to make tests pass.

The migration writer still needs reliable write ownership.

Solve contention at the adapter/semantic boundary, not by making writes less safe.

---

# 38. CROSS-PLATFORM CONSIDERATION

Where CI permits, test the SQLite contention logic on more than one supported OS.

At minimum ensure the error recognizer does not depend on:

```
filesystem-specific paths
localized text
one exact stack trace
```

Structured SQLite error fields are preferred.

---

# 39. FINGERPRINT STABILITY

0.11.2 must not change:

```
schemaFingerprint
```

for any existing graph.

Required:

```
fingerprint_0_11_0(X)
  ==
fingerprint_0_11_1(X)
  ==
fingerprint_0_11_2(X)
```

for representative A/B/C/D migration graphs.

---

# 40. SERVER IR STABILITY

Expected:

```
migration graphs remain axiom.server.v7
```

Do not introduce:

```
axiom.server.v8
```

for SQLite adapter contention handling.

Frozen v1–v6 remain byte-identical.

v7 may change release/version metadata only if existing release tooling requires it.

---

# 41. CONFORMANCE STABILITY

Keep:

```
axiom.conformance.v5
```

No portable semantic fixture format change is required.

Provider contention is implementation/concurrency behaviour, not a new semantic migration vocabulary.

---

# 42. OPERATION SEMANTICS STABILITY

Do not modify:

```
MigrationDef
migration operation kinds
transform semantics
destructive classification
approveDestructive semantics
migrationPath
migrationImpact
schema gate meanings
MigrationPrincipal semantics
```

except for code mechanically touched by contention handling.

---

# 43. D-1 REGRESSION

Re-run opaque-authority tests.

Every forged/copied capability remains:

```
MIGRATION_NOT_AUTHORIZED
```

No regression.

---

# 44. D-2 REGRESSION

Re-run startup-gate hardening tests:

```
unversioned graph + versioned persistence
    → SCHEMA_IDENTITY_REQUIRED

schema-evolving graph without metadata
    → SCHEMA_METADATA_REQUIRED

old graph against new persistence
    → SCHEMA_INCOMPATIBLE

new graph against old persistence
    → SCHEMA_MIGRATION_REQUIRED
```

No regression.

---

# 45. D-3 REGRESSION

Re-run AgentAPI coverage tests:

```
migrationImpact(B,C).covered === true
coverageMode === 'step'

migrationImpact(A,D)
    → coverageMode === 'chain'
```

No unexplained `covered:false`.

---

# 46. DESTRUCTIVE SAFETY REGRESSION

Verify:

```
destructive migration without approval
    → MIGRATION_APPROVAL_REQUIRED
    → zero destructive writes
    → version unchanged
```

Concurrency changes must not weaken this.

---

# 47. CRASH/RESUME REGRESSION

Verify:

```
checkpoint
process crash
lease expiry
resume
exact uninterrupted final result
rerun alreadyAtTarget
```

Memory and SQLite.

---

# 48. LARGE-DATA REGRESSION

Retain bounded batching.

At minimum:

```
20,000 rows
batchSize 500
```

Prefer retaining the internal 500k/2M benchmark.

The new SQLite contention handling must not accidentally materialize or serialize whole datasets.

---

# 49. PERFORMANCE BOUND

Measure whether the contention fix materially slows uncontended migrations.

Uncontended migration should not incur large retry delays.

Record before/after for:

```
metadata operations
small migration
batched migration
```

Do not optimize prematurely, but ensure the new busy handling is near-zero cost when there is no contention.

---

# 50. PUBLISH ORDERING INVESTIGATION

The external test also observed a transient install failure because:

```
@cynodia/axiom
```

became visible before:

```
@cynodia/axiom-agent-api@0.11.1-alpha.1
```

had propagated.

Investigate release publication ordering.

This is secondary and MUST NOT distract from D-4.

Preferred release order:

```
leaf/internal dependency packages first
facade package last
```

If the current release process already intends this, verify it.

Do not claim npm registry publication is atomic.

---

# 51. PUBLISH-ORDER SMOKE TEST

Where practical, after publishing prerelease packages:

```
immediately install facade + server in a fresh directory
```

Verify all exact inter-package versions resolve.

If registry propagation makes immediate install inherently nondeterministic, document it rather than building unsafe retry logic into package semantics.

---

# 52. DOCUMENTATION

Update `docs/MIGRATIONS.md` only as needed.

Document the normative concurrency behaviour:

Concurrent migrator:

```
completed
MIGRATION_IN_PROGRESS
or alreadyAtTarget
```

Consumers should not need to catch SQLite-native lock errors during ordinary migration races.

Do not teach consumers to implement their own busy retry loop around `executeMigration`.

That is provider responsibility.

---

# 53. SQLITE PROVIDER DOCS

If a `busyTimeoutMs` option is introduced, document:

```
default
valid range
what it controls
what it does NOT guarantee
```

Clarify that it is physical contention tuning, not migration ownership configuration.

If no public option is added, state the provider handles ordinary contention internally.

---

# 54. DIAGNOSTIC TEST

Add a direct regression ensuring a competing SQLite migrator receives:

```
MIGRATION_IN_PROGRESS
```

rather than:

```
MIGRATION_FAILED
```

when another live Axiom migration owner can be observed.

Also assert no nested provider error leaks through as the primary semantic diagnostic.

---

# 55. PERMANENT D-4 TEST

Add a named permanent regression such as:

```
D-4: two OS processes racing executeMigration on SQLite
     never leak SQLITE_BUSY and never execute the transition twice
```

The test must use real OS processes and a shared SQLite database.

Do not replace it with an in-process approximation later.

---

# 56. IMPLEMENTATION REPORT

Produce:

```
reports/AXIOM_0_11_2_IMPLEMENTATION_REPORT.md
```

Answer at minimum:

1. How was D-4 reproduced?
2. At which SQLite operations could contention leak?
3. How does node:sqlite expose SQLITE_BUSY / SQLITE_LOCKED?
4. What contention detection helper was implemented?
5. Is a SQLite busy timeout used?
6. What timeout/retry policy was selected and why?
7. Is retry bounded?
8. How is known migration ownership distinguished from unrelated contention?
9. When is MIGRATION_IN_PROGRESS returned?
10. When is alreadyAtTarget returned?
11. When is MIGRATION_FAILED still correct?
12. Can getMigrationStatus leak SQLITE_BUSY?
13. Can schemaGate/start leak SQLITE_BUSY under normal migration contention?
14. Can request-time migration checks leak SQLITE_BUSY?
15. Can checkpoint reads/writes leak contention?
16. Can lease renewal leak contention?
17. Did two processes ever both acquire migration ownership?
18. Did any row double-transform?
19. Did any trial produce duplicate history?
20. Did any trial advance schema version prematurely?
21. How many repeated cross-process race trials were run?
22. What were all observed process-result pairs?
23. Did crash/reclaim still work?
24. Did unrelated physical contention incorrectly map to MIGRATION_IN_PROGRESS?
25. Was public SQLite configuration changed?
26. Did fingerprints remain unchanged?
27. Did Server IR remain v7?
28. Did conformance remain v5?
29. Did D-1 remain fixed?
30. Did D-2 remain fixed?
31. Did D-3 remain fixed?
32. Did destructive approval regress?
33. Did bounded batching regress?
34. How many tests pass?
35. Did release:prepare pass?
36. Was publish ordering changed or verified?
37. What did the external 0.11.2 regression classify as D/E/S?
38. Are any known migration safety gaps left?

---

# 57. RELEASE CLASSIFICATION

Choose exactly one:

A — SQLITE CONTENTION HARDENED

```
D-4 corrected.
Cross-process SQLite migration races produce only semantic Axiom outcomes.
No duplicate execution.
No semantic regressions.
External result D1 + E1 + S1.
```

B — HARDENED WITH MINOR LIMITATION

```
Raw SQLite lock leakage corrected, but a non-critical provider ergonomics issue remains.
```

C — CONTENTION CONTRACT STILL BROKEN

```
Ordinary cross-process migration contention can still leak provider-native errors
or generic failure despite a valid competing migration owner.
```

D — REGRESSION

```
Data integrity, crash recovery, migration safety, authority, schema gate,
coverage or portability regressed.
```

Target:

```
A
```

---

# 58. EXTERNAL REGRESSION TEST

After packaging/publishing `0.11.2-alpha.1`, perform a cold external regression against the real npm packages.

At minimum:

```
install published package
docs discovery sanity check
D-1
D-2
D-3
D-4 50× cross-process SQLite race
crash/resume SQLite
destructive approval
serving during migration
fingerprint comparison
```

No repository access.

No implementation-source reading.

---

# 59. REQUIRED D-4 EXTERNAL RESULT

Across at least 50 fresh-database trials:

Allowed loser results:

```
MIGRATION_IN_PROGRESS
alreadyAtTarget
```

Forbidden:

```
SQLITE_BUSY
SQLITE_LOCKED
ERR_SQLITE_ERROR
uncaught exception
contention-only MIGRATION_FAILED
```

Required final state every trial:

```
correct target rows
exactly one semantic transformation
one history entry
target schema version
no active lock
no stale checkpoint
```

---

# 60. FINAL TARGET

External classifications:

```
Discoverability: D1
Semantic escape: E1
Safety: S1
```

Zero metrics:

```
raw SQLite contention leakage ........ 0
duplicate transformation ............. 0
duplicate migration history .......... 0
false schema-version commit .......... 0
D-1 regressions ....................... 0
D-2 regressions ....................... 0
D-3 regressions ....................... 0
S3 defects ............................ 0
S4 defects ............................ 0
```

---

# 61. FINAL PRINCIPLE

Axiom already has a semantic concurrency model:

```
one migration owner
competing runners do not execute the same transition
```

SQLite also has a physical concurrency model:

```
database file locks
SQLITE_BUSY
SQLITE_LOCKED
```

The provider's job is to reconcile the second with the first.

Application authors and AI agents should reason about:

```
migration ownership
migration progress
migration completion
```

not:

```
SQLite lock codes.
```

0.11.2 is complete when ordinary SQLite process contention no longer escapes the provider abstraction and every migration race resolves to a correct Axiom semantic state.
