# XRT-1 Closure — Independent Runtime Conversion Conformance

*Maintainer artifact. Not shipped.* Candidate: `1.0.0-rc.1`.

## XRT-1 CLOSURE

**Finding:** `XRT-1` — the independent Python runtime `axiom_indep` diverged from the frozen
Axiom 0.17 / 1.0 portable conversion contract on two cases (campaign class `R2` =
independent-runtime defect; = `R1` under the spec17 §86 letter, same substance). Severity
MEDIUM. Reference `1.0.0-rc.1` runtime was already correct; the contract
(`docs/EXPRESSIONS.md#conversions`, shipped in the `@cynodia/axiom` tarball) was already
exact.

### Changes

- **Repo:** `axiom-tests/test17/independent-runtime/` (the independent runtime workspace).
  **Reference repo: 0 changes.**
- **`axiom_indep/values.py`**
  - `import re`; new module constant `_CANONICAL_DECIMAL` — the portable numeric-text
    grammar as a regex (`[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\Z`).
  - `_js_number_to_string()` reimplemented: instead of returning Python's `repr()` for
    non-integer floats, it now applies the **ECMAScript `Number::toString` radix-10**
    case analysis (fixed notation for `1e-6 ≤ |x| < 1e21` and `0`; exponential otherwise
    with no leading zero in the exponent and an explicit `+`/`-`). `repr()` is used only to
    obtain the shortest round-tripping significant digits, which are then re-derived to
    `(s, pos)` and reformatted. `-0.0 → "0"`, `NaN`/`Infinity`/`-Infinity` unchanged.
  - `to_number()` string branch: the trimmed string is matched against
    `_CANONICAL_DECIMAL` **before** `float()` is ever called. Radix-prefixed forms
    (`0x`/`0o`/`0b`) and exact-case `Infinity`/`+Infinity`/`-Infinity` keep their explicit
    handling; every other lexical form — digit separators (`"1_000"`), thousands commas,
    `"inf"`/`"nan"`/`"infinity"` (which host `float()` accepts), trailing junk, a lone `.`,
    `"1e"` — now yields `NaN`.
