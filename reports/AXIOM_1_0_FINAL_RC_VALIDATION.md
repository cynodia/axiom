# Axiom 1.0 — Final RC Validation

**Target:** `1.0.0` **Candidate under test:** `1.0.0-rc.1`
**Baseline:** `AXIOM 0.17 SEMANTIC CONTRACT: FROZEN`
**git:** `ea173f51d90cd5c0c1623d7f90d141d421028865` ("1.0!!!"), tree clean
**Build:** Node 24.19.0 / npm 11.17.0 / TypeScript 5.9.3 · also validated on Node 22.23.2

This pass added **no** capability, vocabulary or semantic reinterpretation. It changed no
`packages/*/src`. The RC tarballs were rebuilt from the recorded commit and were
**byte‑identical** to the originals (all 8 `sha256`).

---

## Verdict

> **AXIOM 1.0 FINAL RC VALIDATION: PASS WITH NON‑BLOCKING FINDINGS**
> **AXIOM 1.0.0: READY FOR RELEASE**
>
> — conditional on the maintainer accepting the **XRT‑1** disposition (below): the two
> cross‑runtime mismatches are defects in the *independent Python runtime* against a
> contract the reference `1.0.0-rc.1` artifacts implement correctly and which is documented
> exactly in the shipped `docs/EXPRESSIONS.md`. They do not impugn the 1.0 artifacts or the
> frozen contract, and no `rc.2` is implicated. **If release policy enforces spec §28
> `R2 = 0` absolutely, the status is `BLOCKED` pending an `axiom_indep` conversion‑grammar
> fix + a four‑way re‑run** — a change to the independent runtime, not to Axiom 1.0.

### Governing invariants

| invariant | result |
| --- | --- |
| `semanticContractChanged == false` | **holds** — no `src` change; `axiom.server.v9`, `axiom.authz.v3`, `SEMANTIC_FINGERPRINT_VERSION == 1` all unchanged from 0.17 |
| `portableMeaning(1.0.0-rc.1) == portableMeaning(0.17 frozen)` | **holds** — identical fingerprints; 46/46 root conformance; 0.17→1.0 delta is version strings only |
| `release artifact behavior == validated behavior` | **holds** — all final validation ran against the packed tarballs (reproducible build) |

---

## Gate results