- **New `axiom-tests/test17/independent-runtime/conversion_regression.py`** — a standalone
  guard (matches the workspace's script style): 26 number→text + 35 text→number assertions
  spanning both XRT-1 targets and the surrounding class. `exit 0` = all conform.

- **Semantic areas touched:** value conversions only — `to_text` number→text path and
  `to_number` string→number path. No engine / expression / authorization / workflow /
  distributed / admission code touched. The fix is **rule-based** (the whole exponent-format
  and grammar-validation class), not a special-case for `1e-7` / `"1_000"`.
- **Independence preserved:** implemented from `docs/EXPRESSIONS.md#conversions` and the
  ECMAScript algorithm it restates. No reference execution source was read or translated.

### Targeted cases

| case | required | result |
| --- | --- | --- |
| `1e-7` → text | `"1e-7"` | **PASS** (was `"1e-07"`) |
| `"1_000"` → number | `NaN` | **PASS** (was `1000`) |

Nearby-edge class (`conversion_regression.py`, 61 assertions): **61/61 conform**. Includes
`1e-8`, `1e-6` (→ `"0.000001"`, fixed), `1e20` (→ fixed), `1e21` (→ `"1e+21"`), `-1e-7`,
`1.5e-7`, `1.5e20`, `1.5e300`, and `"1_0"`, `"1,000"`, `"inf"`, `"infinity"`, `"nan"`,
`"1e"`, `"5%"`, `"1 000"` → all `NaN`.

### Conversion fixtures (cross-runtime differential, `test-rc1/xruntime/differential.mjs`)

| fixture | result |
| --- | --- |
| `conversion-number-to-text` | **MATCH** (ref P, indep P) |
| `conversion-text-to-number` | **MATCH** (ref P, indep P) |

### Full independent differential

`test-rc1/xruntime/differential.mjs` over the shipped `@cynodia/axiom-server@1.0.0-rc.1`
conformance corpus + `test17/corpus` probes (base / query / workflow / authorization):

```
before XRT-1 fix:  MATCH 118   R1? 2   H1 2   C1 1
after  XRT-1 fix:  MATCH 120   R1  0   R2 0   H1 2   C1 1
```

- **MATCH count:** 120 (up from 118 — the two conversion fixtures). No previously-MATCH
  fixture regressed.
- **R1:** 0  **R2:** 0  **S1/S2:** 0 — no new semantic divergence introduced.
- **H1 ×2** (`probe-malformed-action-failclosed`, `probe-serverir-guards-enforced`):
  pre-existing and **unchanged** — both runtimes refuse identically with the same code; the
  harness labels H1 only because the reference *runner* surfaces the refusal as a thrown
  exception. Not a regression, not in XRT-1 scope.
- **C1 ×1** (`probe-native-operation-unsupported`): unchanged — `NativeOperation` is the
  deliberate non-portable boundary; `axiom_indep` correctly refuses it.

### Distributed four-way

`test-rc1/xruntime/coord-differential.mjs` (coordination axis, reference-1/-N vs
independent-1/-N): **24/24 MATCH**, `R1 = 0`, `R2 = 0`, `crash = 0` (5 N1 unchanged — both
runtimes decline the same engine-level multi-authority probes identically). XRT-1 touched no
distributed code; result is unchanged from before the fix.

### Independent baseline sanity

| gate | result |
| --- | --- |
| `selfcheck.py` (all groups, vs rc.1 conformance) | `pass=131  fail=0  crash=0` |
| `selfcheck.py` (all groups, vs 0.16 conformance) | `pass=128  fail=0  crash=0` |
| `totality_check.py` | `totality: OK` — 0 native crashes |
| `conversion_regression.py` | `61/61 conform`, exit 0 |
| portable differential (base/query/workflow/authz) | `MATCH 120`, 0 R1/R2 |
| coordination / four-way | `24/24 MATCH`, 0 R1/R2/crash |

### Source / reference changes

```
reference runtime semantic-source changes: 0
reference RC rebuild required because of XRT-1: NO
Axiom public contract changes: 0
conformance expectation / fixture / normalizer changes: 0
```

Verified: `git status` in the reference repo shows **0 modified tracked files** and no
`packages/*/src` change; the XRT-1 fix is entirely within `axiom-tests/test17/independent-runtime/`.

### Final disposition

```
XRT-1
  original: R2 MEDIUM (independent Python runtime diverges from the frozen conversion grammar)
  final:    RESOLVED — INDEPENDENT RUNTIME DEFECT FIXED
```

Both mismatches disappeared with an **independent-runtime-only** fix. This does not reopen
the 0.17 semantic freeze, Track A, Track B, or the 1.0 RC reference validation. Implementing
the documented rules exposed **no** contract contradiction or insufficiency — the grammar
and the `Number::toString` reformat were already fully specified in
`docs/EXPRESSIONS.md#conversions` (SEM-1, 0.17 pre-freeze), so there is **no S1/S2** to
reclassify.

### Release impact

- The "clean four-way cross-runtime MATCH" claim for `1.0.0-rc.1` is now **unqualified**:
  `R1 = 0`, `R2 = 0`, blocking `S1/S2 = 0`, base-axis `MATCH 120`, distributed `24/24 MATCH`.
- **XRT-1 is no longer a release blocker.**
- Remaining before `1.0.0` publication (unchanged by this closure): build the final
  `1.0.0` tarballs, `npm run release:verify`, `npm run release:consumer-test`, the
  tarball/provenance audit — then publish if clean. No new broad validation campaign is
  required.

## Acceptance criteria

```
[x] 1e-7 formats as "1e-7"
[x] "1_000" evaluates as NaN
[x] fixes are rule-based, not one-off special cases
[x] public contract unchanged
[x] reference runtime unchanged
[x] targeted conversion fixtures MATCH (conversion-number-to-text, conversion-text-to-number)
[x] full independent differential has R2 = 0 (and R1 = 0)
[x] no new R1/S1/S2 introduced
[x] distributed four-way regression MATCH (24/24)
[x] independent baseline remains clean (selfcheck 131/0/0, totality OK)
[x] no native crashes introduced
```

## Verdict

```
XRT-1: RESOLVED — INDEPENDENT RUNTIME CONFORMS

R1 = 0
R2 = 0
blocking S1/S2 = 0
cross-runtime = MATCH
four-way distributed = MATCH

XRT-1 is no longer a release blocker.
Axiom 1.0.0 may proceed to final packed-artifact verification.
```