| # | Gate | Report | Result |
| --- | --- | --- | --- |
| §3 | packed RC artifact manifest | `1.0-rc-artifact-manifest.json` | PASS |
| §4 | per‑symbol public API classification | `1.0-api-stability.md` + `1.0-api-symbol-classification.json` | COMPLETE; accidental exports adjudicated (**API‑1**, MEDIUM, non‑blocking) |
| §5 | deep‑import audit | `1.0-release-artifact-validation.md` | PASS — **0** required deep imports |
| §6 | five clean consumer projects | `1.0-consumer-project-validation.md` | PASS — **5/5** on Node 22 + 24 |
| §7 | installation matrix | `1.0-installation-matrix.md` | PASS — Node 22.23.2 / 24.19.0 (23.3.0 smoke); npm only |
| §8 | tarball audit | `1.0-release-artifact-validation.md` | PASS — **0** release blockers; no secrets, no `workspace:`/`file:`, no private source |
| §9 | provenance / reproducibility | `1.0-provenance.md` | PASS — 8/8 tarball `sha256` byte‑identical on rebuild |
| §10 | authorization security campaign | `1.0-security-audit.md` | PASS — 47 hostile requests + 114 corpus tests @ 100× trials; **0** unauthorized, **0** fail‑open |
| §11 | principal preservation | `1.0-security-audit.md` | PASS — **0** confusion / escalation |
| §12 | cursor security | `1.0-security-audit.md` | PASS — **0** cursor‑as‑bearer leaks (principal‑bound, HMAC‑sealed) |
| §13 | secret leakage audit | `1.0-security-audit.md` | PASS — **0** secret / credential leaks in any `handle()` / CLI output |
| §14 | totality fuzz | `1.0-totality-fuzz.md` | PASS — **0** native crashes / hangs at every wire‑reachable untrusted boundary (25 200 supplementary cases + repo's 1 200‑variant seeded suite). **TOT‑1** (LOW): in‑process‑only `snapshot.sinceRevision` `TypeError`, not wire‑reachable |
| §15 | totality soak | `1.0-totality-fuzz.md` | PASS — no state / handle / listener leak, no cross‑request contamination |
| §16 | provider failure injection | `1.0-provider-failure-injection.md` | PASS — **0** partial semantic commit, **0** native escape |
| §17 | transaction failure matrix | `1.0-provider-failure-injection.md` | PASS — **0** partial commit, **0** unauthorized mutation |
| §18‑19 | SIGKILL / durable workflow | `1.0-durability-crash-validation.md` | PASS — 120‑trial SIGKILL‑after‑commit *exactly once*; lost/duplicate work **0** |
| §20 | effect acceptance | `1.0-durability-crash-validation.md` | PASS — duplicate / lost logical effects **0** |
| §21 | event acceptance | `1.0-durability-crash-validation.md` | PASS — `(source,externalEventId)` dedup; unknown `eventId` refused, **0** side effects |
| §22 | migration crash / recovery | `1.0-durability-crash-validation.md` | PASS — double‑applied / corrupt / lost‑checkpoint / invalid‑target **0** |
| §23‑25 | distributed authority soak / logical‑work | `1.0-distributed-soak.md` | PASS — duplicate / lost durable work **0** at 8 authorities, elevated race counts |
| §24 | fencing acceptance | `1.0-distributed-soak.md` | PASS — **stale fenced commits = 0** |
| §26 | revision / cache coherence | `1.0-distributed-soak.md` | PASS — staleness‑bound‑0 preserved |
| §27 | live‑query distributed regression | `1.0-distributed-soak.md` | PASS — **0** unauthorized live observations |
| §28 | independent Python runtime regression | `1.0-independent-runtime-regression.md` | R1 **0** · S1/S2 **0** · **R2 2 (XRT‑1)** — 118 MATCH; adjudicated (see Verdict) |
| §29 | four‑way distributed regression | `1.0-distributed-soak.md` | **MATCH** on the coordination axis (24/24); base axis carries XRT‑1 |
| §30 | NativeOperation boundary | `1.0-independent-runtime-regression.md` | reconfirmed nonportable; independent runtime refuses it; not a mismatch |
| §31‑32 | performance baseline / pathology | `1.0-performance-baseline.md` | RECORDED; no blocking pathology (**PERF‑1**, LOW: in‑memory adapter linear log growth) |
| §33 | resource / leak soak | `1.0-performance-baseline.md` | PASS — no unbounded leak over 2 400 authority cycles |
| §34 | compatibility / fingerprint regression | `1.0-upgrade-validation.md` | PASS — presentation‑only COMPATIBLE, semantic changes INCOMPATIBLE; `v9`/`v3`/FP‑1 unchanged |
| §35 | 0.17 → 1.0 upgrade | `1.0-upgrade-validation.md` | PASS — **no semantic migration**; delta is version strings only |
| §36 | diagnostics audit | this report §Diagnostics | PASS — 4‑class taxonomy shipped; unknown‑`eventId` code `IMPLEMENTATION_DEFINED`, refusal semantic |
| §37 | CLI final validation | this report §CLI | PASS — exit codes, `--json` shape, determinism, secret cleanliness (**CLI‑1**, LOW) |
| §38 | conformance distribution | `1.0-consumer-project-validation.md` (c5) | PASS — 46/46 from `@cynodia/axiom-server` alone, no monorepo (**CONF‑1**, INFO) |
| §39‑41 | documentation / release notes / known limitations | this report §Docs + `docs/COMPATIBILITY.md` | PASS — normative map + SemVer + limitations shipped and discoverable |

---

## §36 Diagnostics audit

`docs/COMPATIBILITY.md` (shipped) carries the complete taxonomy —
`STABLE_MACHINE_CODE` / `STABLE_CATEGORY` / `IMPLEMENTATION_DEFINED` / `DEBUG_ONLY` —
and explicitly places *"the code for an unknown `eventId`"* in `IMPLEMENTATION_DEFINED`
while the refusal itself is semantic (the frozen 0.17 SEM‑2 decision). `VALIDATION_CODES`,
`RUNTIME_DIAGNOSTIC_CODES`, `SERVER_IR_*`, `AUTHORIZATION_DENIED`, `CONCURRENCY_CONFLICT`,
migration / coordination codes are `STABLE_MACHINE_CODE`. "A native host‑language exception
is never the machine contract at a boundary that accepts untrusted serialized input" is
stated normatively and was verified (§14). No exact code is promised where only the
semantic outcome is normative.

## §37 CLI final validation (from the packed `@cynodia/axiom-cli` tarball)

`validate` ok → exit 0; invalid graph → exit 1 + `{valid:false, errors:[{code,message,nodeId}]}`;
missing file / bad export → exit 1 + `{ok:false, error:{code:"MODEL_LOAD_FAILED"}}`;
`analyze --json` deterministic across runs; `explain --json` structured. No secrets or host
paths in machine output except the deliberate `MODEL_LOAD_FAILED` message echoing the
user‑supplied path (**CLI‑1**, LOW/INFO).

## §39‑41 Documentation, release notes, known limitations

A cold reader of `@cynodia/axiom@1.0.0-rc.1` alone is routed to `docs/AGENT_REFERENCE.md`
by all 3 root entry points; every referenced document resolves inside the tarball
(`release:probe`). `docs/COMPATIBILITY.md` (NORMATIVE) states: 1.0 == frozen 0.17; the
authoritative‑information table (what is normative); the portable profile; Server IR /
authz markers; the `NativeOperation` boundary; `axiom.conformance.1.0`; the SemVer /
patch‑minor‑major policy; semantic‑bug handling; the 0.17→1.0 upgrade statement; and
**Known 1.0 limitations** — `NativeOperation` nonportability, physical effect at‑least‑once,
provider‑internal operational behaviour, retention/cleanup as a host responsibility,
unsupported‑capability refusal. Draft release notes: this report's companion
`AXIOM_1_0_RELEASE_NOTES_DRAFT.md`.

---

## Findings (full ledger: `1.0-findings.md`)

| id | class · sev | one‑line | blocking |
| --- | --- | --- | --- |
| XRT‑1 | R2 · MEDIUM | `axiom_indep` fails 2 conversion fixtures the reference passes (`1e-7`→`1e-07`; `"1_000"`→1000 vs `NaN`); independent‑runtime defect vs a correct, shipped contract; pre‑existing at 0.17 freeze | no (see Verdict); qualifies "four‑way MATCH" |
| API‑1 | API · MEDIUM | uncurated `export *` surface; ~228 undocumented internal helpers at package roots; no `@internal` boundary | no — additive‑safe; recommend curation in 1.0.x |
| PKG‑1 | PKG · MEDIUM | `engines` undeclared | **RESOLVED** (RC‑prep) |
| TOT‑1 | SEC/OPS · LOW | `handle(snapshot)` native `TypeError` on a hostile `sinceRevision`; not wire‑reachable; read‑only | no |
| PERF‑1 | PERF · LOW | in‑memory persistence per‑commit latency grows ~linearly (not O(n²)); dev/test adapter | no |
| CLI‑1 | D1 · LOW | `MODEL_LOAD_FAILED --json` echoes an absolute path (user‑supplied; no secret) | no |
| H1‑1 | H1 · INFO | `run*ConformanceFixture` lack a defensive arg guard (not an untrusted boundary) | no |
| CONF‑1 | D1 · INFO | `axiom.conformance.1.0` in prose but not a manifest key | no |

**CRITICAL: 0 · HIGH: 0 · authorization fail‑open: 0 · principal confusion/escalation: 0 ·
durable corruption: 0 · lost/duplicate logical work: 0 · stale fenced commits: 0 · broken
0.17→1.0 upgrade: no · broken documented public API: no · required deep import: 0 · broken
packed artifact: no · release tarball failing conformance: no · native crash at a
wire‑reachable untrusted boundary: 0.**

---

## Final checklist (spec §48)

```
[x] frozen 0.17 semantics unchanged
[x] per-symbol public API audit complete
[x] accidental exports resolved (adjudicated: accepted public, API-1)
[x] no required deep imports
[x] 5 clean consumer projects pass
[x] installation matrix passes
[x] tarball audit passes
[x] provenance recorded (byte-reproducible)
[x] dedicated authorization security campaign passes
[x] principal propagation campaign passes
[x] cursor security passes
[x] secret leakage audit passes
[x] totality fuzz passes
[x] totality soak passes
[x] provider failure injection passes
[x] transaction failure matrix passes
[x] SIGKILL campaign passes
[x] workflow durability passes
[x] effects durability passes
[x] events/dedup passes
[x] migration recovery passes
[x] distributed soak passes
[x] stale fenced commits == 0
[x] lost logical work == 0
[x] duplicate logical work == 0
[x] live-query distributed regression passes
[~] independent Python regression MATCH — 118 MATCH; 2 R2 (XRT-1), adjudicated as an
    independent-runtime defect vs a correct+shipped contract (see Verdict)
[x] four-way distributed regression MATCH (coordination axis, 24/24)
[x] performance baseline recorded
[x] no blocking performance pathology
[x] resource/leak soak passes
[x] compatibility/fingerprint regression passes
[x] 0.17 -> 1.0 upgrade passes
[x] diagnostics audit complete
[x] CLI validation passes
[x] conformance distributable externally
[x] final documentation audit passes
[x] release notes prepared (AXIOM_1_0_RELEASE_NOTES_DRAFT.md)
[x] known limitations documented (docs/COMPATIBILITY.md)
[x] CRITICAL security findings == 0
[x] HIGH security findings == 0
[x] remaining release blockers == 0  (subject to the XRT-1 adjudication)
```

## §51 Final question

> If the repository disappeared immediately after publication, would the packed Axiom 1.0
> artifacts, public documentation, public types/schemas, Server IR, provider contracts, and
> conformance suite be sufficient for application authors, provider authors, tooling
> authors, and independent runtime implementers to use and implement the platform according
> to its frozen contract?

**Yes.** The five consumer projects (application author, server runtime, provider author,
AgentAPI tooling, conformance runner) each build and run from the tarballs alone; the
conformance corpus + runner install from `@cynodia/axiom-server` with no monorepo; a cold
agent is routed to the full contract from the package root; and XRT‑1 is itself the proof
that the shipped `docs/EXPRESSIONS.md` is precise enough for an independent implementer to
be held to it exactly.

**AXIOM 1.0.0: READY FOR RELEASE** (with the XRT‑1 adjudication recorded).
